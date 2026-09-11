import { normalizeLabel, taskReference, sameTask, learningRange, summarizeLearning, formatDuration, validateTimeEntry, localDay, overlappingEntries, availableLabels, resolveLearningEntries } from './timeTracking.js';
import { reviewFields, reviewPreview, exportReviews } from './reviewUtils.js';

// 所有用户文字均通过 textContent/value 写入，计时刷新只更新文本。
function el(tag, text, className) {
    const node = document.createElement(tag); if (text != null) node.textContent = text;
    if (className) node.className = className; return node;
}
function button(text, action) {
    const b = el('button', text, 'learning-button'); b.type = 'button';
    b.onclick = async e => { e.stopPropagation(); b.disabled = true; try { await action(); } finally { b.disabled = false; } }; return b;
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

export function createLearningView({ state, commit, redraw, sync, toast, exportFile }) {
    const data = () => state.todoData;
    const entries = () => data().time_entries || [];
    const knownTasks = () => [...(data().todos || []).map(todo => ({ todo, ref: taskReference(todo) })),
        ...(state.activeSource.type === 'collaboration' ? (state.collabData?.todos || []).map(todo => ({ todo, ref: taskReference(todo, state.activeSource) })) : [])];
    const resolvedEntries = () => resolveLearningEntries(entries(), knownTasks());
    const entryLabel = entry => resolvedEntries().find(e => e.id === entry.id)?.label_snapshot || '未分类';
    const running = () => entries().filter(e => !e.deleted && e.ended_at == null);
    let labelFilter, banner, lastConflict = '', reviewLeave, refreshLabelPicker;
    const run = async action => { try { await action(); } catch (e) { toast(e.message || String(e)); } };
    function clock(entry) {
        const node = el('span', '', 'learning-clock'); node.dataset.started = entry.started_at; return node;
    }
    function tick() {
        document.querySelectorAll('[data-started]').forEach(node => {
            node.textContent = formatDuration(Date.now() - Date.parse(node.dataset.started), true);
        });
    }
    async function stop(id) {
        await commit(d => { const e = d.time_entries.find(x => x.id === id); if (e && !e.deleted && !e.ended_at) e.ended_at = e.updated_at = new Date().toISOString(); });
    }
    async function remove(entry) {
        await commit(d => { const e = d.time_entries.find(x => x.id === entry.id); if (e) { e.deleted = true; e.updated_at = new Date().toISOString(); } });
    }
    function attachTimer(row, todo) {
        if (todo.deleted) return;
        const ref = taskReference(todo, state.activeSource); const current = running().find(e => sameTask(e.task_ref, ref));
        const group = el('span', null, 'learning-timer');
        if (current) { group.append(clock(current), button('结束', () => run(() => stop(current.id)))); }
        else if (!running().length) group.append(button('开始', () => run(async () => {
            await sync();
            await commit(d => {
                if (d.time_entries.some(e => !e.deleted && !e.ended_at)) throw new Error('已有任务正在计时，请先结束或处理记录');
                const now = new Date().toISOString();
                d.time_entries.push({ id: crypto.randomUUID(), task_ref: ref, task_content_snapshot: todo.content,
                    label_snapshot: normalizeLabel(todo.label), started_at: now, ended_at: null, created_at: now, updated_at: now, deleted: false });
            });
        })));
        row.insertBefore(group, row.querySelector('.edit-btn')); tick();
    }
    function editEntry(original, todo, ref, changed = () => {}) {
        const now = new Date().toISOString();
        const dialog = modal(original ? '编辑计时记录' : '补录计时记录');
        const start = input('datetime-local', localInput(original?.started_at || now), '开始日期和时间', dialog); start.step = '1';
        const end = input('datetime-local', localInput(original ? original.ended_at : now), '结束日期和时间（运行中的记录可留空）', dialog); end.step = '1';
        dialog.append(el('p', '所属任务标签：' + (original ? entryLabel(original) : normalizeLabel(todo?.label) || '未分类') + '（在任务编辑页修改）'));
        const error = el('p', '', 'learning-error'); dialog.append(error);
        dialog.append(button('保存记录', async () => {
            try {
                if (!start.value || (!original && !end.value)) throw new Error('请填写开始和结束时间');
                const updated = { ...(original || { id: crypto.randomUUID(), task_ref: ref, task_content_snapshot: todo.content,
                    created_at: now, deleted: false, label_snapshot: normalizeLabel(todo.label) }), started_at: new Date(start.value).toISOString(),
                    ended_at: end.value ? new Date(end.value).toISOString() : null, updated_at: new Date().toISOString() };
                await commit(d => {
                    if (!updated.ended_at && !d.time_entries.some(e => e.id === updated.id && !e.deleted && !e.ended_at)) throw new Error('该记录已结束，请填写结束时间');
                    const failure = validateTimeEntry(updated, d.time_entries); if (failure) throw new Error(failure);
                    d.time_entries = [...d.time_entries.filter(e => e.id !== updated.id), updated];
                }); dialog.close(); changed();
            } catch (e) { error.textContent = e.message || String(e); }
        }), button('取消', () => dialog.close()));
    }
    function recordList(host, list, todo, ref) {
        host.replaceChildren();
        for (const entry of [...list].sort((a, b) => Number(!b.ended_at) - Number(!a.ended_at) || b.started_at.localeCompare(a.started_at))) {
            const row = el('div', null, 'learning-record');
            const info = resolvedEntries().find(e => e.id === entry.id);
            row.append(el('div', `${entry.task_content_snapshot} · ${entryLabel(entry)}${info?.task_unavailable ? ' · 原任务不可用' : info?.task_deleted ? ' · 原任务已删除' : ''}`),
                el('div', `${localInput(entry.started_at).replace('T', ' ')} → ${entry.ended_at ? localInput(entry.ended_at).replace('T', ' ') : '进行中'}`));
            if (entry.ended_at) row.append(el('small', formatDuration(Date.parse(entry.ended_at) - Date.parse(entry.started_at))));
            row.append(button('编辑记录', () => editEntry(entry, todo, ref, () => recordList(host, list.map(e => entries().find(n => n.id === e.id) || e).filter(e => !e.deleted), todo, ref))),
                button('删除', () => run(async () => { await remove(entry); row.remove(); })));
            host.append(row);
        }
    }
    function showRecords(list, title = '计时记录', todo, ref) {
        const dialog = modal(title); const body = el('div'); dialog.append(body);
        if (todo) {
            const refresh = () => recordList(body, entries().filter(e => !e.deleted && sameTask(e.task_ref, ref)), todo, ref);
            body.before(button('补录计时记录', () => editEntry(null, todo, ref, refresh)));
            dialog.addEventListener('close', () => compactEditor());
        }
        recordList(body, list.map(e => entries().find(raw => raw.id === e.id) || e), todo, ref); dialog.append(button('关闭', () => dialog.close()));
    }
    function editTask(todo) {
        const parent = document.querySelector('#edit-modal .modal-content'); if (!parent) return;
        parent.querySelector('.learning-edit-extra')?.remove();
        const host = el('section', null, 'learning-edit-extra');
        const ref = taskReference(todo, state.activeSource);
        const recordDetails = el('details', null, 'edit-section');
        const recordSummary = el('summary', '计时记录'); recordSummary.id = 'edit-records-summary';
        recordDetails.append(recordSummary,
            button('管理计时记录', () => showRecords(entries().filter(e => !e.deleted && sameTask(e.task_ref, ref)), '计时记录', todo, ref)),
            button('补录计时记录', () => editEntry(null, todo, ref, () => compactEditor())));
        host.append(recordDetails);
        const labelDetails = el('details', null, 'edit-section');
        labelDetails.append(el('summary', '标签：' + (todo.label || '未分类'))); host.append(labelDetails);
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
            picker.append(button('确认', () => { select(normalizeLabel(name.value)); picker.close(); }), button('取消', () => picker.close()));
        }));
        const body = parent.querySelector('.modal-body');
        if (body) body.append(host); else parent.insertBefore(host, parent.querySelector('.modal-footer'));
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
        const checkin = section('edit-checkin-section', [byId('target-count-group'), byId('edit-checkin-grid-group')]);
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
        if (reset) { parent.querySelectorAll('details').forEach(d => { d.open = false; }); subtasks.open = items.length > 0; parent.scrollTop = 0; }
        const todo = state.currentEditingTodo;
        if (todo && byId('edit-records-summary')) {
            const list = entries().filter(e => !e.deleted && sameTask(e.task_ref, taskReference(todo, state.activeSource)));
            const range = learningRange('day', new Date()); const summary = summarizeLearning(resolvedEntries(), range.start, range.end);
            const parts = summary.parts.filter(p => list.some(e => e.id === p.entry.id));
            const conflicts = overlappingEntries(entries());
            byId('edit-records-summary').textContent = '计时记录：今日 ' + formatDuration(parts.reduce((sum, p) => sum + p.duration, 0)) + ' · ' + parts.length + ' 次' + (list.some(e => !e.ended_at) ? ' · 进行中' : '') + (list.some(e => conflicts.has(e.id)) ? ' · 待核对' : '');
        }
        if (!parent.dataset.compactListening) {
            parent.dataset.compactListening = 'true';
            parent.addEventListener('input', () => compactEditor()); parent.addEventListener('change', () => compactEditor());
            parent.addEventListener('click', event => { if (!event.target.closest('summary')) queueMicrotask(() => compactEditor()); });
        }
    }
    async function choices(title, items) {
        return new Promise(resolve => {
            const d = modal(title); items.forEach(([text, value]) => d.append(button(text, () => { resolve(value); d.close(); })));
            d.addEventListener('cancel', e => { e.preventDefault(); resolve('cancel'); d.close(); });
        });
    }
    function editReview(date) {
        const base = data().daily_reviews?.find(r => r.date === date && !r.deleted);
        const dialog = modal(`${date} · ${base ? '编辑复盘' : '写复盘'}`); const inputs = {};
        let savedFields = Object.fromEntries(reviewFields.map(([key]) => [key, base?.[key] || '']));
        for (const [key, title, hint] of reviewFields) {
            const label = el('label', title); const text = el('textarea'); text.rows = 3; text.placeholder = hint; text.value = base?.[key] || '';
            inputs[key] = text; label.append(text); dialog.append(label);
        }
        const error = el('p', '', 'learning-error'); dialog.append(error);
        const dirty = () => reviewFields.some(([key]) => inputs[key].value !== savedFields[key]);
        const save = async () => {
            try {
                const fields = Object.fromEntries(reviewFields.map(([key]) => [key, inputs[key].value]));
                if (!Object.values(fields).some(v => v.trim())) throw new Error('请至少填写一项复盘内容');
                await commit(d => {
                    const existing = d.daily_reviews.find(r => r.date === date); const now = new Date().toISOString();
                    d.daily_reviews = [...d.daily_reviews.filter(r => r.date !== date), { id: existing?.id || crypto.randomUUID(), date,
                        created_at: existing?.created_at || now, updated_at: now, deleted: false, ...fields }];
                }); savedFields = fields; return true;
            } catch (e) { error.textContent = e.message || String(e); return false; }
        };
        const close = () => { reviewLeave = null; dialog.close(); };
        const leave = async () => {
            if (!dirty()) { close(); return true; }
            const answer = await choices('复盘有未保存的修改', [['保存并离开', 'save'], ['放弃修改', 'discard'], ['继续编辑', 'cancel']]);
            if (answer === 'discard' || (answer === 'save' && await save())) { close(); return true; } return false;
        };
        reviewLeave = leave;
        dialog.addEventListener('cancel', e => { e.preventDefault(); void leave(); });
        dialog.append(button('保存', async () => { if (await save()) close(); }), button('取消', close), button('导出', async () => {
            if (dirty()) {
                const answer = await choices('有未保存的复盘修改', [['保存后导出', 'save'], ['仅导出已保存内容', 'saved'], ['取消', 'cancel']]);
                if (answer === 'cancel' || (answer === 'save' && !await save())) return;
            }
            exportDialog('day', new Date(date + 'T12:00:00'));
        }));
    }
    function showReview(review) {
        const d = modal(`${review.date} · 每日复盘`);
        for (const [key, title] of reviewFields) { d.append(el('h4', title), el('p', review[key] || '未填写', 'learning-text')); }
        d.append(button('编辑', () => { d.close(); editReview(review.date); }), button('关闭', () => d.close()));
    }
    function exportDialog(period = state.statsPeriod, target = state.statsTargetDate) {
        const d = modal('导出复盘 Markdown');
        const include = input('checkbox', '', period === 'day' ? '附带当日学习时长统计' : '附带当日学习时长统计（逐日附带）', d); include.checked = true;
        const error = el('p', '', 'learning-error'); d.append(error);
        d.append(button('导出文件', async () => {
            try { const result = exportReviews(data(), period, target, include.checked, knownTasks()); const saved = await exportFile(result); if (saved) { toast('文件已保存'); d.close(); } }
            catch (e) { error.textContent = e.message || String(e); }
        }), button('取消', () => d.close()));
    }
    function renderStats() {
        const host = document.getElementById('learning-insights'); if (!host) return;
        host.replaceChildren(); const { start, end } = learningRange(state.statsPeriod, state.statsTargetDate);
        const learning = el('section', null, 'learning-card'); learning.append(el('h3', '我的学习投入'));
        const filter = el('select');
        const names = [...new Set(resolvedEntries().filter(e => !e.deleted).map(e => normalizeLabel(e.label_snapshot) || '未分类'))].sort();
        if (labelFilter && !names.includes(labelFilter)) labelFilter = '';
        [['', '全部标签'], ...names.map(n => [n, n])].forEach(([v, t]) => { const o = el('option', t); o.value = v; filter.append(o); });
        filter.value = labelFilter || ''; filter.onchange = () => { labelFilter = filter.value; renderStats(); }; learning.append(filter);
        const summary = summarizeLearning(resolvedEntries(), start, end, labelFilter ? normalizeLabel(labelFilter) : undefined);
        learning.append(el('p', `${labelFilter || '全部标签'}：${formatDuration(summary.duration)} · ${summary.count} 次`));
        summary.groups.forEach(g => learning.append(button(`${g.label} · ${formatDuration(g.duration)} · ${g.count} 次`, () => {
            showRecords([...new Map(summary.parts.filter(p => (p.entry.label_snapshot || '未分类') === g.label).map(p => [p.entry.id, p.entry])).values()]);
        })));
        if (summary.running) learning.append(el('p', `${summary.running} 条进行中，尚未计入汇总`));
        if (summary.pending) learning.append(button(`${summary.pending} 条待核对记录未计入 · 查看`, () => showRecords(entries().filter(e => !e.deleted && overlappingEntries(entries()).has(e.id)), '核对计时记录')));
        host.append(learning);
        const review = el('section', null, 'learning-card'); review.append(el('h3', '我的复盘'), button('导出 Markdown', () => exportDialog()));
        const list = (data().daily_reviews || []).filter(r => !r.deleted && r.date >= start && r.date < end).sort((a, b) => b.date.localeCompare(a.date));
        if (state.statsPeriod === 'day') {
            if (list[0]) { for (const [key, title] of reviewFields) review.append(el('h4', title), el('p', list[0][key] || '未填写', 'learning-text')); }
            review.append(button(list.length ? '编辑' : '写复盘', () => editReview(start)));
        } else {
            if (!list.length) review.append(el('p', '这个时间范围还没有复盘'));
            list.forEach(r => { const card = button(`${r.date}\n${reviewPreview(r)}`, () => showReview(r)); card.classList.add('learning-preview'); review.append(card); });
        }
        host.append(review);
    }
    function refresh() {
        refreshLabelPicker?.();
        if (!banner) { banner = el('div', null, 'learning-banner'); document.querySelector('main')?.before(banner); }
        banner.replaceChildren(); const active = running(); banner.hidden = !active.length;
        if (active.length === 1) banner.append(el('span', active[0].task_content_snapshot), clock(active[0]),
            button('结束', () => run(() => stop(active[0].id))), button('记录', () => showRecords(active)));
        if (active.length > 1) {
            banner.append(button(`${active.length} 条计时待处理`, () => showRecords(active, '请补上真实结束时间或删除误开记录')));
            const key = active.map(e => e.id).sort().join('|'); if (lastConflict !== key) { lastConflict = key; showRecords(active, '多条计时正在运行'); }
        } else lastConflict = '';
        if (state.currentView === 'stats') renderStats(); tick();
    }
    function install() {
        const anchor = document.querySelector('.stats-list-toggle-container'); const host = el('div'); host.id = 'learning-insights'; anchor?.before(host);
        setInterval(tick, 1000);
        // 编辑弹窗阻止底层导航；关闭窗口也先处理未保存正文。
        window.addEventListener('beforeunload', e => { if (reviewLeave) { e.preventDefault(); e.returnValue = ''; } });
        window.__TAURI__.window?.getCurrentWindow?.().onCloseRequested(async event => {
            if (reviewLeave) { event.preventDefault(); if (await reviewLeave()) await window.__TAURI__.window.getCurrentWindow().close(); }
        });
    }
    return { install, refresh, attachTimer, editTask, renderStats, compactEditor, resolvedEntries, showRecords };
}
