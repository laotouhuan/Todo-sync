// 学习记录的纯逻辑；按设备本地自然日统计。
export function normalizeLabel(value) {
    const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
    return text && text !== '未分类' ? text : null;
}

export function availableLabels(todos) {
    return [...new Set(todos.filter(t => !t.deleted).map(t => normalizeLabel(t.label)).filter(Boolean))].sort();
}

export function taskKey(ref) {
    return JSON.stringify([ref?.source_type || 'personal', ref?.source_id ?? null, ref?.todo_id]);
}

// 返回仅供显示和统计的副本，绝不回写历史快照。
export function resolveLearningEntries(entries, tasks) {
    const byTask = new Map(tasks.map(({ todo, ref }) => [taskKey(ref), todo]));
    const latest = new Map();
    for (const e of entries) {
        const key = taskKey(e.task_ref), old = latest.get(key);
        const time = Date.parse(e.updated_at || e.created_at) || 0;
        const previous = old ? Date.parse(old.updated_at || old.created_at) || 0 : -Infinity;
        if (!old || time > previous || (time === previous && e.id > old.id)) latest.set(key, e);
    }
    return entries.map(e => {
        const key = taskKey(e.task_ref), todo = byTask.get(key);
        return { ...e, label_snapshot: normalizeLabel(todo ? todo.label : latest.get(key)?.label_snapshot),
            task_unavailable: !todo, task_deleted: !!todo?.deleted };
    });
}

export function canonicalLearning(value) {
    if (value == null) return 'n';
    if (typeof value === 'string') return `s${value.length}:${value}`;
    if (typeof value === 'boolean') return value ? 'b1' : 'b0';
    if (Array.isArray(value)) return 'a' + value.map(canonicalLearning).join('') + 'e';
    if (typeof value === 'object') return 'o' + Object.keys(value).sort().map(k => canonicalLearning(k) + canonicalLearning(value[k])).join('') + 'e';
    return `d${value}`;
}

export function mergeLearningRecords(local = [], remote = [], key = 'id') {
    const map = new Map();
    for (const entry of [...local, ...remote]) {
        if (!entry?.[key]) continue;
        const previous = map.get(entry[key]);
        const time = Date.parse(entry.updated_at || entry.created_at) || 0;
        const oldTime = previous ? Date.parse(previous.updated_at || previous.created_at) || 0 : -Infinity;
        if (!previous || time > oldTime || (time === oldTime && (
            Number(!!entry.deleted) > Number(!!previous.deleted) ||
            (!!entry.deleted === !!previous.deleted && canonicalLearning(entry) > canonicalLearning(previous))
        ))) map.set(entry[key], structuredClone(entry));
    }
    return [...map.values()].sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
}

export function normalizeLearningData(data) {
    data.time_entries = mergeLearningRecords((data.time_entries || []).map(e => ({
        ...e, task_ref: { source_type: 'personal', source_id: null, ...e.task_ref },
        task_content_snapshot: e.task_content_snapshot || '', label_snapshot: normalizeLabel(e.label_snapshot),
        ended_at: e.ended_at ?? null, deleted: !!e.deleted
    })));
    data.daily_reviews = mergeLearningRecords((data.daily_reviews || []).map(r => ({
        fact: '', obstacle: '', effective_action: '', next_step: '', ...r, deleted: !!r.deleted
    })), [], 'date');
    return data;
}

export function taskReference(todo, source = { type: 'personal' }) {
    return { source_type: source.type, source_id: source.type === 'personal' ? null : source.id, todo_id: todo.id };
}

export function sameTask(a, b) {
    return a?.todo_id === b?.todo_id && a?.source_type === b?.source_type && (a?.source_id ?? null) === (b?.source_id ?? null);
}

export function localDay(value) {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function learningRange(period, value) {
    const start = new Date(value); start.setHours(0, 0, 0, 0);
    if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    if (period === 'month') start.setDate(1);
    const end = new Date(start);
    if (period === 'month') end.setMonth(end.getMonth() + 1);
    else end.setDate(end.getDate() + (period === 'week' ? 7 : 1));
    return { start: localDay(start), end: localDay(end) };
}

export function splitTimeEntry(entry) {
    let cursor = Date.parse(entry.started_at); const end = Date.parse(entry.ended_at);
    if (entry.deleted || !Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) return [];
    const parts = [];
    while (cursor < end) {
        const boundary = new Date(cursor); boundary.setHours(24, 0, 0, 0);
        const next = Math.min(boundary.getTime(), end);
        parts.push({ date: localDay(cursor), duration: next - cursor, started_at: cursor, ended_at: next, entry });
        cursor = next;
    }
    return parts;
}

export function overlappingEntries(entries) {
    const active = entries.filter(e => !e.deleted && Number.isFinite(Date.parse(e.started_at)) &&
        (e.ended_at == null || Date.parse(e.ended_at) > Date.parse(e.started_at)));
    const ids = new Set();
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        if (Date.parse(a.started_at) < (b.ended_at == null ? Infinity : Date.parse(b.ended_at)) &&
            Date.parse(b.started_at) < (a.ended_at == null ? Infinity : Date.parse(a.ended_at))) {
            ids.add(a.id); ids.add(b.id);
        }
    }
    return ids;
}

export function validateTimeEntry(entry, entries, now = Date.now()) {
    const start = Date.parse(entry.started_at), end = entry.ended_at == null ? null : Date.parse(entry.ended_at);
    if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) return '请输入有效的日期和时间';
    if (start > now || (end !== null && end > now)) return '不能记录未来的学习时间';
    if (end !== null && end <= start) return '结束时间必须晚于开始时间';
    if (overlappingEntries([...entries.filter(e => e.id !== entry.id), entry]).has(entry.id)) return '与其他计时记录重叠，请检查起止时间';
    return null;
}

export function summarizeLearning(entries, start, end, label = undefined) {
    const conflicts = overlappingEntries(entries);
    const startTime = new Date(start + 'T00:00:00').getTime();
    const endTime = new Date(end + 'T00:00:00').getTime();
    const relevant = entries.filter(e => !e.deleted && Number.isFinite(Date.parse(e.started_at)) &&
        Date.parse(e.started_at) < endTime && (e.ended_at == null || Date.parse(e.ended_at) > startTime));
    const parts = entries.filter(e => !conflicts.has(e.id)).flatMap(splitTimeEntry)
        .filter(p => p.date >= start && p.date < end && (label === undefined || normalizeLabel(p.entry.label_snapshot) === label));
    const groups = new Map();
    for (const part of parts) {
        const name = normalizeLabel(part.entry.label_snapshot) || '未分类';
        const row = groups.get(name) || { label: name, duration: 0, count: 0 };
        row.duration += part.duration; row.count++; groups.set(name, row);
    }
    return { duration: parts.reduce((s, p) => s + p.duration, 0), count: parts.length, parts,
        groups: [...groups.values()].sort((a, b) => b.duration - a.duration),
        pending: relevant.filter(e => conflicts.has(e.id)).length,
        running: relevant.filter(e => e.ended_at == null).length };
}

export function formatDuration(ms, clock = false) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    if (clock) return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
    return [h ? `${h} 小时` : '', m ? `${m} 分钟` : '', s || !seconds ? `${s} 秒` : ''].filter(Boolean).join(' ');
}
