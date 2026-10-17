import { formatDuration } from './timeTracking.js';

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
}

export function renderDailyComparison(host, comparisons, type, selectedDay = 0, onSelect = () => {}) {
    const count = Math.max(...comparisons.map(c => c.days.length));
    const maximum = Math.max(0, ...comparisons.flatMap(c => c.days.map(day => day.duration || 0)));
    const step = maximum <= 3600000 ? 900000 : 3600000;
    const ceiling = Math.max(step, Math.ceil(maximum / step) * step);
    host.append(node('h4', 'period-chart-title', '每日总时长'));
    const legend = node('div', 'period-chart-legend');
    comparisons.forEach((comparison, index) => {
        const label = node('span');
        label.append(node('i', `period-swatch period-color-${index}`), document.createTextNode(`${index ? '对比' : '查看'}：${comparison.period}`));
        legend.append(label);
    });
    host.append(legend);
    const chart = node('div', 'period-chart');
    const axis = node('div', 'period-chart-axis');
    const axisLabel = value => ceiling >= 3600000 ? `${value / 3600000}时` : `${value / 60000}分`;
    axis.append(node('span', null, axisLabel(ceiling)), node('span', null, axisLabel(ceiling / 2)), node('span', null, '0'));
    const scroll = node('div', 'period-chart-scroll');
    const columns = node('div', 'period-chart-columns');
    columns.style.setProperty('--day-count', count);
    const detail = node('div', 'period-day-detail'); detail.setAttribute('aria-live', 'polite');
    const buttons = [];
    const dayValue = day => day?.duration == null ? day?.status || '无此日期' : formatDuration(day.duration);
    function selectDay(index) {
        buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
        detail.replaceChildren();
        const days = comparisons.map(c => c.days[index]);
        days.forEach((day, i) => detail.append(node('p', null, `${i ? '对比' : '查看'} · ${day?.date || '无此日期'}：${dayValue(day)}`)));
        if (days.every(day => day?.duration != null)) {
            const delta = days[0].duration - days[1].duration;
            detail.append(node('p', 'period-day-delta', delta === 0 ? '当天时长相同' : `当天${delta < 0 ? '少' : '多'} ${formatDuration(Math.abs(delta))}`));
        }
        onSelect(index);
    }
    for (let index = 0; index < count; index++) {
        const label = type === 'week' ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][index] : `${index + 1}日`;
        const button = node('button', 'period-day'); button.type = 'button';
        button.setAttribute('aria-label', `${label}，查看周期 ${dayValue(comparisons[0].days[index])}，对比周期 ${dayValue(comparisons[1].days[index])}`);
        const pair = node('span', 'period-bar-pair');
        comparisons.forEach((comparison, i) => {
            const day = comparison.days[index];
            const bar = node('span', `period-bar period-color-${i}`);
            if (day?.duration == null) { bar.classList.add('period-bar-missing'); bar.textContent = '—'; }
            else if (day.duration > 0) { bar.style.height = `${day.duration / ceiling * 100}%`; bar.style.minHeight = '2px'; }
            else bar.classList.add('period-bar-zero');
            pair.append(bar);
        });
        button.append(pair, node('span', 'period-day-label', label));
        button.onclick = () => selectDay(index);
        columns.append(button); buttons.push(button);
    }
    scroll.append(columns); chart.append(axis, scroll); host.append(chart, detail);
    if (type === 'month') host.append(node('p', 'period-help', '左右滑动查看整月；点击日期查看两天的总时长。'));
    else host.append(node('p', 'period-help', '点击日期查看当天差异；— 表示未到、未纳入或无数据。'));
    selectDay(Math.min(selectedDay, count - 1));
}
