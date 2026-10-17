import { periodRange } from './taskSeries.js';
import { localDay } from './timeTracking.js';

// 周按星期、月按日号对齐；短月截到月末，当前周期不计未来时刻。
export function comparisonEnd(period, sameProgress, hasCurrentPeriod, now = new Date()) {
    const range = periodRange(period);
    let end = range.end;
    if (sameProgress && hasCurrentPeriod) {
        if (period.includes('-W')) {
            end = new Date(range.start);
            end.setDate(end.getDate() + (now.getDay() + 6) % 7);
        } else {
            end = new Date(range.start.getFullYear(), range.start.getMonth(), now.getDate());
        }
        end.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    }
    return new Date(Math.min(end.getTime(), range.end.getTime(), now.getTime()));
}

export function dailyComparison(result, period, end, now = new Date()) {
    const range = periodRange(period), days = [];
    for (let start = new Date(range.start); start < range.end;) {
        const next = new Date(start);
        next.setDate(next.getDate() + 1);
        const date = localDay(start);
        let status = '';
        if (date > localDay(now)) status = '未到';
        else if (start >= end) status = '未纳入';
        else if (!result.available) status = '无数据';
        const stop = Math.min(next.getTime(), end.getTime());
        const duration = status ? null : result.parts.reduce((total, part) =>
            total + Math.max(0, Math.min(part.end, stop) - Math.max(part.start, start.getTime())), 0);
        days.push({ date, duration, status });
        start = next;
    }
    return days;
}
