// 任务点、子步骤点和计时圆弧共用钟面出场时序。
export function prepareClockEntry(mark, startMinute, endMinute = null) {
    mark.classList.add(endMinute === null ? 'efficiency-dot' : 'efficiency-arc');
    mark.style.setProperty('--dot-delay', `${startMinute / 1440 * 0.8}s`);
    if (endMinute !== null) {
        mark.setAttribute('pathLength', '1');
        mark.style.setProperty('--arc-duration', `${Math.max(0.15, (endMinute - startMinute) / 1440 * 0.8)}s`);
    }
}

export function playClockEntry(group) {
    group.classList.add('clock-entry-group');
    // 等待初始隐藏状态绘制完成，快速切换后的旧图层不再启动动画。
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!group.isConnected) return;
        group.classList.add('play-animation');
        setTimeout(() => {
            if (!group.isConnected) return;
            group.querySelectorAll('.efficiency-dot, .efficiency-arc').forEach(mark => mark.style.removeProperty('--dot-delay'));
        }, 1200);
    }));
}
