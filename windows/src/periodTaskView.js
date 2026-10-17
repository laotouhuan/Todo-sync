import { associationPreview, associationSummary, associatePeriods, currentPeriod, deletePreview, deletePeriods, displayTaskName, importCandidates, importPeriods, periodRange, periodType, periodDescription, seriesFor, unlinkPreview, unlinkPeriods } from './taskSeries.js';
import { formatDuration, localDay, overlappingEntries, splitTimeEntry } from './timeTracking.js';
import { comparisonEnd, dailyComparison } from './periodComparison.js';
import { renderDailyComparison } from './periodComparisonView.js';

function node(tag, text) { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
function periodChoiceLabel(period) {
    const range = periodRange(period);
    if (!period.includes('-W')) return `${range.start.getFullYear()}年${range.start.getMonth() + 1}月`;
    const last = new Date(range.end); last.setDate(last.getDate() - 1);
    const end = last.getFullYear() === range.start.getFullYear() ? localDay(last).slice(5) : localDay(last);
    return `${localDay(range.start).replaceAll('-', '/')}—${end.replaceAll('-', '/')}`;
}
function dialog(title) {
    const d = node('dialog'); d.className = 'learning-dialog'; d.dataset.periodDialog = 'true'; d.append(node('h3', title));
    d.addEventListener('keydown', e => e.stopPropagation()); d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
}
function action(host, title, callback) {
    const b = node('button', title); b.type = 'button'; b.className = 'learning-button'; host.append(b);
    b.onclick = async e => { e.stopPropagation(); b.disabled = true; try { await callback(); } catch (error) { let p = host.querySelector('[role="alert"]'); if (!p) { p = node('p'); p.setAttribute('role', 'alert'); host.append(p); } p.textContent = error.message; } finally { b.disabled = false; } }; return b;
}

export function compareSeriesPeriod(data, seriesId, period, end = periodRange(period)?.end) {
    const range = periodRange(period); if (!range) return null;
    const linked = new Set((data.task_series_links || []).filter(l => !l.deleted && l.series_id === seriesId).map(l => l.todo_id));
    const conflicts = overlappingEntries(data.time_entries || []);
    const entries = (data.time_entries || []).filter(e => !e.deleted && e.task_ref?.source_type === 'personal' && e.task_ref.source_id == null && linked.has(e.task_ref.todo_id));
    const parts = entries.filter(e => !conflicts.has(e.id)).flatMap(splitTimeEntry).map(p => {
        const start = Math.max(p.started_at, range.start.getTime());
        const stop = Math.min(p.ended_at, end.getTime());
        return { entry: p.entry, start, end: stop, duration: Math.max(0, stop - start) };
    }).filter(p => p.duration > 0);
    const todos = data.todos.filter(t => linked.has(t.id) && t.date === period && !t.deleted);
    const dates = [...new Set(todos.flatMap(t => t.completed_dates || []).map(v => v.length === 10 ? v : localDay(new Date(v))).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && localDay(new Date(d + 'T12:00:00')) === d && d >= localDay(range.start) && d < localDay(range.end) && d <= localDay(end)))].sort();
    const known = (data.task_series_links || []).some(l => !l.deleted && l.series_id === seriesId && l.period === period);
    return { period, todos, dates, parts, duration: parts.reduce((n, p) => n + p.duration, 0),
        available: todos.length > 0 || parts.length > 0,
        status: todos.length > 1 ? '存在重复任务，打卡待处理' : todos.length ? '' : known ? '该期任务已删除或不可用' : '未导入',
        pending: entries.filter(e => (e.ended_at == null || conflicts.has(e.id)) && Date.parse(e.started_at) < end.getTime() && (e.ended_at == null || Date.parse(e.ended_at) > range.start.getTime())).length };
}

