import { statsPeriodKey } from './dateUtils.js';
import { localDay, learningRange, splitTimeEntry, overlappingEntries } from './timeTracking.js';

// 按本地时间从午夜起排列，钟面和纵向时间线共用。
export const timeSlotColors = Object.freeze({
    night: '#3b82f6', morning: '#f59e0b', afternoon: '#7b61ff', evening: '#6366f1'
});

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

export function timelineDays(period, target) {
    const { start, end } = learningRange(period, target), days = [];
    const cursor = new Date(`${start}T12:00:00`);
    while (localDay(cursor) < end) { days.push(localDay(cursor)); cursor.setDate(cursor.getDate() + 1); }
    return days;
}

export function collectTaskTimelineEvents(todos, period, target) {
    const { start, end } = learningRange(period, target);
    return todos.filter(t => !t.deleted).flatMap(todo => {
        const times = ['weekly_checkin', 'monthly_checkin'].includes(todo.task_type) ? [...new Set(todo.completed_dates || [])] :
            todo.completed && todo.completed_at ? [todo.completed_at] : [];
        return times.flatMap(time => {
            const date = statsPeriodKey(time), explicit = Boolean(date && time.includes('T'));
            return date >= start && date < end ? [{ todo, date, completed_at: time, explicit }] : [];
        });
    });
}

// 直线按日期隔离，午夜上端不会命中同一天的 24:00 下端。
export function hitTimelineSegments(parts, date, minute, tolerance = 0) {
    return parts.filter(a => a.date === date && minute >= a.startMinute - tolerance && minute <= a.endMinute + tolerance);
}

export function collectSubtaskEvents(todos, period, target) {
    const { start, end } = learningRange(period, target);
    return todos.filter(t => !t.deleted).flatMap(todo => (todo.subtasks || []).flatMap(subtask => {
        if (!subtask.completed || !subtask.completed_at) return [];
        const time = subtask.completed_at;
        const date = statsPeriodKey(time), explicit = Boolean(date && time.includes('T'));
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

function timelineEntries(entries, source, conflicts) {
    return entries.filter(e => !conflicts.has(e.id) && e.task_ref.source_type === source.type &&
        (e.task_ref.source_id ?? null) === (source.type === 'personal' ? null : source.id));
}

// 与 Android 使用相同色板和 UTF-16 标签顺序。
const timerPalette = ['#2593A7', '#8F77D8', '#B5832F', '#C96889', '#4E996C'];
export const unclassifiedTimerColor = '#858899';

export function timerLabelColors(resolvedEntries, source, conflicts = overlappingEntries(resolvedEntries)) {
    const labels = new Set();
    for (const entry of timelineEntries(resolvedEntries, source, conflicts)) {
        if (!entry.deleted && entry.label_snapshot && Date.parse(entry.ended_at) > Date.parse(entry.started_at)) {
            labels.add(entry.label_snapshot);
        }
    }
    const assigned = new Map();
    const used = new Set();
    for (const label of [...labels].sort()) {
        let hash = 0;
        for (let i = 0; i < label.length; i++) {
            hash = (Math.imul(31, hash) + label.charCodeAt(i)) | 0;
        }
        let index = ((hash % timerPalette.length) + timerPalette.length) % timerPalette.length;
        if (used.size < timerPalette.length) {
            while (used.has(index)) index = (index + 1) % timerPalette.length;
            used.add(index);
        }
        assigned.set(label, timerPalette[index]);
    }
    return assigned;
}

export function collectTimerArcs(entries, source, period, target, conflicts = overlappingEntries(entries)) {
    const { start, end } = learningRange(period, target);
    return timelineEntries(entries, source, conflicts)
        .flatMap(splitTimeEntry).filter(p => p.date >= start && p.date < end).flatMap(clockSegments);
}

// 圆弧已在午夜和时区偏移变化处切开，每一段按实际覆盖的时段累计毫秒。
export function checkinDurationBySlot(arcs, todos) {
    const checkinIds = new Set(todos.filter(todo => !todo.deleted &&
        (todo.task_type === 'weekly_checkin' || todo.task_type === 'monthly_checkin')).map(todo => todo.id));
    const checkinArcs = arcs.filter(arc => checkinIds.has(arc.entry.task_ref.todo_id));
    return Object.fromEntries(Object.keys(timeSlotColors).map((slot, index) => {
        const start = index * 360, end = start + 360;
        let duration = 0;
        for (const arc of checkinArcs) {
            const overlap = Math.min(arc.endMinute, end) - Math.max(arc.startMinute, start);
            duration += Math.round(Math.max(0, overlap) * 60000);
        }
        return [slot, duration];
    }));
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
