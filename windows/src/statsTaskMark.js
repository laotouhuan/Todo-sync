const styles = {
    normal: { key: 'normal', color: '#10B981', shape: 'circle' },
    weekly_checkin: { key: 'weekly', color: '#6366F1', shape: 'diamond' },
    monthly_checkin: { key: 'monthly', color: '#F43F5E', shape: 'star' }
};

export function statsTaskStyle(taskType) {
    return Object.hasOwn(styles, taskType) ? styles[taskType] : styles.normal;
}

// 图例、钟面和纵向时间线共用标记。子步骤用父任务颜色的空心圆表示。
export function createStatsTaskMark(taskType, x, y, radius, subtask = false) {
    const { shape, color } = statsTaskStyle(taskType);
    const circle = subtask || shape === 'circle';
    const mark = document.createElementNS('http://www.w3.org/2000/svg', circle ? 'circle' : 'polygon');
    if (circle) {
        mark.setAttribute('cx', x);
        mark.setAttribute('cy', y);
        mark.setAttribute('r', radius);
    } else {
        const star = shape === 'star', count = star ? 10 : 4;
        const points = Array.from({ length: count }, (_, i) => {
            const angle = i * 2 * Math.PI / count - Math.PI / 2;
            const r = radius * (star ? (i % 2 ? .6 : 1.25) : 1.1);
            return `${x + r * Math.cos(angle)},${y + r * Math.sin(angle)}`;
        });
        mark.setAttribute('points', points.join(' '));
    }
    mark.setAttribute('fill', subtask ? 'var(--modal-bg-solid)' : color);
    mark.setAttribute('stroke', subtask ? color : '#ffffff');
    mark.setAttribute('stroke-width', 1.5);
    return mark;
}
