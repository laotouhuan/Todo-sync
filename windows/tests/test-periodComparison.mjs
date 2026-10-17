import { it } from 'node:test';
import assert from 'node:assert/strict';
import { comparisonEnd, dailyComparison } from '../src/periodComparison.js';

const minute = 60000;
const part = (start, end) => ({ start: start.getTime(), end: end.getTime() });

it('每日汇总跨午夜记录并合并同日多段，合计保持一致', () => {
    const result = { available: true, parts: [
        part(new Date(2026, 9, 12, 23, 30), new Date(2026, 9, 13, 0, 30)),
        part(new Date(2026, 9, 13, 9), new Date(2026, 9, 13, 10))
    ] };
    const now = new Date(2026, 9, 19);
    const days = dailyComparison(result, '2026-W42', now, now);
    assert.equal(days.length, 7);
    assert.equal(days[0].duration, 30 * minute);
    assert.equal(days[1].duration, 90 * minute);
    assert.equal(days[2].duration, 0);
    assert.equal(days.reduce((total, d) => total + d.duration, 0), 120 * minute);
});

it('同期按星期和时刻截断，两期在截止日后均不画零柱', () => {
    const now = new Date(2026, 9, 17, 10, 30);
    const currentEnd = comparisonEnd('2026-W42', true, true, now);
    const previousEnd = comparisonEnd('2026-W41', true, true, now);
    assert.equal(currentEnd.getTime(), now.getTime());
    assert.equal(previousEnd.getTime(), new Date(2026, 9, 10, 10, 30).getTime());
    const result = { available: true, parts: [part(new Date(2026, 9, 10, 10), new Date(2026, 9, 10, 11))] };
    const days = dailyComparison(result, '2026-W41', previousEnd, now);
    assert.equal(days[5].duration, 30 * minute);
    assert.equal(days[6].duration, null);
    assert.equal(days[6].status, '未纳入');
    assert.equal(dailyComparison(result, '2026-W42', currentEnd, now)[6].status, '未到');
    assert.equal(comparisonEnd('2026-W41', false, true, now).getTime(), new Date(2026, 9, 12).getTime());
});

it('短月、闰月与跨年周按日历对齐；两期历史数据不受同期裁剪', () => {
    const now = new Date(2026, 2, 31, 10);
    assert.equal(comparisonEnd('2026-02', true, true, now).getTime(), new Date(2026, 2, 1).getTime());
    assert.equal(comparisonEnd('2026-01', true, false, now).getTime(), new Date(2026, 1, 1).getTime());
    const empty = { available: true, parts: [] };
    assert.equal(dailyComparison(empty, '2026-02', now, now).length, 28);
    assert.equal(dailyComparison(empty, '2024-02', now, now).length, 29);
    assert.equal(dailyComparison(empty, '2026-03', now, now).length, 31);
    const nextYear = new Date(2027, 0, 5, 8);
    assert.equal(comparisonEnd('2026-W53', true, true, nextYear).getTime(), new Date(2026, 11, 29, 8).getTime());
});

it('缺失数据、有效零时长、尚未到达的周期分别展示', () => {
    const now = new Date(2026, 9, 17, 10);
    const end = comparisonEnd('2026-W42', false, true, now);
    const missing = dailyComparison({ available: false, parts: [] }, '2026-W42', end, now);
    const zero = dailyComparison({ available: true, parts: [] }, '2026-W42', end, now);
    assert.equal(missing[0].status, '无数据'); assert.equal(missing[0].duration, null);
    assert.equal(zero[0].status, ''); assert.equal(zero[0].duration, 0);
    const future = dailyComparison({ available: true, parts: [] }, '2026-W43', now, now);
    assert.ok(future.every(day => day.duration === null && day.status === '未到'));
});

it('夏令时切换日按真实小时累计，不固定为二十四小时', () => {
    const originalZone = process.env.TZ;
    try {
        process.env.TZ = 'America/New_York';
        const start = new Date(2026, 2, 8), end = new Date(2026, 2, 9), now = new Date(2026, 2, 10);
        const days = dailyComparison({ available: true, parts: [part(start, end)] }, '2026-03', now, now);
        assert.equal(days[7].duration, 23 * 60 * minute);
        assert.equal(days.reduce((total, d) => total + (d.duration || 0), 0), 23 * 60 * minute);
    } finally {
        if (originalZone == null) delete process.env.TZ; else process.env.TZ = originalZone;
    }
});
