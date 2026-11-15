import { createTodo, getISOWeekString, sortFunc, formatDate } from './dateUtils.js';

const uuid = () => crypto.randomUUID();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validTime = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const validId = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
export const normalizedTaskName = value => (value || '').trim().normalize('NFC');

export function periodType(todo) {
    if (todo?.task_type === 'weekly_checkin' && /^\d{4}-W\d{2}$/.test(todo.date || '')) return 'week';
    if (todo?.task_type === 'monthly_checkin' && /^\d{4}-\d{2}$/.test(todo.date || '')) return 'month';
    return null;
}

export function currentPeriod(type, now = new Date()) {
    return type === 'week' ? getISOWeekString(now) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function periodRange(period) {
    let start, end;
    if (/^\d{4}-W\d{2}$/.test(period || '')) {
        const year = Number(period.slice(0, 4)), week = Number(period.slice(6));
        start = new Date(year, 0, 4); start.setDate(start.getDate() - (start.getDay() + 6) % 7 + (week - 1) * 7);
        if (week < 1 || week > 53 || getISOWeekString(start) !== period) return null;
        end = new Date(start); end.setDate(end.getDate() + 7);
    } else if (/^\d{4}-\d{2}$/.test(period || '')) {
        const year = Number(period.slice(0, 4)), month = Number(period.slice(5));
        if (month < 1 || month > 12) return null;
        start = new Date(year, month - 1, 1); end = new Date(year, month, 1);
    } else return null;
    return { start, end };
}

export function normalizeSeriesData(data) {
    if (data.task_series === undefined) data.task_series = [];
    if (data.task_series_links === undefined) data.task_series_links = [];
    if (!Array.isArray(data.task_series) || !Array.isArray(data.task_series_links)) throw new Error('周期关联数据异常，请核对原文件或恢复备份');
    const ids = new Set(), links = new Set();
    for (const s of data.task_series) {
        if (s.deleted === undefined) s.deleted = false;
        if (s.deleted_at === undefined) s.deleted_at = null;
        if (s.content_renamed === undefined) s.content_renamed = false;
        if (!validId(s.id) || ids.has(s.id) || !normalizedTaskName(s.content) || !['week', 'month'].includes(s.period_type)
            || ![s.created_at, s.updated_at, s.content_updated_at].every(validTime) || typeof s.content_renamed !== 'boolean'
            || typeof s.deleted !== 'boolean' || (s.deleted_at !== null && !validTime(s.deleted_at)) || (s.deleted && s.deleted_at === null)) throw new Error('任务系列格式异常，请核对原文件');
        ids.add(s.id);
    }
    for (const l of data.task_series_links) {
        if (l.deleted === undefined) l.deleted = false;
        if (l.next_series_id === undefined) l.next_series_id = null;
        if (!validId(l.todo_id) || !validId(l.series_id) || links.has(l.todo_id) || !periodRange(l.period)
            || ![l.created_at, l.updated_at].every(validTime) || typeof l.deleted !== 'boolean'
            || (l.deleted ? !validId(l.next_series_id) : l.next_series_id !== null)) throw new Error('周期关联格式异常，请核对原文件');
        links.add(l.todo_id);
    }
    return data;
}

function stable(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return JSON.stringify(value);
}

export function mergeSeriesData(first, second) {
    normalizeSeriesData(first); normalizeSeriesData(second);
    const series = new Map(), links = new Map();
    for (const s of [...first.task_series, ...second.task_series]) {
        const old = series.get(s.id);
        if (!old) { series.set(s.id, structuredClone(s)); continue; }
        if (old.period_type !== s.period_type) throw new Error('同一任务系列的周期类型冲突，请核对');
        const nameKey = v => [Number(v.content_renamed), Date.parse(v.content_updated_at), normalizedTaskName(v.content), v.content, v.content_updated_at];
        const a = nameKey(old), b = nameKey(s);
        let name = old;
        for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { name = a[i] > b[i] ? old : s; break; } }
        const base = Date.parse(old.updated_at) > Date.parse(s.updated_at) || (Date.parse(old.updated_at) === Date.parse(s.updated_at) && stable(old) > stable(s)) ? old : s;
        const deletedTimes = [old, s].filter(v => v.deleted).map(v => v.deleted_at).sort((a, b) => Date.parse(a) - Date.parse(b) || (a < b ? -1 : 1));
        series.set(s.id, { ...base, content: name.content, content_renamed: name.content_renamed, content_updated_at: name.content_updated_at,
            created_at: [old.created_at, s.created_at].sort((a, b) => Date.parse(a) - Date.parse(b) || (a < b ? -1 : 1))[0],
            updated_at: [old.updated_at, s.updated_at].sort((a,b) => Date.parse(b) - Date.parse(a) || (a > b ? -1 : 1))[0],
            deleted: old.deleted || s.deleted, deleted_at: deletedTimes[0] || null });
    }
    for (const l of [...first.task_series_links, ...second.task_series_links]) {
        const old = links.get(l.todo_id);
        if (!old || Date.parse(l.updated_at) > Date.parse(old.updated_at) || (Date.parse(l.updated_at) === Date.parse(old.updated_at)
            && (Number(l.deleted) > Number(old.deleted) || (l.deleted === old.deleted && stable(l) > stable(old))))) links.set(l.todo_id, structuredClone(l));
    }
    return { task_series: [...series.values()].sort((a, b) => a.id < b.id ? -1 : 1), task_series_links: [...links.values()].sort((a, b) => a.todo_id < b.todo_id ? -1 : 1) };
}

