import { createStatsTaskMark, statsTaskStyle } from './statsTaskMark.js';
import { collectSubtaskEvents, arcPath, hitArcs, clockMinute, clockTooltipDateTime, timerLabelColors, unclassifiedTimerColor } from './statsTimeline.js';
import { renderVerticalTimeline } from './statsVerticalView.js';
import { formatDuration } from './timeTracking.js';
import { prepareClockEntry, playClockEntry } from './clockAnimation.js';
import { selectTimelineRecord } from './timelineEditor.js';

function node(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }
function svg(tag, attrs) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; }
function details(title, lines, actionText, action) {
    const d = node('dialog', ''); d.className = 'learning-dialog timeline-detail'; d.append(node('h3', title));
    lines.forEach(line => d.append(node('p', line)));
    const open = node('button', actionText); open.onclick = () => { d.close(); action(); };
    const close = node('button', '关闭'); close.onclick = () => d.close(); d.append(open, close);
    document.body.append(d); d.showModal(); d.addEventListener('close', () => d.remove());
}
const timeText = value => new Date(value).toLocaleString('zh-CN', { hour12: false });

// 任务、打卡和子步骤使用同一个提示层，避免浏览器原生 title 样式不一致。
export function bindClockTooltip(mark, title, lines, color, stroke = '#ffffff', width = 1.5, opacity = 0.95, contentAt = null) {
    const tooltip = document.getElementById('clock-tooltip');
    const position = event => {
        if (!tooltip || tooltip.style.display !== 'block') return;
        const card = document.getElementById('time-distribution').getBoundingClientRect();
        const anchor = mark.getBoundingClientRect();
        const x = (event.clientX ?? anchor.right) - card.left;
        const y = (event.clientY ?? anchor.bottom) - card.top;
        const left = x + 12 + tooltip.offsetWidth > card.width - 10 ? x - tooltip.offsetWidth - 12 : x + 12;
        tooltip.style.left = `${Math.max(8, left)}px`;
        tooltip.style.top = `${Math.max(8, y + 12)}px`;
    };
    const show = event => {
        const content = contentAt ? contentAt(event) : { title, lines };
        if (!content) { hide(); return; }
        if (color) {
            mark.style.stroke = color; mark.style.strokeWidth = `${width + 2.5}px`;
            mark.style.filter = `drop-shadow(0 0 3px rgba(0,0,0,0.9)) drop-shadow(0 0 6px ${color})`; mark.style.opacity = '1';
        }
        if (!tooltip) return;
        tooltip.replaceChildren(node('strong', content.title));
        content.lines.forEach(line => tooltip.append(document.createElement('br'), document.createTextNode(line)));
        tooltip.style.display = 'block'; position(event);
    };
    const hide = () => {
        mark.style.stroke = stroke; mark.style.strokeWidth = `${width}px`; mark.style.filter = 'none'; mark.style.opacity = String(opacity);
        if (tooltip) tooltip.style.display = 'none';
    };
    mark.addEventListener('mouseenter', show); mark.addEventListener('mousemove', contentAt ? show : position);
    mark.addEventListener('mouseleave', hide); mark.addEventListener('focus', show); mark.addEventListener('blur', hide);
    mark.addEventListener('click', hide);
}

