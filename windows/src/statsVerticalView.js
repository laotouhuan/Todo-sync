import { timelineDays, collectTaskTimelineEvents, clockMinute, clockTooltipDateTime, hitTimelineSegments } from './statsTimeline.js';
import { prepareClockEntry, playClockEntry } from './clockAnimation.js';

const ns = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
    const n = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (text != null) n.textContent = text; return n;
}
const colors = { normal: '#10B981', daily: '#F59E0B', weekly: '#6366F1', monthly: '#F43F5E' };
const type = t => t.recurring === 'daily_repeat' ? 'daily' : t.task_type === 'weekly_checkin' ? 'weekly' : t.task_type === 'monthly_checkin' ? 'monthly' : 'normal';

function completionMark(event, x, y, radius) {
    const color = colors[type(event.todo)];
    if (event.subtask || type(event.todo) === 'normal') return svg('circle', { cx: x, cy: y, r: radius, fill: event.subtask ? 'var(--modal-bg-solid)' : color, stroke: event.subtask ? color : '#fff', 'stroke-width': 1.5 });
    const kind = type(event.todo), count = kind === 'daily' ? 3 : kind === 'weekly' ? 4 : 10;
    const points = Array.from({ length: count }, (_, i) => {
        const angle = i / count * Math.PI * 2 - Math.PI / 2, r = kind === 'monthly' && i % 2 ? radius * .45 : radius;
        return `${x + r * Math.cos(angle)},${y + r * Math.sin(angle)}`;
    }).join(' ');
    return svg('polygon', { points, fill: color, stroke: '#fff', 'stroke-width': 1 });
}

export function renderVerticalTimeline({ host, todos, steps, arcs, period, target, bindTooltip, timerTooltip, openTimers, openTodo, openSubtask, showDetails }) {
    const days = timelineDays(period, target), month = period === 'month';
    const stride = month ? 32 : 42, width = days.length * stride, top = 44, height = 288, total = 356;
    const yAt = minute => top + minute / 1440 * height;
    host.replaceChildren();
    const layout = document.createElement('div'); layout.className = 'timeline-lines-layout'; host.append(layout);
    const axis = svg('svg', { width: 44, height: total, viewBox: `0 0 44 ${total}`, 'aria-hidden': true });
    [0, 6, 12, 18, 24].forEach(hour => axis.append(svg('text', { x: 38, y: yAt(hour * 60) + 4, 'text-anchor': 'end', class: 'timeline-axis-label' }, `${String(hour).padStart(2, '0')}:00`)));
    layout.append(axis);
    const scroll = document.createElement('div'); scroll.className = 'timeline-lines-scroll'; scroll.tabIndex = 0;
    scroll.setAttribute('aria-label', month ? '每日计时图，可左右滚动' : '周一至周日计时图'); layout.append(scroll);
    const chart = svg('svg', { width, height: total, viewBox: `0 0 ${width} ${total}`, preserveAspectRatio: 'none', 'aria-label': month ? '本月每日时间线' : '本周每日时间线' });
    chart.style.minWidth = `${width}px`; chart.style.width = '100%'; scroll.append(chart);
    const tracks = svg('g', {}), marks = svg('g', {}); chart.append(tracks, marks);
    const completed = collectTaskTimelineEvents(todos, period, target), events = [...completed, ...steps];
    days.forEach((date, index) => {
        const x = (index + .5) * stride, weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index];
        tracks.append(svg('text', { x, y: 17, 'text-anchor': 'middle', class: 'timeline-axis-label' }, month ? `${Number(date.slice(8))}日` : weekday));
        if (!month) tracks.append(svg('text', { x, y: 32, 'text-anchor': 'middle', class: 'timeline-axis-label' }, date.slice(5)));
        ['#3b82f6', '#f59e0b', '#7b61ff', '#6366f1'].forEach((color, slot) => tracks.append(svg('line', {
            x1: x, x2: x, y1: yAt(slot * 360), y2: yAt((slot + 1) * 360), stroke: color, 'stroke-width': month ? 3 : 6, opacity: .25
        })));
        const dayParts = arcs.filter(a => a.date === date);
        dayParts.forEach(a => {
            const path = svg('path', { d: `M ${x} ${yAt(a.startMinute)} L ${x} ${yAt(a.endMinute)}`, fill: 'none', stroke: '#22d3ee', 'stroke-width': month ? 3 : 6 });
            prepareClockEntry(path, a.startMinute, a.endMinute); tracks.append(path);
        });
        if (dayParts.length) {
            const hit = svg('line', { x1: x, x2: x, y1: top, y2: yAt(1440), stroke: 'transparent', 'stroke-width': 18, 'pointer-events': 'stroke', role: 'button', tabindex: 0, 'aria-label': `${date.slice(5)} 计时记录` });
            const partsAt = event => {
                if (event.clientY == null) return dayParts;
                const p = chart.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
                const local = p.matrixTransform(chart.getScreenCTM().inverse());
                return hitTimelineSegments(dayParts, date, (local.y - top) / height * 1440, 10);
            };
            bindTooltip(hit, '', [], null, 'transparent', 18, 1, event => timerTooltip(partsAt(event)));
            hit.onclick = event => openTimers(partsAt(event));
            hit.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTimers(dayParts); } };
            tracks.append(hit);
        }
        events.filter(e => e.date === date && e.explicit).forEach(e => {
            const minute = clockMinute(e.completed_at), color = colors[type(e.todo)];
            const mark = completionMark(e, x + (e.subtask ? -6 : 6), yAt(minute), month ? 3 : 4);
            const stamp = clockTooltipDateTime(e.completed_at), title = e.subtask?.content || e.todo.content;
            mark.setAttribute('role', 'button'); mark.setAttribute('tabindex', '0'); mark.setAttribute('aria-label', `${title} ${stamp.date} ${stamp.time}`);
            prepareClockEntry(mark, minute);
            bindTooltip(mark, title, [...(e.subtask ? [`所属任务: ${e.todo.content}`] : []), `完成日期: ${stamp.date}`, `完成时间: ${stamp.time}`], color, e.subtask ? color : '#fff', 1.5, 1);
            const open = () => e.subtask ? openSubtask(e.todo, e.subtask) : showDetails('任务完成', [e.todo.content, `${stamp.date} ${stamp.time}`], '编辑任务', () => openTodo(e.todo));
            mark.onclick = open; mark.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }; marks.append(mark);
        });
    });
    completed.filter(e => !e.explicit).forEach(e => {
        const b = document.createElement('button'); b.className = 'learning-button'; b.textContent = `${e.date.slice(5)} · ${e.todo.content}（无具体时间）`;
        b.onclick = () => openTodo(e.todo); host.append(b);
    });
    scroll.addEventListener('scroll', () => { const tooltip = document.getElementById('clock-tooltip'); if (tooltip) tooltip.style.display = 'none'; });
    playClockEntry(chart);
}