export function seriesFor(data, todoId) {
    const link = data?.task_series_links?.find(l => l.todo_id === todoId && !l.deleted);
    const series = link && data.task_series?.find(s => s.id === link.series_id);
    const todo = data?.todos?.find(t => t.id === todoId);
    if (!series || (todo && (periodType(todo) !== series.period_type || !periodRange(todo.date)))) return null;
    return series;
}

export function isSeriesDeleted(data, todoId) {
    const link = data?.task_series_links?.find(l => l.todo_id === todoId && !l.deleted);
    return !!(link && data.task_series?.find(s => s.id === link.series_id)?.deleted);
}

export function displayTaskName(data, todoId, snapshot = '') {
    return seriesFor(data, todoId)?.content || data?.todos?.find(t => t.id === todoId)?.content || snapshot || '未命名任务';
}

export function visibleSeriesTodos(data) {
    return data.todos.filter(t => !isSeriesDeleted(data, t.id)).map(t => ({ ...t, content: displayTaskName(data, t.id) }));
}

export function timingPendingReason(data, entry) {
    if (entry.deleted || entry.ended_at != null || (entry.task_ref?.source_type || 'personal') !== 'personal' || entry.task_ref?.source_id != null) return '';
    const todo = data.todos.find(t => t.id === entry.task_ref?.todo_id);
    if (todo?.deleted || isSeriesDeleted(data, entry.task_ref?.todo_id)) return '任务已删除，结束时间待核对';
    return todo ? '' : '原任务不可用，结束时间待核对';
}

function identity(data, todo, now, generate) {
    const link = data.task_series_links.find(l => l.todo_id === todo.id);
    if (link && !link.deleted) {
        const s = seriesFor(data, todo.id);
        if (!s || s.deleted) throw new Error('关联已变化或系列已删除，请重新核对');
        return s.id;
    }
    if (link?.deleted) return link.next_series_id;
    return data.task_series.some(s => s.id === todo.id) ? generate() : todo.id;
}

function ensureSeries(data, todo, id, now) {
    let s = data.task_series.find(s => s.id === id);
    if (s?.deleted) throw new Error('长期任务已删除');
    if (!s) {
        s = { id, content: todo.content, content_renamed: false, content_updated_at: validTime(todo.created_at) ? todo.created_at : now,
            period_type: periodType(todo), created_at: now, updated_at: now, deleted: false, deleted_at: null };
        data.task_series.push(s);
    }
    return s;
}