export function createPeriodTaskView({ state, commit, toast, relationSaved = () => {} }) {
    const data = () => state.todoData;
    function closeOthers() { if (state.activeSource.type !== 'personal') document.querySelectorAll('dialog[data-period-dialog]').forEach(d => d.close()); }
    function openImport(type) {
        const target = currentPeriod(type), baseline = importCandidates(data(), type), d = dialog('从往期导入 ' + (type === 'week' ? '周任务' : '月任务'));
        const previousDate = new Date(periodRange(target).start);
        previousDate.setDate(previousDate.getDate() - 1);
        const previous = currentPeriod(type, previousDate);
        let showEarlier = false;
        const search = node('input'); search.type = 'search'; search.placeholder = '搜索任务'; d.append(search);
        const rows = [];
        for (const candidate of baseline) {
            const row = node('section'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.disabled = candidate.exists || !candidate.todo; checkbox.checked = !checkbox.disabled && candidate.todo.date === previous;
            row.append(checkbox, node('span', candidate.content + (candidate.exists ? ' · 本期已存在' : '')));
            if (seriesFor(data(), candidate.choices[0].todo.id)) {
                const hint = node('p', '长期任务 · 导入后自动关联'); hint.className = 'period-help'; row.append(hint);
            }
            const select = node('select'); select.setAttribute('aria-label', candidate.content + '的参考期');
            select.append(new Option('选择参考期', ''));
            const options = candidate.choices.map(choice => {
                const option = new Option(`${periodDescription(choice.todo.date)} · 目标 ${choice.todo.target_count ?? '未设置'}${choice.duplicate ? ' · 重复，不可使用' : ''}`, choice.todo.id);
                option.disabled = choice.duplicate;
                select.append(option);
                return { option, period: choice.todo.date };
            });
            select.value = candidate.todo?.id || ''; select.disabled = candidate.exists;
            select.onchange = () => { checkbox.disabled = candidate.exists || !select.value; checkbox.checked = !checkbox.disabled; };
            row.append(select);
            const matches = data().todos.filter(t => !t.deleted && t.date === target && !seriesFor(data(), t.id) && t.content.trim().normalize('NFC') === candidate.content.trim().normalize('NFC'));
            if (matches.length) row.append(node('small', '本期已有同名独立任务，可通过周期关联核对；仍可导入不同任务。'));
            d.append(row); rows.push({ row, checkbox, select, candidate, options });
        }
        const empty = node('p'); d.append(empty);
        function refreshCandidates() {
            for (const r of rows) {
                const inScope = showEarlier || r.candidate.choices.some(c => c.todo.date === previous);
                r.row.hidden = !inScope || !r.candidate.content.includes(search.value.trim());
                for (const { option, period } of r.options) option.hidden = !showEarlier && period !== previous;
            }
            empty.hidden = rows.some(r => !r.row.hidden);
            if (search.value.trim()) empty.textContent = '没有匹配的任务';
            else if (showEarlier) empty.textContent = '暂无可导入的往期任务';
            else empty.textContent = '上一期暂无可导入的任务';
        }
        if (baseline.some(c => c.choices.some(choice => choice.todo.date < previous))) {
            const more = action(d, '显示更早期任务', () => {
                showEarlier = true;
                more.hidden = true;
                refreshCandidates();
            });
        }
        search.oninput = refreshCandidates;
        refreshCandidates();
        let references, operationTime, allocated = [];
        action(d, '导入选中项', async () => {
            const selected = rows.filter(r => r.checkbox.checked && !r.checkbox.disabled).map(r => r.candidate.choices.find(c => c.todo.id === r.select.value)?.todo).filter(Boolean);
            if (!selected.length) return;
            if (!references || JSON.stringify(references) !== JSON.stringify(selected)) { references = selected; allocated = []; operationTime = new Date().toISOString(); }
            await commit(latest => {
                if (currentPeriod(type) !== target) throw new Error('当前周期已变化，请重新打开');
                let index = 0;
                return importPeriods(latest, references, target, operationTime, () => {
                    if (!allocated[index]) allocated[index] = crypto.randomUUID();
                    return allocated[index++];
                });
            }); d.close();
        }); action(d, '取消', () => d.close());
    }
    function associations(todoId) {
        const reservedId = crypto.randomUUID();
        const d = dialog('周期关联'), todo = data().todos.find(t => t.id === todoId), type = periodType(todo), chosen = new Set([todoId]);
        d.classList.add('period-association');
        const summary = associationSummary(data(), todoId), kind = type === 'week' ? '周任务' : '月任务';
        const overview = node('section'); overview.className = 'period-association-overview';
        overview.append(node('h4', `${summary.series ? '长期' : '独立'}${kind} · ${displayTaskName(data(), todoId)}`));
        if (summary.series) {
            action(overview, `始于 ${localDay(periodRange(summary.periods[0]).start)} · 共 ${summary.periods.length} 期 ›`, () => {
                const history = dialog('已关联周期'); history.classList.add('period-history');
                const list = node('ul'); list.className = 'period-history-list'; history.append(list);
                for (const period of summary.periods.slice().reverse()) {
                    const available = data().todos.some(t => !t.deleted && t.date === period && seriesFor(data(), t.id)?.id === summary.series.id);
                    const range = periodRange(period), last = new Date(range.end); last.setDate(last.getDate() - 1);
                    const row = node('li'); row.className = 'period-history-row';
                    const dates = node('span'); dates.className = 'period-history-dates';
                    dates.append(node('span', localDay(range.start)), node('span', '—'), node('wbr'), node('span', localDay(last)));
                    row.append(node('span', period), dates, node('span', period === todo.date ? '本期' : ''));
                    if (!available) { const note = node('small', '任务已删除或不可用'); note.className = 'period-history-note'; row.append(note); }
                    list.append(row);
                }
                action(history, '关闭', () => history.close());
            }).classList.add('period-text-button');
        } else overview.append(node('p', '尚未关联往期任务'));
        let status = `暂无其他同名${kind}`;
        if (summary.unlinkedSameName.length) status = `还有 ${summary.unlinkedSameName.length} 个同名${kind}未关联`;
        else if (summary.sameNameCount) status = `✓ 已关联全部同名${kind}`;
        const statusLine = node('p', status); statusLine.className = 'period-help'; overview.append(statusLine); d.append(overview);
        const preview = selected => {
            const p = associationPreview(data(), todoId, selected), confirm = dialog('确认周期关联');
            confirm.append(node('p', `统一名称：${p.name}；${p.members.length} 条任务，${new Set(p.members.map(t => t.date)).size} 个周期。`));
            const targetId = seriesFor(data(), todoId)?.id;
            const existing = p.members.filter(t => targetId && seriesFor(data(), t.id)?.id === targetId).length;
            confirm.append(node('p', `已关联 ${existing} 条，本次新增关联 ${p.members.length - existing} 条（总数包含当前任务）。`));
            for (const t of p.members.slice().sort((a,b) => b.date.localeCompare(a.date))) confirm.append(node('p', `${periodDescription(t.date)} · ${displayTaskName(data(), t.id)}${p.duplicates.some(v => v.id === t.id) ? ' · 重复' : ''}`));
            const historic = p.links.filter(l => !p.members.some(t => t.id === l.todo_id));
            if (historic.length) confirm.append(node('p', `另有 ${historic.length} 条历史关联将随系列迁移：${historic.map(l => l.period).join('、')}`));
            const noChange = p.members.every(t => seriesFor(data(), t.id)?.id === seriesFor(data(), todoId)?.id) && !!seriesFor(data(), todoId);
            if (p.duplicates.length || p.members.length < 2 || noChange) confirm.append(node('p', p.duplicates.length ? '同一周期存在重复任务，暂不能合并' : '没有需要新增的关联'));
            else action(confirm, '确认关联，各期记录保留', async () => { await commit(latest => associatePeriods(latest, p, selected, new Date().toISOString(), () => reservedId)); relationSaved(); confirm.close(); d.close(); toast('关联已保存，其他编辑草稿已保留'); });
            action(confirm, '取消', () => confirm.close());
        };
        const actions = node('div'); actions.className = 'period-association-actions'; d.append(actions);
        if (summary.unlinkedSameName.length) action(actions, '关联同名任务', () => preview(null));
        const picker = node('section'); picker.hidden = true; d.append(picker);
        action(actions, '关联其他任务', () => {
            if (picker.childElementCount) { picker.hidden = !picker.hidden; return; }
            picker.hidden = false;
            const search = node('input'); search.type = 'search'; search.placeholder = '搜索往期任务'; search.setAttribute('aria-label', '搜索往期任务'); picker.append(search);
            const previousDate = new Date(periodRange(todo.date).start); previousDate.setDate(previousDate.getDate() - 1);
            const previous = currentPeriod(type, previousDate);
            const candidates = data().todos.filter(t => t.id !== todoId && !t.deleted && periodType(t) === type && periodRange(t.date)
                && !seriesFor(data(), t.id)?.deleted && (!summary.series || seriesFor(data(), t.id)?.id !== summary.series.id)).sort((a, b) => b.date.localeCompare(a.date));
            const rows = [];
            for (const candidate of candidates) {
                const row = node('label'), check = node('input'); row.className = 'period-association-choice'; check.type = 'checkbox';
                row.append(check, node('span', `${displayTaskName(data(), candidate.id)} · ${candidate.date}`));
                check.onchange = () => { if (check.checked) chosen.add(candidate.id); else chosen.delete(candidate.id); };
                picker.append(row); rows.push({ row, candidate });
            }
            let showEarlier = false;
            const empty = node('p', '没有可选任务'); empty.className = 'period-help'; picker.append(empty);
            const refresh = () => {
                rows.forEach(({ row, candidate }) => { row.hidden = (!showEarlier && !search.value.trim() && candidate.date < previous) || !displayTaskName(data(), candidate.id).includes(search.value.trim()); });
                empty.hidden = rows.some(({ row }) => !row.hidden);
            };
            if (candidates.some(t => t.date < previous)) {
                const more = action(picker, '显示更早期任务', () => { showEarlier = true; more.hidden = true; refresh(); });
            }
            search.oninput = refresh; refresh();
            action(picker, '预览选中任务', () => preview([...chosen]));
        });
        const footer = node('div'); footer.className = 'period-association-footer'; d.append(footer);
        if (summary.series) action(footer, '解除关联', () => {
            const confirm = dialog('解除关联'), select = node('select');
            select.setAttribute('aria-label', '解除范围');
            select.append(new Option('仅解除本期', 'one'), new Option('解除整个长期任务的关联', 'all'));
            const description = node('p'); confirm.append(select, description, node('p', '仅解除关联，保留任务、打卡和计时记录。'));
            let expected;
            const refresh = () => {
                expected = unlinkPreview(data(), todoId, select.value === 'all');
                description.textContent = select.value === 'all' ? `共 ${new Set(expected.links.map(l => l.period)).size} 期将各自独立，并恢复各期自身名称。` : '本期将独立并恢复自身名称，其余各期继续关联。';
            };
            select.onchange = refresh; refresh(); const allocated = [];
            action(confirm, '确认解除', async () => {
                const confirmed = expected;
                await commit(latest => {
                    let index = 0;
                    return unlinkPeriods(latest, confirmed, new Date().toISOString(), () => {
                        if (!allocated[index]) allocated[index] = crypto.randomUUID();
                        return allocated[index++];
                    });
                });
                relationSaved(); confirm.close(); d.close(); toast('关联已解除，任务和记录已保留');
            }); action(confirm, '取消', () => confirm.close());
        });
        action(footer, '关闭', () => d.close());
    }
    function compare(todoId) {
        const series = seriesFor(data(), todoId); if (!series) return;
        const todo = data().todos.find(t => t.id === todoId), range = periodRange(todo.date), previous = new Date(range.start); previous.setDate(previous.getDate() - 1);
        const periods = [...new Set([todo.date, currentPeriod(series.period_type, previous), ...(data().task_series_links || []).filter(l => !l.deleted && l.series_id === series.id).map(l => l.period)])].filter(period => periodRange(period)).sort().reverse();
        const d = dialog(series.content + ' · 往期对比'); d.classList.add('period-comparison');
        const help = node('p', '按已保存记录比较；编辑页未保存修改不计入。'); help.className = 'period-help'; d.append(help);
        const a = node('select'), b = node('select');
        for (const period of periods) { a.append(new Option(periodChoiceLabel(period), period)); b.append(new Option(periodChoiceLabel(period), period)); }
        a.value = todo.date; b.value = currentPeriod(series.period_type, previous);
        const fields = node('div'); fields.className = 'period-comparison-fields';
        for (const [title, select] of [['查看周期', a], ['对比周期', b]]) {
            const label = node('label', title); label.append(select); fields.append(label);
        }
        let sameProgress = range.end > new Date(), selectedDay = 0;
        const modes = node('div'); modes.className = 'period-comparison-modes'; modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '比较范围');
        const sameButton = action(modes, '截至相同进度', () => { sameProgress = true; render(); });
        const fullButton = action(modes, '整个周期', () => { sameProgress = false; render(); });
        d.append(fields, modes); const body = node('div'); d.append(body);
        function render() {
            body.replaceChildren(); const now = new Date(), current = [a.value, b.value].some(p => { const r = periodRange(p); return now >= r.start && now < r.end; });
            sameButton.setAttribute('aria-pressed', String(sameProgress)); fullButton.setAttribute('aria-pressed', String(!sameProgress));
            const cutoff = node('p'); cutoff.className = 'period-help';
            if (!current) cutoff.textContent = '所选周期不含当前周期，按各期已有记录比较。';
            else if (sameProgress) cutoff.textContent = `两期均截至${series.period_type === 'week' ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()] : now.getDate() + '日'} ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}；打卡按日期比较。`;
            else cutoff.textContent = '当前周期尚未结束；对比期包含整个周期的已有记录。';
            body.append(cutoff);
            const comparisons = [a.value, b.value].map(period => {
                const end = comparisonEnd(period, sameProgress, current, now);
                const result = compareSeriesPeriod(data(), series.id, period, end);
                return { period, end, result, days: dailyComparison(result, period, end, now) };
            });
            const summaries = node('div'); summaries.className = 'period-comparison-summaries';
            comparisons.forEach(({ period, result }, index) => {
                const summary = node('div'); summary.className = 'period-summary';
                summary.append(node('h4', `${index ? '对比' : '查看'} · ${period}`));
                const duration = node('p', result.available ? formatDuration(result.duration) : '—'); duration.className = 'period-total'; summary.append(duration);
                const task = result.todos.length === 1 ? result.todos[0] : null;
                let checkins = `打卡 ${task ? result.dates.length : '—'} / ${task?.target_count ?? '未设目标'}`;
                if (task?.target_count > 0) checkins += ` · ${Math.round(result.dates.length * 100 / task.target_count)}% · ${result.dates.length >= task.target_count ? '已达标' : '未达标'}`;
                summary.append(node('p', checkins));
                if (result.status) summary.append(node('p', result.status));
                if (result.pending) summary.append(node('p', `${result.pending} 条进行中／待核对未计入`));
                summaries.append(summary);
            });
            body.append(summaries);
            const results = comparisons.map(c => c.result);
            const delta = results[0].duration - results[1].duration;
            let durationDifference = '时长差值 —';
            if (results.every(r => r.available)) durationDifference = delta === 0 ? '总时长相同' : `时长${delta < 0 ? '少' : '多'} ${formatDuration(Math.abs(delta))}`;
            const difference = node('p', `${durationDifference} · 打卡差值 ${results.every(r => r.todos.length === 1) ? results[0].dates.length - results[1].dates.length : '—'}`);
            difference.className = 'period-comparison-delta'; body.append(difference);
            renderDailyComparison(body, comparisons, series.period_type, selectedDay, index => { selectedDay = index; });
        }
        a.onchange = render; b.onchange = render; render(); action(d, '关闭', () => d.close());
    }
    function remove(todoId, done = () => {}) {
        const d = dialog('删除“' + displayTaskName(data(), todoId) + '”'), select = node('select');
        select.append(new Option('仅删除这一期', 'one')); if (seriesFor(data(), todoId)) select.append(new Option('删除全部周期', 'all'));
        d.append(select); const description = node('div'); d.append(description); let preview;
        function refresh() { preview = deletePreview(data(), todoId, select.value === 'all'); description.replaceChildren(node('p', `${preview.todos.length} 条任务，${new Set(preview.todos.map(t => t.date)).size} 个周期。历史计时记录将保留。`)); for (const t of preview.todos) description.append(node('p', t.date ? periodDescription(t.date) : '无日期')); if (preview.running.length) description.append(node('p', `确认后将结束以上任务的 ${preview.running.length} 条计时：${preview.running.map(e => displayTaskName(data(), e.task_ref.todo_id)).join('、')}`)); }
        select.onchange = refresh; refresh(); action(d, '确认删除', async () => { await commit(latest => deletePeriods(latest, preview)); d.close(); done(); }); action(d, '取消', () => d.close());
    }
    return { openImport, associations, compare, remove, refresh: closeOthers };
}
