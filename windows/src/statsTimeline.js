import { localDay, learningRange, splitTimeEntry, overlappingEntries } from './timeTracking.js';

// 所有钟面标记共用本地时间刻度，保留秒和毫秒，不添加角度偏移。
export function clockMinute(value) {
    const d = new Date(value);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
}

// 悬浮提示用紧凑的本地日期与分钟；原始记录及钟面精度保持不变。
export function clockTooltipDateTime(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value.slice(5), time: '' };
    const d = new Date(value), pad = n => String(n).padStart(2, '0');
    return { date: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export function collectSubtaskEvents(todos, period, target) {
    const { start, end } = learningRange(period, target);
    return todos.filter(t => !t.deleted).flatMap(todo => (todo.subtasks || []).flatMap(subtask => {
        if (!subtask.completed || !subtask.completed_at) return [];
        const time = subtask.completed_at;
        if (!Number.isFinite(Date.parse(time))) return [];
        const explicit = time.includes('T');
        if (!explicit && (!/^\d{4}-\d{2}-\d{2}$/.test(time) || new Date(time).toISOString().slice(0, 10) !== time)) return [];
        const date = explicit ? localDay(time) : time;
        return date >= start && date < end ? [{ id: `${todo.id}:${subtask.id}`, todo, subtask, date, completed_at: time, explicit }] : [];
    }));
}

// 在偏移变化处分段：钟面角度用当地时间，时长仍用真实时间差。
export function clockSegments(part) {
    const result = []; let cursor = part.started_at;
    while (cursor < part.ended_at) {
        const offset = new Date(cursor).getTimezoneOffset();
        let next = Math.min(cursor + 60000, part.ended_at);
        while (next < part.ended_at && new Date(next).getTimezoneOffset() === offset) next = Math.min(next + 60000, part.ended_at);
        if (new Date(next).getTimezoneOffset() !== offset) {
            let low = Math.max(cursor, next - 60000), high = next;
            while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (new Date(mid).getTimezoneOffset() === offset) low = mid; else high = mid; }
            next = high;
        }
        const startMinute = clockMinute(cursor);
        result.push({ ...part, startMinute, endMinute: Math.min(1440, startMinute + (next - cursor) / 60000) });
        cursor = next;
    }
    return result;
}

export function collectTimerArcs(entries, source, period, target) {
    const { start, end } = learningRange(period, target), conflicts = overlappingEntries(entries);
    return entries.filter(e => !conflicts.has(e.id) && e.task_ref.source_type === source.type &&
        (e.task_ref.source_id ?? null) === (source.type === 'personal' ? null : source.id))
        .flatMap(splitTimeEntry).filter(p => p.date >= start && p.date < end).flatMap(clockSegments);
}

export function arcPath(cx, cy, radius, startMinute, endMinute) {
    const point = m => [cx + radius * Math.sin(m / 1440 * 2 * Math.PI), cy - radius * Math.cos(m / 1440 * 2 * Math.PI)];
    const a = point(startMinute), b = point(endMinute);
    if (endMinute - startMinute >= 1440) { const mid = point(startMinute + 720); return `M ${a} A ${radius},${radius} 0 0 1 ${mid} A ${radius},${radius} 0 0 1 ${a}`; }
    return `M ${a} A ${radius},${radius} 0 ${endMinute - startMinute > 720 ? 1 : 0} 1 ${b}`;
}

export function hitArcs(arcs, minute, tolerance = 0) {
    return arcs.filter(a => [minute, minute + 1440, minute - 1440].some(m => m >= a.startMinute - tolerance && m <= a.endMinute + tolerance));
}