function setLink(data, todo, seriesId, now) {
    const previous = data.task_series_links.find(l => l.todo_id === todo.id);
    if (previous && !previous.deleted && previous.series_id === seriesId && previous.period === todo.date) return;
    data.task_series_links = data.task_series_links.filter(l => l.todo_id !== todo.id);
    data.task_series_links.push({ todo_id: todo.id, series_id: seriesId, period: todo.date, created_at: previous?.created_at || now, updated_at: now, deleted: false, next_series_id: null });
}

export function periodMembers(data, seriesId, period) {
    return data.todos.filter(t => !t.deleted && seriesFor(data, t.id)?.id === seriesId && (!period || t.date === period));
}

export function importCandidates(data, type, now = new Date()) {
    const target = currentPeriod(type, now), groups = new Map();
    for (const todo of data.todos) {
        if (todo.deleted || periodType(todo) !== type || !periodRange(todo.date) || todo.date >= target || seriesFor(data, todo.id)?.deleted) continue;
        const key = seriesFor(data, todo.id)?.id || todo.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(todo);
    }
    return [...groups.entries()].map(([key, todos]) => {
        todos.sort((a, b) => b.date.localeCompare(a.date) || sortFunc(a, b));
        const choices = todos.map(todo => ({ todo, duplicate: todos.filter(t => t.date === todo.date).length > 1 }));
        return { key, choices, todo: choices[0].duplicate ? null : choices[0].todo,
            exists: periodMembers(data, key, target).length > 0, content: displayTaskName(data, todos[0].id) };
    }).sort((a, b) => b.choices[0].todo.date.localeCompare(a.choices[0].todo.date) || sortFunc(a.choices[0].todo, b.choices[0].todo));
}

export function importPeriods(original, references, target, now = new Date().toISOString(), generate = uuid) {
    return importPeriodsAt(original, references, target, now, generate, type => currentPeriod(type, new Date(now)));
}

// 周期由调用者的日历确定；重放可用记录中的固定日期和身份。
export function importPeriodsAt(original, references, target, now, generate, periodAtAction) {
    const data = normalizeSeriesData(structuredClone(original)), used = new Set();
    for (const [index, reference] of references.entries()) {
        const source = data.todos.find(t => t.id === reference.id);
        if (!source || source.deleted || !same(source, reference) || !periodType(source) || !periodRange(source.date)
            || target !== periodAtAction(periodType(source)) || source.date >= target) throw new Error('参考任务或周期已变化，请重新选择');
        const id = identity(data, source, now, generate), series = ensureSeries(data, source, id, now);
        if (used.has(id) || periodMembers(data, id, target).length || periodMembers(data, id, source.date).length > 1) throw new Error('本期已存在或参考期重复，请重新选择');
        used.add(id); setLink(data, source, id, now);
        const todo = { ...createTodo(series.content, target, [], { id: generate(), at: now }), task_type: source.task_type, time: source.time ?? null,
            label: source.label ?? null, target_count: source.target_count ?? null, reminder: null,
            subtasks: (source.subtasks || []).map(s => ({ ...s, id: generate(), completed: false, completed_at: null })),
            created_at: now, updated_at: now, order: Date.parse(now) + index * 1000 };
        data.todos.push(todo); setLink(data, todo, id, now);
    }
    return data;
}

export function associationPreview(data, todoId, selectedIds = null) {
    const todo = data.todos.find(t => t.id === todoId);
    if (!todo || todo.deleted || !periodType(todo) || seriesFor(data, todoId)?.deleted) throw new Error('任务已变化');
    const ids = new Set([todoId, ...(selectedIds || data.todos.filter(t => normalizedTaskName(displayTaskName(data, t.id)) === normalizedTaskName(displayTaskName(data, todoId))).map(t => t.id))]);
    const candidates = data.todos.filter(t => ids.has(t.id) && !t.deleted && periodType(t) === periodType(todo) && !seriesFor(data, t.id)?.deleted && periodRange(t.date));
    const seriesIds = new Set(candidates.map(t => seriesFor(data, t.id)?.id).filter(Boolean));
    const links = (data.task_series_links || []).filter(l => !l.deleted && seriesIds.has(l.series_id));
    links.forEach(l => ids.add(l.todo_id));
    const members = data.todos.filter(t => ids.has(t.id) && !t.deleted && periodType(t) === periodType(todo) && periodRange(t.date));
    const duplicates = members.filter(t => members.filter(m => m.date === t.date).length > 1);
    return { todoId, name: displayTaskName(data, todoId), members, links, duplicates,
        signature: stable({ name: displayTaskName(data, todoId), members: members.map(t => [t.id, t.date, seriesFor(data, t.id)?.id || null]).sort(), links: links.slice().sort((a, b) => a.todo_id.localeCompare(b.todo_id)) }) };
}

