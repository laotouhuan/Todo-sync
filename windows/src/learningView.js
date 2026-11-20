import { seriesFor, timingPendingReason, displayTaskName, duplicateTimingSeries, periodDescription, isSeriesDeleted } from './taskSeries.js';
import { editorProgressSections } from './editorSections.js';
import { learningSnapshot, requirePersonalTarget } from './collaborationView.js';
import { normalizeLabel, taskReference, sameTask, learningRange, summarizeLearning, formatDuration, validateTimeEntry, localDay, availableLabels, resolveLearningEntries, finishTimeEntry, SHORT_TIME_ENTRY_MESSAGE, canTimeTodo, lastTimedText, recentTimingTasks, recordTaskChoices, createRunningTimeEntry, timingTodos, splitTimeEntry } from './timeTracking.js';
import { sortFunc } from './dateUtils.js';
import { reviewFields, reviewPreview, exportReviews } from './reviewUtils.js';
import { canonicalJson } from './stableJsonDigest.js';

// 所有用户文字均通过 textContent/value 写入，计时刷新只更新文本。
function el(tag, text, className) {
    const node = document.createElement(tag); if (text != null) node.textContent = text;
    if (className) node.className = className; return node;
}
function button(text, action, variant) {
    const b = el('button', text, 'ui-button'); b.type = 'button';
    if (variant) b.classList.add(variant);
    b.onclick = async e => { e.stopPropagation(); if (!b.isConnected) return; b.disabled = true; try { await action(); } finally { b.disabled = false; } }; return b;
}
function input(type, value, caption, host) {
    const label = el('label', caption); const node = el('input'); node.type = type; node.value = value || '';
    label.append(node); host.append(label); return node;
}
function modal(title) {
    const dialog = el('dialog', null, 'learning-dialog'); dialog.append(el('h3', title));
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => dialog.remove()); return dialog;
}
function localInput(iso) {
    if (!iso) return ''; const date = new Date(iso);
    return localDay(date) + 'T' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function clippedText(host, content, lines) {
    const text = el('p', content, 'learning-text insight-clipped');
    text.style.setProperty('--insight-lines', lines);
    const expand = button('展开', () => {
        const expanded = text.classList.toggle('insight-expanded');
        expand.textContent = expanded ? '收起' : '展开';
        expand.setAttribute('aria-expanded', String(expanded));
    });
    expand.hidden = true;
    expand.setAttribute('aria-expanded', 'false');
    host.append(text, expand);
    requestAnimationFrame(() => { expand.hidden = text.scrollHeight <= text.clientHeight + 1; });
}

export function createLearningView({ state, commit: commitPersonal, redraw, sync, toast, exportFile, periods, planning, openWeek }) {
    const readOnly = () => state.activeSource.type === 'collaboration';
    const enabled = () => readOnly() || state.appConfig.time_tracking_enabled !== false;
    const commit = change => { requirePersonalTarget(state.activeSource); return commitPersonal(change); };
    const conflicts = () => learningSnapshot(state).conflicts;
    const requireEnabled = () => { if (state.appConfig.time_tracking_enabled === false) throw new Error('本机任务计时已关闭'); };
    const data = () => learningSnapshot(state).data;
    const entries = () => data().time_entries || [];
    const knownTasks = () => learningSnapshot(state).tasks;
    const resolvedEntries = () => resolveLearningEntries(entries(), knownTasks(), { data: data(), source: state.activeSource });
    const pendingReason = entry => resolvedEntries().find(e => e.id === entry.id)?.pending_reason || '';
    const entryLabel = entry => resolvedEntries().find(e => e.id === entry.id)?.label_snapshot || '未分类';
    const running = () => entries().filter(e => !e.deleted && e.ended_at == null);
    let labelFilter, banner, lastConflict = '', reviewLeave, refreshLabelPicker, refreshTimerPicker, timer, stopReviewUpdates;
    let lastSource = JSON.stringify(state.activeSource);
    const run = async action => { try { await action(); } catch (e) { toast(e.message || String(e)); } };
    function clock(entry) {
        const node = el('span', '', 'learning-clock'); node.dataset.started = entry.started_at; return node;
    }
    function tick() {
        if (!enabled()) return;
        document.querySelectorAll('[data-started]').forEach(node => {
            node.textContent = formatDuration(Date.now() - Date.parse(node.dataset.started), true);
        });
    }
    async function stop(id) {
        let discarded = 0;
        await commit(d => {
            requireEnabled();
            d.time_entries = d.time_entries.map(entry => {
                if (entry.id !== id || entry.deleted || entry.ended_at != null) return entry;
                if (timingPendingReason(d, entry)) throw new Error('请先核对实际结束时间');
                const finished = finishTimeEntry(entry, new Date().toISOString());
                if (finished.deleted) discarded++;
                return finished;
            });
        });
        showShortTimerNotice(discarded);
    }
    function showShortTimerNotice(count) {
        if (!count) return;
        const dialog = modal('计时过短');
        dialog.append(el('p', count === 1 ? SHORT_TIME_ENTRY_MESSAGE : `${count} 条计时未超过 30 秒，不保存为记录。`),
            button('知道了', () => dialog.close()));
    }
    async function remove(entry) {
        await commit(d => { requireEnabled(); const e = d.time_entries.find(x => x.id === entry.id); if (e) { e.deleted = true; e.updated_at = new Date().toISOString(); } });
    }
    function attachTimer(row, todo) {
        if (todo.deleted || !enabled()) return;
        const ref = taskReference(todo, state.activeSource); const current = running().find(e => sameTask(e.task_ref, ref));
        const group = el('span', null, 'learning-timer');
        if (readOnly()) {
            if (current) group.append(clock(current));
            if (entries().some(e => !e.deleted && sameTask(e.task_ref, ref))) group.append(button('记录', () => showRecords(entries().filter(e => !e.deleted && sameTask(e.task_ref, ref)), '计时记录', todo, ref)));
            row.insertBefore(group, row.querySelector('.edit-btn')); tick(); return;
        }
        if (current) {
            group.append(el('small', '计时中', 'learning-timing-mark'));
            row.insertBefore(group, row.querySelector('.edit-btn'));
        }
    }
    async function startTiming(todoId, target) {
        await sync();
        await commit(d => {
            requireEnabled();
            if (JSON.stringify(state.activeSource) !== JSON.stringify(target)) throw new Error('清单已切换，请重新选择');
            d.time_entries.push(createRunningTimeEntry(d, todoId));
        });
    }
    function showTimerPicker(reassignment = null) {
        if (readOnly() || !enabled() || (!reassignment && running().length)) return;
        const target = { ...state.activeSource };
        const dialog = modal('最近计时的任务'); dialog.dataset.timing = 'true';
        dialog.classList.add('learning-timer-picker');
        let other = false, busy = false, failure = '';
        const search = input('search', '', '搜索任务', dialog);
        const list = el('div', null, 'learning-timer-candidates');
        const error = el('p', '', 'learning-error'); error.setAttribute('role', 'alert');
        const navigation = button('选择其他任务', () => {
            other = !other; search.value = ''; renderPicker();
            if (other && reassignment) search.focus();
        });
        const cancel = button('取消', () => dialog.close());
        dialog.append(list, error, navigation, cancel);
        async function select(todo) {
            if (busy) return;
            if (reassignment) { reassignment.select(todo); dialog.close(); return; }
            busy = true; failure = ''; renderPicker();
            try {
                await startTiming(todo.id, target);
                dialog.close();
            } catch (e) {
                failure = e.message || String(e);
            } finally { busy = false; if (dialog.open) renderPicker(); }
        }
        function renderPicker() {
            if (!enabled() || readOnly() || JSON.stringify(state.activeSource) !== JSON.stringify(target)) { dialog.close(); return; }
            if (!reassignment && !busy && running().length) { dialog.close(); return; }
            const allTasksTitle = reassignment ? '更换所属任务' : '选择要计时的任务';
            dialog.querySelector('h3').textContent = other ? allTasksTitle : '最近计时的任务';
            search.parentElement.hidden = !other; search.disabled = busy;
            navigation.textContent = other ? '返回最近任务' : '选择其他任务';
            navigation.disabled = busy; cancel.disabled = busy; error.textContent = failure;
            list.replaceChildren();
            const today = localDay(new Date());
            const choices = reassignment ? recordTaskChoices(state.todoData, reassignment.date) : null;
            let candidates;
            if (other) {
                candidates = (choices?.todos ?? timingTodos(state.todoData))
                    .sort((a, b) => Number(b.date === today) - Number(a.date === today) || sortFunc(a, b))
                    .filter(todo => todo.content.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))
                    .map(todo => ({ todo }));
            } else candidates = choices?.recent ?? recentTimingTasks(state.todoData.todos, state.todoData.time_entries || [], state.todoData);
            if (!reassignment) duplicateTimingSeries(state.todoData).forEach(s => list.append(el('p', s.content + '：本期存在重复任务，请到周期关联中核对')));
            if (!candidates.length) {
                const emptySearch = reassignment ? '暂无匹配的任务' : '暂无匹配的可计时任务';
                const emptyRecent = reassignment ? '暂无最近计时的任务，请选择其他任务' : '暂无可继续计时的最近任务，请选择其他任务';
                list.append(el('p', other ? emptySearch : emptyRecent, 'ui-note'));
            }
            for (const { todo, endedAt } of candidates) {
                const item = button('', () => select(todo)); item.classList.add('learning-timer-candidate'); item.disabled = busy;
                item.append(el('span', todo.content));
                const periodic = ['weekly_checkin', 'monthly_checkin'].includes(todo.task_type);
                if ((reassignment && todo.date) || (!reassignment && periodic && !seriesFor(state.todoData, todo.id))) {
                    item.append(el('small', periodDescription(todo.date)));
                }
                if (endedAt) item.append(el('small', lastTimedText(endedAt)));
                list.append(item);
            }
        }
        search.oninput = renderPicker;
        dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
        refreshTimerPicker = renderPicker;
        dialog.addEventListener('close', () => { if (refreshTimerPicker === renderPicker) refreshTimerPicker = null; });
        renderPicker();
    }
    function editEntry(original, todo, ref, changed = () => {}) {
        if (!enabled()) return;
        if (readOnly()) { if (original) showRecords([original]); return; }
        const now = new Date().toISOString();
        const dialog = modal(original ? '编辑计时记录' : '补录计时记录');
        dialog.dataset.timing = 'true';
        const originalName = original ? resolvedEntries().find(e => e.id === original.id)?.display_content || original.task_content_snapshot : todo.content;
        const originalLabel = original ? entryLabel(original) : normalizeLabel(todo.label);
        const taskName = el('span', `所属任务：${originalName}`);
        const taskLine = el('p'); taskLine.append(taskName);
        dialog.append(taskLine);
        const start = input('datetime-local', localInput(original?.started_at || now), '开始日期和时间', dialog); start.step = '1';
        const end = input('datetime-local', localInput(original ? original.ended_at : now), '结束日期和时间（运行中的记录可留空）', dialog); end.step = '1';
        const initialStart = start.value, initialEnd = end.value;
        const labelText = label => `所属任务标签：${label || '未分类'}（在任务编辑页修改）`;
        const taskLabel = el('p', labelText(originalLabel));
        let selectedTaskId = null;
        const changeTask = original && button('更换任务', () => {
            const date = [new Date(start.value), new Date(original.started_at)].find(value => Number.isFinite(value.getTime())) ?? new Date();
            showTimerPicker({ date, select: task => {
                selectedTaskId = sameTask(taskReference(task), original.task_ref) ? null : task.id;
                taskName.textContent = `所属任务：${task.content}`;
                taskLabel.textContent = labelText(normalizeLabel(task.label));
            } });
        });
        if (changeTask) taskLine.append(changeTask);
        dialog.append(taskLabel);
        const error = el('p', '', 'learning-error'); dialog.append(error);
        dialog.append(button('保存记录', async () => {
            if (changeTask) changeTask.disabled = true;
            try {
                if (!start.value || (!original && !end.value)) throw new Error('请填写开始和结束时间');
                const reassignedId = selectedTaskId;
                const updated = { ...(original || { id: crypto.randomUUID(), task_ref: ref, task_content_snapshot: todo.content,
                    created_at: now, deleted: false, label_snapshot: normalizeLabel(todo.label) }),
                    started_at: original && start.value === initialStart ? original.started_at : new Date(start.value).toISOString(),
                    ended_at: original && end.value === initialEnd ? original.ended_at : end.value ? new Date(end.value).toISOString() : null };
                await commit(d => {
                    requireEnabled();
                    const latest = d.time_entries.find(e => e.id === original?.id);
                    if (original && JSON.stringify(latest) !== JSON.stringify(original)) throw new Error('记录已变化，请保留输入并核对最新记录');
                    const pending = !!(original && timingPendingReason(d, original));
                    if (pending && !updated.ended_at) throw new Error('请填写实际结束时间');
                    if (!updated.ended_at && !d.time_entries.some(e => e.id === updated.id && !e.deleted && !e.ended_at)) throw new Error('该记录已结束，请填写结束时间');
                    if (!reassignedId || updated.started_at !== original.started_at || updated.ended_at !== original.ended_at) {
                        const failure = validateTimeEntry(updated, d.time_entries, Date.now(), pending);
                        if (failure) throw new Error(failure);
                    }
                    const saved = { ...updated, updated_at: new Date().toISOString() };
                    if (reassignedId) {
                        const target = d.todos.find(t => t.id === reassignedId && !t.deleted);
                        if (!target || isSeriesDeleted(d, reassignedId)) throw new Error('所选任务已不可用，请重新选择');
                        saved.task_ref = taskReference(target);
                        saved.task_content_snapshot = displayTaskName(d, target.id);
                        saved.label_snapshot = normalizeLabel(target.label);
                    }
                    d.time_entries = [...d.time_entries.filter(e => e.id !== saved.id), saved];
                }); dialog.close(); changed();
            } catch (e) { error.textContent = e.message || String(e); }
            finally { if (changeTask) changeTask.disabled = false; }
        }, 'primary'), button('取消', () => dialog.close()));
    }
    function recordList(host, list, todo, ref) {
        host.replaceChildren();
        for (const entry of [...list].sort((a, b) => Number(!b.ended_at) - Number(!a.ended_at) || b.started_at.localeCompare(a.started_at))) {
            const row = el('div', null, 'learning-record');
            const info = resolvedEntries().find(e => e.id === entry.id);
            row.append(el('div', `${info?.display_content || entry.task_content_snapshot} · ${entryLabel(entry)}${info?.task_unavailable ? ' · 原任务不可用' : info?.task_deleted ? ' · 原任务已删除' : ''}`),
                el('div', `${localInput(entry.started_at).replace('T', ' ')} → ${entry.ended_at ? localInput(entry.ended_at).replace('T', ' ') : pendingReason(entry) || '进行中'}`));
            if (entry.ended_at) row.append(el('small', formatDuration(Date.parse(entry.ended_at) - Date.parse(entry.started_at))));
            else if (!pendingReason(entry)) row.append(clock(entry));
            if (conflicts().has(entry.id)) row.append(el('small', '待核对：与其他计时重叠，未计入统计'));
            if (!readOnly()) row.append(button('编辑记录', () => editEntry(entry, todo, ref, () => {
                const ids = new Set(list.map(e => e.id));
                const current = entries().filter(e => !e.deleted && (ref ? sameTask(e.task_ref, ref) : ids.has(e.id)));
                recordList(host, current, todo, ref);
            })),
                button('删除', () => run(async () => { await remove(entry); row.remove(); }), 'danger'));
            host.append(row);
        }
    }
    function showRecords(list, title = '计时记录', todo, ref) {
        if (!enabled()) return;
        const dialog = modal(title);
        dialog.classList.add('learning-records-dialog');
        const actions = el('div', null, 'learning-records-actions');
        const body = el('div', null, 'learning-records-body');
        dialog.append(actions, body);
        dialog.dataset.timing = 'true';
        if (todo && !readOnly()) {
            const refresh = () => recordList(body, entries().filter(e => !e.deleted && sameTask(e.task_ref, ref)), todo, ref);
            actions.append(button('补录计时记录', () => editEntry(null, todo, ref, refresh)));
            dialog.addEventListener('close', () => compactEditor());
        }
        actions.append(button('关闭', () => dialog.close()));
        recordList(body, list.map(e => entries().find(raw => raw.id === e.id) || e), todo, ref);
    }
    function editTask(todo) {
        const parent = document.querySelector('#edit-modal .modal-content'); if (!parent) return;
        parent.querySelectorAll('.learning-edit-extra, [data-timing-section], #edit-label-section, #edit-series-section').forEach(n => n.remove());
        const host = el('section', null, 'learning-edit-extra');
        const ref = taskReference(todo, state.activeSource);
        const recordDetails = el('details', null, 'edit-section');
        recordDetails.dataset.timingSection = 'true'; recordDetails.hidden = !enabled();
        const recordSummary = el('summary', '计时记录'); recordSummary.id = 'edit-records-summary';
        recordDetails.append(recordSummary,
            button(readOnly() ? '查看计时记录' : '管理计时记录', () => showRecords(entries().filter(e => !e.deleted && sameTask(e.task_ref, ref)), '计时记录', todo, ref)));
        if (!readOnly()) recordDetails.append(button('补录计时记录', () => editEntry(null, todo, ref, () => compactEditor())));
        host.append(recordDetails);
        const labelDetails = el('details', null, 'edit-section'); labelDetails.id = 'edit-label-section';
        labelDetails.append(el('summary', '标签：' + (todo.label || '未分类'))); host.append(labelDetails);
        if (readOnly()) { (parent.querySelector('.modal-body') || parent).append(host); return; }
        const label = el('input'); label.type = 'hidden'; label.value = todo.label || ''; label.id = 'edit-learning-label'; labelDetails.append(label);
        label.addEventListener('input', () => { labelDetails.firstChild.textContent = '标签：' + (normalizeLabel(label.value) || '未分类'); });
        const select = name => { label.value = name || ''; label.dispatchEvent(new Event('input', { bubbles: true })); };
        labelDetails.append(button('选择已有标签', () => {
            const picker = modal('选择标签'); const search = input('search', '', '搜索标签', picker); const list = el('div'); picker.append(list);
            const render = () => { list.replaceChildren(); [null, ...availableLabels(knownTasks().map(t => t.todo))].filter(n => (n || '未分类').includes(search.value.trim())).forEach(n => {
                const b = button((normalizeLabel(label.value) === n ? '✓ ' : '') + (n || '未分类'), () => { select(n); picker.close(); }); list.append(b);
            }); };
            search.oninput = render; refreshLabelPicker = render;
            picker.addEventListener('close', () => { refreshLabelPicker = null; });
            render(); picker.append(button('取消', () => picker.close()));
        }), button('新建标签', () => {
            const picker = modal('新建标签'); const name = input('text', '', '标签名称', picker);
            picker.append(button('确认', () => { select(normalizeLabel(name.value)); picker.close(); }, 'primary'), button('取消', () => picker.close()));
        }));
        if (periods && ['weekly_checkin', 'monthly_checkin'].includes(todo.task_type)) {
            const manage = el('details', null, 'edit-section'); manage.id = 'edit-series-section'; manage.append(el('summary', '周期关联'), button('管理周期关联', () => periods().associations(todo.id))); host.append(manage);
        }
        const body = parent.querySelector('.modal-body');
        if (body) body.append(host); else parent.insertBefore(host, parent.querySelector('.modal-footer'));
    }
    function updateEditorSummary(id) {
        const section = document.getElementById(id); if (!section) return;
        const field = name => document.getElementById(name);
        let text;
        switch (id) {
            case 'edit-type-section': text = '任务类型：' + field('edit-task-type').selectedOptions[0].textContent; break;
            case 'edit-date-section': text = '截止日期：' + (field('edit-has-date-switch').checked ? field('edit-date').value || '待设置' : '未设置'); break;
            case 'edit-reminder-section': text = '提醒：' + (field('edit-reminder-switch').checked ? [field('edit-reminder-date').value, field('edit-reminder-time').value].filter(Boolean).join(' ') : '未设置'); break;
            case 'edit-target-section': text = '打卡目标：' + (field('edit-target-count').value || '未设置'); break;
            case 'edit-checkin-section': text = '打卡记录：' + (state.currentEditingCompletedDates || []).length + ' 次' + (field('edit-target-count').value ? ' · 目标 ' + field('edit-target-count').value + ' 次' : ''); break;
            case 'edit-completed-section': text = '完成时间：' + field('edit-completed-date').value + ' ' + field('edit-completed-time').value; break;
            case 'edit-subtasks-section': {
                const items = state.currentEditingSubtasks || [];
                text = items.length ? '子步骤／备注：' + items.filter(t => t.completed).length + '/' + items.length : '添加子步骤／备注'; break;
            }
            default: return;
        }
        if (section.firstChild.textContent !== text) section.firstChild.textContent = text;
    }
    function compactEditor(reset = false) {
        const parent = document.querySelector('#edit-modal .modal-body'); if (!parent) return;
        const byId = id => document.getElementById(id);
        function section(id, nodes) {
            let d = byId(id);
            if (!d) { d = el('details', null, 'edit-section'); d.id = id; d.append(el('summary')); nodes[0].before(d); nodes.forEach(n => d.append(n)); }
            return d;
        }
        const type = byId('edit-task-type');
        section('edit-type-section', [type.closest('.input-group')]).firstChild.textContent = '任务类型：' + type.selectedOptions[0].textContent;
        const date = section('edit-date-section', [byId('edit-date-time-row')]);
        date.hidden = type.value !== 'normal'; date.firstChild.textContent = '截止日期：' + (byId('edit-has-date-switch').checked ? byId('edit-date').value || '待设置' : '未设置');
        section('edit-reminder-section', [byId('edit-reminder-row')]).firstChild.textContent = '提醒：' + (byId('edit-reminder-switch').checked ? [byId('edit-reminder-date').value, byId('edit-reminder-time').value].filter(Boolean).join(' ') : '未设置');
        const target = section('edit-target-section', [byId('target-count-group')]);
        target.hidden = !['weekly_checkin', 'monthly_checkin'].includes(type.value); target.firstChild.textContent = '打卡目标：' + (byId('edit-target-count').value || '未设置');
        const checkin = section('edit-checkin-section', [byId('edit-checkin-grid-group')]);
        checkin.hidden = !['weekly_checkin', 'monthly_checkin'].includes(type.value);
        checkin.firstChild.textContent = '打卡记录：' + (state.currentEditingCompletedDates || []).length + ' 次' + (byId('edit-target-count').value ? ' · 目标 ' + byId('edit-target-count').value + ' 次' : '');
        const completed = section('edit-completed-section', [byId('edit-completed-at-row')]);
        completed.hidden = byId('edit-completed-at-row').style.display === 'none'; completed.firstChild.textContent = '完成时间：' + byId('edit-completed-date').value + ' ' + byId('edit-completed-time').value;
        let subtasks = byId('edit-subtasks-section');
        if (!subtasks) {
            const header = byId('sort-subtasks-btn').parentElement.parentElement;
            subtasks = section('edit-subtasks-section', [header, header.nextElementSibling]);
            const tools = el('div', null, 'edit-subtask-actions');
            tools.append(byId('sort-subtasks-btn'), byId('copy-subtasks-btn')); header.replaceChildren(tools);
        }
        const items = state.currentEditingSubtasks || [];
        subtasks.firstChild.textContent = items.length ? '子步骤／备注：' + items.filter(t => t.completed).length + '/' + items.length : '添加子步骤／备注';
        const todo = state.currentEditingTodo;
        if (enabled() && todo && byId('edit-records-summary')) {
            const snapshot = learningSnapshot(state);
            const resolved = resolveLearningEntries(snapshot.data.time_entries || [], snapshot.tasks, { data: snapshot.data, source: state.activeSource });
            const list = resolved.filter(e => !e.deleted && sameTask(e.task_ref, taskReference(todo, state.activeSource)));
            const conflictIds = snapshot.conflicts;
            const parts = list.filter(e => !conflictIds.has(e.id)).flatMap(splitTimeEntry);
            byId('edit-records-summary').textContent = '关联计时：' + formatDuration(parts.reduce((sum, p) => sum + p.duration, 0)) + ' · ' + parts.length + ' 次' + (list.some(e => !e.ended_at && !e.pending_reason) ? ' · 进行中' : '') + (list.some(e => conflictIds.has(e.id) || e.pending_reason) ? ' · 待核对' : '');
        }
        if (reset) {
            let progress = byId('edit-progress'), more = byId('edit-more');
            if (!progress) {
                const title = el('h4', '基本信息', 'edit-group-heading'); parent.prepend(title);
                progress = el('section'); progress.id = 'edit-progress'; more = el('section'); more.id = 'edit-more'; parent.append(progress, more);
            }
            parent.querySelectorAll('.edit-section').forEach(n => parent.append(n));
            progress.replaceChildren(el('h4', '进展与记录', 'edit-group-heading')); more.replaceChildren(el('h4', '更多设置', 'edit-group-heading'));
            const sections = ['edit-type-section', 'edit-date-section', 'edit-reminder-section', 'edit-target-section', 'edit-checkin-section', 'edit-completed-section', 'edit-subtasks-section'];
            const record = parent.querySelector('[data-timing-section]');
            sections.map(byId).filter(Boolean).forEach(n => { n.open = false; more.append(n); });
            if (record) { record.open = false; more.append(record); }
            for (const id of ['edit-label-section', 'edit-series-section']) if (byId(id)) more.append(byId(id));
            const included = editorProgressSections({ ...todo, subtasks: items, completed_dates: state.currentEditingCompletedDates || [] }, entries(), taskReference(todo, state.activeSource), enabled());
            if (included.includes('subtasks')) { progress.append(subtasks); subtasks.open = true; }
            if (record && included.includes('timing')) { progress.append(record); record.open = true; }
            if (included.includes('checkins')) { progress.append(checkin); checkin.open = true; }
            if (progress.children.length === 1) progress.append(el('p', '暂无进展记录，可在下方添加', 'ui-note'));
            let period = byId('edit-period-description');
            if (!period) { period = el('p'); period.id = 'edit-period-description'; byId('edit-content').after(period); }
            period.textContent = ['weekly_checkin', 'monthly_checkin'].includes(todo.task_type) ? periodDescription(todo.date) : '';
            parent.scrollTop = 0;
        }
        const progressHeading = byId('edit-progress')?.querySelector('h4');
        if (todo && seriesFor(state.todoData, todo.id) && periods && progressHeading) {
            if (!progressHeading.querySelector('button')) progressHeading.append(button('往期对比', () => periods().compare(todo.id)));
        } else { progressHeading?.querySelector('button')?.remove(); }
        if (!parent.dataset.compactListening) {
            parent.dataset.compactListening = 'true';
            const update = event => {
                const id = event.target.closest('.edit-section')?.id;
                // 文字正文不影响数量摘要，也不需要计时快照。
                if (id === 'edit-subtasks-section' || !id) return;
                updateEditorSummary(id);
                if (id === 'edit-target-section') updateEditorSummary('edit-checkin-section');
                if (id === 'edit-type-section') {
                    byId('edit-date-section').hidden = type.value !== 'normal';
                    for (const name of ['target', 'checkin']) byId('edit-' + name + '-section').hidden = type.value === 'normal';
                    byId('edit-completed-section').hidden = byId('edit-completed-at-row').style.display === 'none';
                }
            };
            parent.addEventListener('input', update); parent.addEventListener('change', update);
        }
    }
    async function choices(title, items) {
        return new Promise(resolve => {
            const d = modal(title); items.forEach(([text, value]) => d.append(button(text, () => { resolve(value); d.close(); })));
            d.addEventListener('cancel', e => { e.preventDefault(); resolve('cancel'); d.close(); });
        });
    }
    function renderPlan(host, date, daily = false) {
        const controller = planning?.();
        if (!controller || readOnly()) return;
        const { plan, text, rating, score, busy, loadError, syncFailed, saving, saveError } = controller.day(date);
        const messages = { empty: '本周尚未制定计划', current: text || '当天未安排',
            conflict: '周计划存在分歧，请到周视图处理', restart: '周计划需重新制定' };
        host.replaceChildren(el('h4', '今日计划'));
        clippedText(host, loadError || messages[plan] || '正在读取计划与评分…', 2);
        if (syncFailed && !loadError) host.append(el('p', '计划与评分同步未完成'));
        if (loadError) host.append(button('重试读取', controller.reload));
        if (!daily) return;
        if (score != null) {
            const row = el('div', null, 'daily-rating-row');
            const badge = el('span', String(score), 'daily-rating-badge rating-tone');
            badge.dataset.score = score;
            badge.setAttribute('role', 'img');
            badge.setAttribute('aria-label', `${score} 分`);
            row.append(el('h4', '当日评分'), badge);
            host.append(row);
        } else {
            host.append(el('h4', '当日评分'));
            if (rating === undefined) host.append(el('p', '评分暂不可用'));
            const scores = el('div', null, 'planning-score-choices');
            if (rating !== undefined) for (const value of [1, 2, 3, 4, 5]) {
                const choice = button(`${value} 分`, () => controller.rate(date, value, rating));
                choice.disabled = busy || controller.hasPendingWrite();
                choice.setAttribute('aria-pressed', 'false');
                scores.append(choice);
            }
            host.append(scores);
        }
        if (saving) host.append(el('p', '正在保存评分…'));
        if (saveError) host.append(el('p', saveError, 'learning-error'));
        if (saveError && controller.hasPendingWrite(date)) host.append(button('重试保存评分', controller.retryRating));
    }
    function showPlanInDialog(dialog, date) {
        const controller = planning?.();
        if (!controller || readOnly()) return;
        const host = el('section');
        dialog.append(host);
        const target = state.personalTarget;
        const update = () => {
            if (target !== state.personalTarget || readOnly()) {
                host.replaceChildren(el('p', '个人清单已切换，请重新打开复盘', 'learning-error'));
            } else renderPlan(host, date);
        };
        update();
        const unsubscribe = controller.subscribe(update);
        dialog.addEventListener('close', unsubscribe, { once: true });
    }
    function editReview(date) {
        if (readOnly()) return;
        const target = state.personalTarget;
        const controller = planning?.();
        let reviewBaseline = data().daily_reviews?.find(r => r.date === date) ?? null;
        const base = reviewBaseline?.deleted ? null : reviewBaseline;
        const dialog = modal(`${date} · 编辑当日回顾`); const inputs = {};
        let savedFields = Object.fromEntries(reviewFields.map(([key]) => [key, base?.[key] || '']));
        const scoreOf = rating => rating?.deleted ? null : rating?.score ?? null;
        let ratingBaseline = controller?.day(date).rating;
        let score = scoreOf(ratingBaseline);
        let retryingRating = false;
        let saving = false, leaving = false;
        showPlanInDialog(dialog, date);
        dialog.append(button('查看周计划', async () => {
            if (await leave(true)) await openWeek?.(date);
        }));
        const scoreGroup = el('div', null, 'planning-score-choices');
        const ratingReadStatus = el('p');
        const scoreButtons = [1, 2, 3, 4, 5, null].map(value => button(value == null ? '清除评分' : `${value} 分`, () => {
            score = value;
            queueMicrotask(updateScore);
        }));
        scoreGroup.append(...scoreButtons);
        dialog.append(el('h4', '当日评分'), scoreGroup, ratingReadStatus);
        function updateScore() {
            if (ratingBaseline === undefined && ratingBaseline === controller?.day(date).rating) {
                ratingReadStatus.textContent = '评分暂不可用';
            } else if (ratingBaseline === undefined) {
                ratingBaseline = controller.day(date).rating;
                score = scoreOf(ratingBaseline);
                ratingReadStatus.textContent = '';
            }
            scoreButtons.forEach((node, index) => {
                node.disabled = saving || retryingRating || ratingBaseline === undefined;
                node.setAttribute('aria-pressed', String(score === ([1, 2, 3, 4, 5, null][index])));
            });
        }
        updateScore();
        const unsubscribe = controller?.subscribe(updateScore);
        if (unsubscribe) dialog.addEventListener('close', unsubscribe, { once: true });
        for (const [key, title, hint] of reviewFields) {
            const label = el('label', title); const text = el('textarea'); text.rows = 3; text.placeholder = hint; text.value = base?.[key] || '';
            inputs[key] = text; label.append(text); dialog.append(label);
        }
        const error = el('p', '', 'learning-error'); dialog.append(error);
        const reviewDirty = () => reviewFields.some(([key]) => inputs[key].value !== savedFields[key]);
        const ratingDirty = () => score !== scoreOf(ratingBaseline);
        const dirty = () => reviewDirty() || ratingDirty() || retryingRating;
        const rebase = button('核对最新内容', async () => {
            const currentReview = data().daily_reviews?.find(r => r.date === date) ?? null;
            const currentRating = controller?.day(date).rating;
            const reviewText = reviewFields.map(([key, title]) => `${title}：${currentReview?.deleted ? '未填写' : currentReview?.[key] || '未填写'}`).join('\n');
            const choice = await choices(`最新评分：${scoreOf(currentRating) ?? '未评分'}\n${reviewText}`,
                [['保留草稿并采用最新基线', 'accept'], ['继续核对', 'cancel']]);
            if (choice !== 'accept') return;
            if (!ratingDirty()) score = scoreOf(currentRating);
            if (!reviewDirty()) {
                for (const [key] of reviewFields) inputs[key].value = currentReview?.deleted ? '' : currentReview?.[key] ?? '';
            }
            ratingBaseline = currentRating;
            reviewBaseline = currentReview;
            savedFields = Object.fromEntries(reviewFields.map(([key]) => [key, currentReview?.deleted ? '' : currentReview?.[key] ?? '']));
            rebase.hidden = true;
            error.textContent = '';
            updateScore();
        });
        rebase.hidden = true;
        dialog.append(rebase);
        const save = async () => {
            if (saving) return false;
            saving = true;
            error.textContent = '正在保存…';
            updateScore();
            Object.values(inputs).forEach(input => { input.disabled = true; });
            const saved = [], failed = [];
            try {
                if (target !== state.personalTarget || readOnly()) throw new Error('个人清单已切换，请重新打开复盘');
                const fields = Object.fromEntries(reviewFields.map(([key]) => [key, inputs[key].value]));
                if (reviewDirty() && !Object.values(fields).some(v => v.trim())) throw new Error('请至少填写一项复盘内容');
                if (ratingDirty() || retryingRating) {
                    const ok = retryingRating ? await controller.retryRating() : await controller.rate(date, score, ratingBaseline);
                    retryingRating = !ok && controller.hasPendingWrite(date);
                    if (ok) {
                        ratingBaseline = controller.day(date).rating;
                        score = scoreOf(ratingBaseline);
                        saved.push('评分已保存');
                    } else failed.push(controller.day(date).saveError || '评分未保存，请重试');
                }
                if (reviewDirty()) {
                    try {
                        let written;
                        await commit(d => {
                            if (target !== state.personalTarget) throw new Error('个人清单已切换，请重新打开');
                            const existing = d.daily_reviews.find(r => r.date === date) ?? null;
                            if (canonicalJson(existing) !== canonicalJson(reviewBaseline)) throw new Error('当日复盘已更新，请核对后再保存');
                            const now = new Date().toISOString();
                            written = { id: existing?.id || crypto.randomUUID(), date, created_at: existing?.created_at || now,
                                updated_at: now, deleted: false, ...fields };
                            d.daily_reviews = [...d.daily_reviews.filter(r => r.date !== date), written];
                        });
                        reviewBaseline = written;
                        savedFields = fields;
                        saved.push('复盘已保存');
                    } catch (e) { failed.push(e.message || String(e)); }
                }
                rebase.hidden = retryingRating || !failed.some(message => message.includes('已更新'));
                error.textContent = failed.length ? [...saved, ...failed].join('。') : '';
                return !failed.length;
            } catch (e) { error.textContent = e.message || String(e); return false; }
            finally {
                saving = false;
                updateScore();
                Object.values(inputs).forEach(input => { input.disabled = false; });
            }
        };
        const close = () => { reviewLeave = null; dialog.close(); };
        const leave = async (goingToWeek = false) => {
            if (saving || leaving) return false;
            if (!dirty()) { close(); return true; }
            leaving = true;
            try {
                const answer = goingToWeek ? await choices('当日回顾有未保存的修改',
                    [['保存并前往', 'save'], ['放弃修改并前往', 'discard'], ['继续编辑', 'cancel']]) : await chooseLeave('当日回顾');
                if (answer === 'discard' || (answer === 'save' && await save())) { close(); return true; }
                return false;
            } finally { leaving = false; }
        };
        reviewLeave = leave;
        dialog.addEventListener('cancel', e => { e.preventDefault(); void leave(); });
        dialog.append(button('保存', async () => { if (await save()) close(); }, 'primary'), button('取消', leave), button('导出', async () => {
            if (dirty()) {
                const answer = await choices('有未保存的复盘修改', [['保存后导出', 'save'], ['仅导出已保存内容', 'saved'], ['取消', 'cancel']]);
                if (answer === 'cancel' || (answer === 'save' && !await save())) return;
            }
            exportDialog('day', new Date(date + 'T12:00:00'));
        }));
    }
    function showReview(review) {
        const d = modal(`${review.date} · 每日复盘`);
        showPlanInDialog(d, review.date);
        for (const [key, title] of reviewFields) { d.append(el('h4', title), el('p', review[key] || '未填写', 'learning-text')); }
        if (!readOnly()) d.append(button('编辑', () => { d.close(); editReview(review.date); }));
        d.append(button('关闭', () => d.close()));
    }
    function exportDialog(period = state.statsPeriod, target = state.statsTargetDate) {
        const source = JSON.stringify(state.activeSource);
        const personalTarget = state.personalTarget;
        const controller = !readOnly() && planning?.();
        const d = modal('导出复盘 Markdown');
        if (controller) {
            const unsubscribe = controller.subscribe(() => {
                if (personalTarget !== state.personalTarget || source !== JSON.stringify(state.activeSource)) d.close();
            });
            d.addEventListener('close', unsubscribe, { once: true });
        }
        const range = el('select');
        range.setAttribute('aria-label', '导出范围');
        for (const [value, text] of [['day', '当天'], ['week', '本周'], ['month', '本月']]) {
            const option = el('option', text); option.value = value; range.append(option);
        }
        range.value = period;
        if (controller) d.append(range);
        const include = input('checkbox', '', '附带学习时长统计（逐日）', d); include.checked = enabled();
        include.parentElement.dataset.timingSection = 'true'; include.parentElement.hidden = !enabled();
        const options = controller ? Object.fromEntries([
            ['includePlans', '计划'], ['includeRatings', '评分'], ['includePlanHistory', '计划历史及调整原因']
        ].map(([key, label]) => [key, input('checkbox', '', label, d)])) : {};
        const error = el('p', '', 'learning-error'); d.append(error);
        const retry = button('重试读取计划与评分', () => controller?.reload());
        retry.hidden = true;
        d.append(retry);
        d.append(button('导出文件', async () => {
            try {
                error.textContent = '';
                retry.hidden = true;
                if (source !== JSON.stringify(state.activeSource) || personalTarget !== state.personalTarget) { d.close(); return; }
                const flags = Object.fromEntries(Object.entries(options).map(([key, box]) => [key, box.checked]));
                const withPlanning = Object.values(flags).some(Boolean);
                const view = controller && controller.snapshot();
                if (withPlanning && !view) { retry.hidden = false; throw new Error('计划与评分暂不可用，请重试或取消相关选项'); }
                const exportData = withPlanning ? { ...data(), weekly_plan_versions: view.weekly_plan_versions,
                    weekly_plan_selections: view.weekly_plan_selections, daily_ratings: view.daily_ratings } : data();
                const result = exportReviews(exportData, range.value, target, enabled() && include.checked, knownTasks(), conflicts(), state.activeSource, flags);
                const saved = await exportFile(result);
                if (saved && d.open) { toast('文件已保存'); d.close(); }
            }
            catch (e) { error.textContent = e.message || String(e); }
        }), button('取消', () => d.close()));
    }
    function learningDetails(start, end, resolved) {
        const learning = modal('学习投入详情');
        learning.dataset.timing = 'true';
        const totals = el('div');
        const filter = el('select');
        filter.setAttribute('aria-label', '学习标签');
        const names = [...new Set(resolved.filter(e => !e.deleted).map(e => normalizeLabel(e.label_snapshot) || '未分类'))].sort();
        if (labelFilter && !names.includes(labelFilter)) labelFilter = '';
        [['', '全部标签'], ...names.map(n => [n, n])].forEach(([v, t]) => { const o = el('option', t); o.value = v; filter.append(o); });
        const renderTotals = () => {
            const summary = summarizeLearning(resolved, start, end, labelFilter ? normalizeLabel(labelFilter) : undefined, conflicts());
            totals.replaceChildren(el('p', `${labelFilter || '全部标签'}：${formatDuration(summary.duration)} · ${summary.count} 次`));
            for (const group of summary.groups) totals.append(button(`${group.label} · ${formatDuration(group.duration)} · ${group.count} 次`, () => {
                showRecords([...new Map(summary.parts.filter(p => (p.entry.label_snapshot || '未分类') === group.label)
                    .map(p => [p.entry.id, p.entry])).values()]);
            }));
        };
        filter.value = labelFilter || '';
        filter.onchange = () => { labelFilter = filter.value; renderTotals(); };
        learning.append(filter, totals, button('关闭', () => learning.close()));
        renderTotals();
    }
    function renderWeekReviews(host, cells, openDay) {
        host.replaceChildren();
        for (const { date } of cells) {
            const review = data().daily_reviews?.find(item => item.date === date && !item.deleted);
            const content = review ? reviewPreview(review) : '尚未填写复盘';
            const entry = button(`${date} · ${content}`, () => openDay(date));
            entry.classList.add('learning-preview');
            host.append(entry);
        }
    }
    function renderLearningSummary(start, end) {
        const learning = document.getElementById('stats-learning-summary');
        if (!learning) return;
        learning.replaceChildren();
        if (!enabled()) return;
        const resolved = resolvedEntries();
        const summary = summarizeLearning(resolved, start, end, undefined, conflicts());
        learning.append(el('p', summary.count ? `学习：已记录 ${formatDuration(summary.duration)}` : '暂无学习记录', 'ui-note'));
        learning.append(button('查看投入详情', () => learningDetails(start, end, resolved)));
        if (summary.running) learning.append(button(`${summary.running} 条进行中，尚未计入汇总`, () =>
            showRecords(resolved.filter(e => !e.deleted && e.ended_at == null && !e.pending_reason &&
                Date.parse(e.started_at) < Date.parse(end + 'T00:00:00')), '进行中')));
        if (summary.pending) learning.append(button(`${summary.pending} 条待核对记录未计入 · 查看`, () => showRecords(resolved.filter(e => !e.deleted && (conflicts().has(e.id) || e.pending_reason) &&
            Date.parse(e.started_at) < Date.parse(end + 'T00:00:00') && (e.ended_at == null || Date.parse(e.ended_at) > Date.parse(start + 'T00:00:00'))), '核对计时记录')));
    }
    function renderStats() {
        const host = document.getElementById('learning-insights'); if (!host) return;
        stopReviewUpdates?.();
        stopReviewUpdates = undefined;
        host.replaceChildren();
        const { start, end } = learningRange(state.statsPeriod, state.statsTargetDate);
        renderLearningSummary(start, end);
        if (state.statsPeriod === 'week' && !readOnly() && planning?.()) {
            planning().refreshWeekReviews();
            return;
        }
        const localDaily = state.statsPeriod === 'day' && !readOnly();
        const review = el('section', null, 'ui-card learning-card');
        review.id = 'daily-review-card';
        const header = el('div', null, 'insight-row');
        header.append(el('h3', localDaily ? '计划与回顾' : readOnly() ? '每日复盘' : '我的复盘'),
            localDaily ? button('编辑', () => editReview(start)) : button('导出 Markdown', () => exportDialog()));
        review.append(header);
        if (localDaily && planning?.()) {
            const plan = el('section', null, 'daily-review-plan');
            review.append(plan, el('h4', '复盘'));
            const update = () => renderPlan(plan, start, true);
            update();
            stopReviewUpdates = planning().subscribe(update);
        }
        const list = (data().daily_reviews || []).filter(r => !r.deleted && r.date >= start && r.date < end).sort((a, b) => b.date.localeCompare(a.date));
        if (state.statsPeriod === 'day') {
            if (localDaily && list[0]) {
                const preview = el('p', reviewPreview(list[0]), 'learning-text insight-clipped');
                const full = el('div');
                full.hidden = true;
                for (const [key, title] of reviewFields) full.append(el('h4', title), el('p', list[0][key] || '未填写', 'learning-text'));
                const expand = button('展开', () => {
                    full.hidden = !full.hidden;
                    preview.hidden = !full.hidden;
                    expand.textContent = full.hidden ? '展开' : '收起';
                    expand.setAttribute('aria-expanded', String(!full.hidden));
                });
                expand.setAttribute('aria-expanded', 'false');
                review.append(preview, expand, full);
                const filled = reviewFields.filter(([key]) => list[0][key]?.trim());
                if (filled.length <= 1 && !list[0][filled[0]?.[0]]?.split('\n').slice(2).length) {
                    requestAnimationFrame(() => { expand.hidden = preview.scrollHeight <= preview.clientHeight + 1; });
                }
            } else if (localDaily) review.append(el('p', '尚未填写，可通过编辑记录', 'ui-note'));
            else if (list[0]) for (const [key, title] of reviewFields) review.append(el('h4', title), el('p', list[0][key] || '未填写', 'learning-text'));
            else review.append(el('p', '暂无复盘', 'ui-note'));
        } else {
            if (!list.length) review.append(el('p', '这个时间范围还没有复盘', 'ui-note'));
            list.forEach(r => { const card = button(`${r.date}\n${reviewPreview(r)}`, () => showReview(r)); card.classList.add('learning-preview'); review.append(card); });
        }
        host.append(review);
    }
    function refresh() {
        const source = JSON.stringify(state.activeSource);
        if (source !== lastSource) {
            document.querySelectorAll('dialog.learning-dialog').forEach(d => d.close());
            reviewLeave = null; refreshLabelPicker = null; refreshTimerPicker = null; labelFilter = ''; lastConflict = ''; lastSource = source;
        }
        if (enabled() && !timer) timer = setInterval(tick, 1000);
        if (!enabled() && timer) { clearInterval(timer); timer = null; }
        document.querySelectorAll('[data-timing-section]').forEach(n => { n.hidden = !enabled(); });
        if (!enabled()) document.querySelectorAll('dialog[data-timing]').forEach(d => d.close());
        refreshLabelPicker?.();
        refreshTimerPicker?.();
        if (state.currentEditingTodo && document.getElementById('edit-modal')?.classList.contains('active')) compactEditor();
        if (!banner) { banner = el('div', null, 'learning-banner'); document.querySelector('main')?.before(banner); }
        banner.replaceChildren(); const active = enabled() ? running() : []; banner.hidden = !active.length;
        const startButton = document.getElementById('start-timer-btn');
        if (startButton) startButton.hidden = !enabled() || readOnly() || active.length > 0;
        if (active.length === 1) {
            const reason = pendingReason(active[0]);
            banner.append(el('span', resolvedEntries().find(e => e.id === active[0].id)?.display_content || active[0].task_content_snapshot));
            if (reason) banner.append(el('span', reason)); else banner.append(clock(active[0]));
            if (!readOnly() && !reason) banner.append(button('结束', () => run(() => stop(active[0].id))));
            banner.append(button('记录', () => showRecords(active)));
        }
        if (active.length > 1) {
            banner.append(button(`${active.length} 条计时待处理`, () => showRecords(active, '请补上真实结束时间或删除误开记录')));
            const key = active.map(e => e.id).sort().join('|'); if (!readOnly() && lastConflict !== key) { lastConflict = key; showRecords(active, '多条计时正在运行'); }
        } else lastConflict = '';
        if (state.currentView === 'stats') renderStats(); tick();
    }
    function install() {
        const startButton = document.getElementById('start-timer-btn');
        if (startButton) startButton.onclick = () => showTimerPicker();
        const anchor = document.querySelector('.stats-list-toggle-container'); const host = el('div'); host.id = 'learning-insights'; anchor?.before(host);
        // 编辑弹窗阻止底层导航；关闭窗口也先处理未保存正文。
        window.addEventListener('beforeunload', e => { if (reviewLeave) { e.preventDefault(); e.returnValue = ''; } });
        window.__TAURI__.window?.getCurrentWindow?.().onCloseRequested(async event => {
            if (reviewLeave) { event.preventDefault(); if (await reviewLeave()) await window.__TAURI__.window.getCurrentWindow().close(); }
        });
    }
    async function prepareDisable() {
        const active = structuredClone((state.todoData.time_entries || []).filter(e => !e.deleted && !e.ended_at)); if (!active.length) return true;
        if (active.some(e => timingPendingReason(state.todoData, e))) {
            const choice = await choices('有结束时间待核对的记录；请先核对实际结束时间，或仅关闭本机计时功能。', [['核对记录', 'review'], ['仅关闭本机计时功能', 'hide'], ['取消', 'cancel']]);
            if (choice === 'review') showRecords(active, '核对实际结束时间');
            return choice === 'hide';
        }
        const answer = await choices(`有 ${active.length} 条计时正在运行：${active.map(e => e.task_content_snapshot).join('、')}。结束操作将全部结束于当前时间并影响统计；仅关闭本机功能会保留运行记录，重新开启或在其他设备处理。`,
            [['仅关闭本机计时功能', 'hide'], ['结束计时并关闭', 'stop'], ['取消', 'cancel']]);
        if (answer === 'cancel') return false;
        if (answer === 'stop') {
            const now = new Date().toISOString();
            let discarded = 0;
            await commitPersonal(d => {
                const current = d.time_entries.filter(e => !e.deleted && !e.ended_at);
                if (current.length !== active.length || current.some(e => !active.some(old => JSON.stringify(old) === JSON.stringify(e)))) throw new Error('运行记录已变化，请重新保存并确认');
                d.time_entries = d.time_entries.map(entry => {
                    if (!current.includes(entry)) return entry;
                    const finished = finishTimeEntry(entry, now);
                    if (finished.deleted) discarded++;
                    return finished;
                });
            }, { type: 'personal' });
            showShortTimerNotice(discarded);
        }
        return true;
    }
    function editRecord(entry) {
        const current = entries().find(e => e.id === entry.id && !e.deleted);
        if (!current) { toast('该计时记录已删除'); return; }
        editEntry(current);
    }
    function chooseLeave(label) {
        return choices(`${label}有未保存的修改`, [['保存并离开', 'save'], ['放弃修改', 'discard'], ['继续编辑', 'cancel']]);
    }
    return { beforeSourceChange: async () => !reviewLeave || await reviewLeave(), chooseLeave, enabled, conflicts, install, refresh, attachTimer, editTask, renderStats, renderWeekReviews, exportDialog, compactEditor, updateEditorSummary, resolvedEntries, showRecords, editRecord, prepareDisable };
}