export function renderTimeline({ svgEl, todos, completionEvents, entries, arcs, source, period, target, openTodo, openRecord, openSubtask, timingEnabled, conflicts }) {
    document.querySelectorAll('.timeline-detail').forEach(d => d.close());
    const card = document.getElementById('time-distribution');
    let header = card.querySelector('.timeline-header');
    if (!header) { header = node('div', ''); header.className = 'timeline-header'; card.prepend(header); }
    header.replaceChildren(node('h3', timingEnabled ? '打卡任务时长分布' : '任务时间线'));
    let enabled = false; try { enabled = localStorage.getItem('stats-show-timing') === 'true'; } catch { /* 无本地存储时保持默认 */ }
    const showTiming = timingEnabled && (period === 'day' || enabled);
    if (timingEnabled && period !== 'day') {
        const toggle = node('button', enabled ? '隐藏计时' : '显示计时'); toggle.className = 'ui-button timeline-toggle';
        toggle.setAttribute('aria-pressed', String(enabled));
        toggle.onclick = () => {
            enabled = !enabled;
            try { localStorage.setItem('stats-show-timing', String(enabled)); } catch { /* 显示仍可切换 */ }
            draw(enabled); toggle.textContent = enabled ? '隐藏计时' : '显示计时'; toggle.setAttribute('aria-pressed', String(enabled));
        }; header.append(toggle);
    }
    const steps = collectSubtaskEvents(todos, period, target);
    const labelColors = arcs.length ? timerLabelColors(entries, source, conflicts) : new Map();
    let note = card.querySelector('.timeline-note');
    if (!note) { note = node('p', ''); note.className = 'timeline-note'; card.append(note); }
    const undated = [...completionEvents, ...steps].filter(event => !event.explicit);
    let dateList = card.querySelector('.timeline-undated');
    if (!undated.length) dateList?.remove();
    else {
        if (!dateList) { dateList = node('details', ''); dateList.className = 'timeline-undated'; card.append(dateList); }
        const summary = node('summary', '无具体时间 · ' + undated.length + ' 条');
        dateList.replaceChildren(summary);
        undated.forEach(event => {
            const title = event.subtask ? '子步骤 · ' + event.subtask.content : event.todo.content;
            const button = node('button', event.date + ' · ' + title);
            button.className = 'ui-button';
            button.onclick = () => event.subtask ? openSubtask(event.todo, event.subtask) : openTodo(event.todo);
            dateList.append(button);
        });
    }
    const openTimers = list => {
        const parts = [...new Map(list.map(a => [`${a.entry.id}:${a.date}`, a])).values()];
        if (!parts.length) return;
        selectTimelineRecord(parts.map(a => a.entry), openRecord);
    };
    const timerTooltip = list => {
        const parts = [...new Map(list.map(a => [`${a.entry.id}:${a.date}`, a])).values()];
        if (!parts.length) return null;
        return { title: parts.length === 1 ? (parts[0].entry.display_content || parts[0].entry.task_content_snapshot) : `${parts.length} 条计时记录`, lines: [...parts.slice(0, 3).flatMap(a => {
            const start = clockTooltipDateTime(a.started_at), end = clockTooltipDateTime(a.ended_at);
            return [...(parts.length > 1 ? [(a.entry.display_content || a.entry.task_content_snapshot)] : []),
                `标签: ${a.entry.label_snapshot || '未分类'}`,
                `计时区间: ${start.date} ${start.time} — ${end.date} ${end.time}`,
                `投入时长: ${formatDuration(a.duration)}`];
        }), ...(parts.length > 3 ? [`另有 ${parts.length - 3} 条，点击查看全部`] : [])] };
    };
    function draw(visible) {
        const tooltip = document.getElementById('clock-tooltip'); if (tooltip) tooltip.style.display = 'none';
        svgEl.querySelector('.timeline-layer')?.remove(); document.querySelectorAll('.timeline-detail').forEach(d => d.close());
        card.querySelector('.timeline-lines-host')?.remove();
        const linear = visible && period !== 'day';
        card.classList.toggle('timeline-linear-mode', linear);
        const clockContainer = svgEl.closest('.efficiency-clock-container');
        clockContainer.style.display = linear ? 'none' : 'flex';
        note.textContent = visible && !arcs.length ? '本时段暂无有效计时记录。' : !visible && arcs.length ? '可点击“显示计时”查看投入。' : '';
        note.hidden = !note.textContent;
        if (linear) {
            const host = document.createElement('div'); host.className = 'timeline-lines-host'; clockContainer.after(host);
            renderVerticalTimeline({ host, completed: completionEvents, steps, arcs, labelColors, period, target,
                bindTooltip: bindClockTooltip, timerTooltip, openTimers, openTodo, openSubtask, showDetails: details });
            return;
        }
        const layer = svg('g', { class: 'timeline-layer' });
        if (visible) {
            arcs.forEach(a => {
                const path = svg('path', { d: arcPath(170, 130, 100, a.startMinute, a.endMinute), fill: 'none',
                    stroke: labelColors.get(a.entry.label_snapshot) ?? unclassifiedTimerColor, 'stroke-width': 6 });
                prepareClockEntry(path, a.startMinute, a.endMinute); layer.append(path);
            });
            const hit = svg('circle', { cx: 170, cy: 130, r: 100, fill: 'none', stroke: 'transparent', 'stroke-width': 18, 'pointer-events': 'stroke', role: 'button', tabindex: 0, 'aria-label': '查看计时区间记录' });
            const arcsAt = event => {
                if (event.clientX == null) return arcs;
                const p = svgEl.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
                const local = p.matrixTransform(svgEl.getScreenCTM().inverse());
                const minute = (Math.atan2(local.x - 170, 130 - local.y) * 1440 / (2 * Math.PI) + 1440) % 1440;
                return hitArcs(arcs, minute, 8);
            };
            bindClockTooltip(hit, '', [], null, 'transparent', 18, 1, event => timerTooltip(arcsAt(event)));
            hit.onclick = event => openTimers(arcsAt(event));
            hit.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTimers(arcs); } };
            if (arcs.length) layer.append(hit);
        }
        steps.filter(e => e.explicit).forEach((e, i) => {
            const angle = clockMinute(e.completed_at) / 1440 * Math.PI * 2;
            const r = 44 + (i % 3) * 5;
            const { color } = statsTaskStyle(e.todo.task_type);
            const dot = createStatsTaskMark(e.todo.task_type, 170 + r * Math.sin(angle), 130 - r * Math.cos(angle), period === 'day' ? 4 : 3, true);
            dot.setAttribute('fill', 'transparent');
            dot.setAttribute('stroke-width', 2);
            dot.setAttribute('role', 'button');
            dot.setAttribute('tabindex', 0);
            const caption = `${e.todo.content} / ${e.subtask.content}\n${timeText(e.completed_at)}`;
            prepareClockEntry(dot, clockMinute(e.completed_at));
            dot.setAttribute('aria-label', caption);
            const stamp = clockTooltipDateTime(e.completed_at);
            bindClockTooltip(dot, e.subtask.content, [`所属任务: ${e.todo.content}`, `完成日期: ${stamp.date}`, `完成时间: ${stamp.time}`], color, color, 2, 1);
            const open = () => openSubtask(e.todo, e.subtask);
            dot.onclick = open; dot.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }; layer.append(dot);
        });
        svgEl.append(layer);
        playClockEntry(layer);
        note.textContent = visible && !arcs.length ? '本时段暂无有效计时记录。' : !visible && arcs.length ? '可点击“显示计时”查看投入。' : '';
        note.hidden = !note.textContent;
    }
    draw(showTiming);
}