export function associatePeriods(original, preview, selectedIds = null, now = new Date().toISOString(), generate = uuid) {
    const data = normalizeSeriesData(structuredClone(original)), latest = associationPreview(data, preview.todoId, selectedIds);
    if (latest.signature !== preview.signature) throw new Error('关联范围已变化，请重新预览');
    if (latest.duplicates.length) throw new Error('同一周期存在重复任务，暂不能合并');
    const todo = data.todos.find(t => t.id === preview.todoId), id = identity(data, todo, now, generate);
    ensureSeries(data, todo, id, now);
    for (const member of latest.members) setLink(data, member, id, now);
    for (const old of latest.links) {
        const current = data.task_series_links.find(l => l.todo_id === old.todo_id);
        if (current.series_id !== id) { current.series_id = id; current.updated_at = now; }
    }
    return data;
}

export function unlinkPeriod(data, todoId, now = new Date().toISOString(), generate = uuid) {
    const link = data.task_series_links?.find(l => l.todo_id === todoId);
    if (link && !link.deleted) { link.deleted = true; link.updated_at = now; link.next_series_id = generate(); }
}

export function associationSummary(data, todoId) {
    const todo = data.todos.find(t => t.id === todoId);
    const series = seriesFor(data, todoId);
    const periods = series ? [...new Set(data.task_series_links.filter(l => !l.deleted && l.series_id === series.id)
        .map(l => l.period).filter(p => periodRange(p)))].sort() : [];
    const sameName = data.todos.filter(t => t.id !== todoId && !t.deleted && periodType(t) === periodType(todo)
        && periodRange(t.date) && !seriesFor(data, t.id)?.deleted
        && normalizedTaskName(displayTaskName(data, t.id)) === normalizedTaskName(displayTaskName(data, todoId)));
    return { series, periods, sameNameCount: sameName.length,
        unlinkedSameName: sameName.filter(t => !series || seriesFor(data, t.id)?.id !== series.id) };
}

export function unlinkPreview(data, todoId, all = false) {
    const series = seriesFor(data, todoId);
    if (!series || series.deleted) throw new Error('关联已变化，请重新打开');
    const links = data.task_series_links.filter(l => !l.deleted && l.series_id === series.id && (all || l.todo_id === todoId));
    return { todoId, all, links, signature: stable({ series, links: links.slice().sort((a, b) => a.todo_id.localeCompare(b.todo_id)) }) };
}

export function unlinkPeriods(original, preview, now = new Date().toISOString(), generate = uuid) {
    const latest = unlinkPreview(original, preview.todoId, preview.all);
    if (latest.signature !== preview.signature) throw new Error('关联范围已变化，请重新确认');
    const data = normalizeSeriesData(structuredClone(original));
    // 历史任务已清理时也保留解除标记，避免同步后重新归入原长期任务。
    for (const link of latest.links.slice().sort((a, b) => a.todo_id.localeCompare(b.todo_id))) unlinkPeriod(data, link.todo_id, now, generate);
    return data;
}

export function deletePreview(data, todoId, all = false) {
    const s = seriesFor(data, todoId);
    const todos = all && s ? periodMembers(data, s.id) : data.todos.filter(t => t.id === todoId && !t.deleted);
    const ids = new Set(todos.map(t => t.id));
    const running = (data.time_entries || []).filter(e => !e.deleted && e.ended_at == null && e.task_ref?.source_type === 'personal' && e.task_ref.source_id == null && ids.has(e.task_ref.todo_id));
    return { todoId, all, seriesId: s?.id, todos, running,
        signature: stable({ series: s, members: todos.map(t => [t.id, t.date]).sort() }) };
}

export function deletePeriods(original, preview, now = new Date().toISOString()) {
    const data = normalizeSeriesData(structuredClone(original)), latest = deletePreview(data, preview.todoId, preview.all);
    if (latest.signature !== preview.signature) throw new Error('删除范围已变化，请重新确认');
    const ids = new Set(latest.todos.map(t => t.id)), confirmed = new Set(preview.running.map(e => e.id));
    data.todos = data.todos.map(t => ids.has(t.id) ? { ...t, deleted: true, updated_at: now } : t);
    if (preview.all && latest.seriesId) { const s = data.task_series.find(s => s.id === latest.seriesId); s.deleted = true; s.deleted_at = now; s.updated_at = now; }
    data.time_entries = (data.time_entries || []).map(e => {
        if (!confirmed.has(e.id) || e.deleted || e.ended_at != null) return e;
        if (!validTime(e.started_at) || Date.parse(e.started_at) >= Date.parse(now)) return e;
        return { ...e, ended_at: now, updated_at: now };
    });
    return data;
}

export function savePeriodEdit(original, baseline, draft, seriesBaseline, now = new Date().toISOString(), baselineLinks = null) {
    const data = normalizeSeriesData(structuredClone(original)), latest = data.todos.find(t => t.id === baseline.id);
    const series = seriesFor(data, baseline.id);
    if (!latest || latest.deleted || series?.deleted) throw new Error('任务已删除，草稿已保留');
    if (series?.id !== seriesBaseline?.id) throw new Error('周期关联已变化，请复制草稿后重新打开');
    const nameChanged = draft.content !== baseline.content;
    if (nameChanged && series && baselineLinks && !same(data.task_series_links.filter(l => !l.deleted && l.series_id === series.id).sort((a,b) => a.todo_id.localeCompare(b.todo_id)), baselineLinks.filter(l => !l.deleted && l.series_id === series.id).sort((a,b) => a.todo_id.localeCompare(b.todo_id)))) throw new Error('系列成员已变化，请保留草稿并重新核对');
    if (nameChanged && series && !same(series, seriesBaseline)) throw new Error('系列名称或范围已变化，请重新核对');
    let changed = false;
    for (const key of Object.keys(draft)) {
        if (['id', 'created_at', 'updated_at', 'deleted'].includes(key) || same(draft[key], baseline[key])) continue;
        if (key === 'content' && series) { series.content = draft.content; series.content_renamed = true; series.content_updated_at = now; series.updated_at = now; continue; }
        if (!same(latest[key], baseline[key]) && !same(latest[key], draft[key])) throw new Error(`${key} 已在其他端变化，请核对；草稿已保留`);
        latest[key] = structuredClone(draft[key]); changed = true;
    }
    if (series && periodType(latest) !== series.period_type) unlinkPeriod(data, latest.id, now);
    else if (series) {
        if (latest.date !== baseline.date && periodMembers(data, series.id, latest.date).length > 1) throw new Error('目标周期已有同系列任务');
        const link = data.task_series_links.find(l => l.todo_id === latest.id);
        if (link.period !== latest.date) { link.period = latest.date; link.updated_at = now; }
    }
    if (changed) latest.updated_at = now;
    return data;
}

export function duplicateTimingSeries(data, now = new Date()) {
    return (data.task_series || []).filter(s => !s.deleted && periodMembers(data, s.id, currentPeriod(s.period_type, now)).length > 1);
}

export function periodDescription(period) {
    const range = periodRange(period); if (!range) return period || '';
    const last = new Date(range.end); last.setDate(last.getDate() - 1);
    return `${period} · ${formatDate(range.start)}—${formatDate(last)}`;
}
