import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReminderRule } from '../src/reminderRuleUtils.js';

// 测试文件由 node --test 在独立进程执行，固定时区以覆盖北京时间上午的 UTC 跨日。
process.env.TZ = 'Asia/Shanghai';
const day = new Date(2026, 8, 6, 12);
const noon = { condition: 'none_completed', task_scope: 'all' };
const todo = overrides => ({
    id: 'task', task_type: 'normal', recurring: 'none', date: null,
    completed: false, completed_at: null, completed_dates: [], deleted: false, ...overrides
});
const done = overrides => todo({ completed: true, completed_at: '2026-09-06T08:30:00+08:00', ...overrides });
const monthly = overrides => todo({ task_type: 'monthly_checkin', date: '2026-09', target_count: 20, ...overrides });

test('月任务当天打卡即算完成过，不必达到整月目标', () => {
    for (const record of ['2026-09-05T23:30:00Z', '2026-09-06T07:30:00+08:00', '2026-09-06']) {
        const result = evaluateReminderRule(noon, [monthly({ completed_dates: [record] })], day);
        assert.deepEqual(result, {
            shouldTrigger: false, completedCount: 1, remainingCount: 0,
            totalCount: 1, overdueCount: 0, completionRate: 100
        }, record);
    }
});

test('完成记录按本地午夜划分，无效时间不作完成证据', () => {
    for (const [record, completed] of [
        ['2026-09-05T15:59:59Z', false], ['2026-09-05T16:00:00Z', true],
        ['2026-09-06T15:59:59Z', true], ['2026-09-06T16:00:00Z', false],
        ['2026-09-06T07:30:00', true], ['2026-09-06-invalid', false], ['', false]
    ]) {
        assert.equal(evaluateReminderRule(noon, [monthly({ completed_dates: [record] })], day)
            .shouldTrigger, !completed, record);
    }
});

test('昨天达标不算今天完成，也不能重新算作待办', () => {
    const item = monthly({ completed: true, completed_at: '2026-09-06T08:30:00+08:00',
        completed_dates: ['2026-09-05T08:30:00+08:00'] });
    const result = evaluateReminderRule(noon, [item], day);
    assert.equal(result.shouldTrigger, true);
    assert.equal(result.completedCount, 0);
    assert.equal(result.remainingCount, 0);
    assert.equal(evaluateReminderRule({ ...noon, condition: 'any_remaining' }, [item], day).shouldTrigger, false);
});

test('全部范围按完成日期而非截止日期或所属周期计算', () => {
    for (const item of [
        done({ date: '2026-09-01' }), done({}), done({ date: '2026-09-07' }),
        done({ date: '2026-09-05', recurring: 'daily_repeat' }),
        monthly({ date: '2026-08', completed_dates: ['2026-09-06'] })
    ]) {
        assert.equal(evaluateReminderRule(noon, [item], day).shouldTrigger, false);
    }
});

test('范围过滤、重复打卡去重和模板统计保持一致', () => {
    const items = [
        done({ date: '2026-09-01' }), done({}), done({ date: '2026-09-07' }),
        monthly({ completed_dates: ['2026-09-06', '2026-09-06T08:00:00+08:00'] }),
        todo({ date: '2026-09-05' }), done({ date: '2026-09-06', deleted: true })
    ];
    assert.deepEqual(evaluateReminderRule(noon, items, day), {
        shouldTrigger: false, completedCount: 4, remainingCount: 1,
        totalCount: 5, overdueCount: 1, completionRate: 80
    });
    assert.deepEqual(evaluateReminderRule({ ...noon, task_scope: 'today_only' }, items, day), {
        shouldTrigger: false, completedCount: 1, remainingCount: 1,
        totalCount: 2, overdueCount: 1, completionRate: 50
    });
    assert.deepEqual(evaluateReminderRule({ ...noon, task_scope: 'recurring_only' }, items, day), {
        shouldTrigger: false, completedCount: 1, remainingCount: 0,
        totalCount: 1, overdueCount: 0, completionRate: 100
    });
});

test('缺失时间、历史完成、撤销完成和删除任务不抑制提醒', () => {
    for (const item of [
        done({ date: '2026-09-06', completed_at: null }),
        done({ date: '2026-09-06', completed_at: '2026-09-05T08:00:00+08:00' }),
        done({ date: '2026-09-06', completed: false }), done({ deleted: true })
    ]) {
        assert.equal(evaluateReminderRule(noon, [item], day).shouldTrigger, true);
    }
});

test('剩余任务保留当前周期口径，并支持无条件与空任务规则', () => {
    const items = [
        todo({ date: '2026-09-01', recurring: 'daily_repeat' }),
        todo({ date: '2026-W36', task_type: 'weekly_checkin', completed_dates: ['2026-09-06T08:30:00Z'] }),
        monthly({ date: '2026-08' })
    ];
    const result = evaluateReminderRule({ condition: 'any_remaining', task_scope: 'recurring_only' }, items, day);
    assert.equal(result.shouldTrigger, true);
    assert.equal(result.completedCount, 1);
    assert.equal(result.remainingCount, 1);
    assert.equal(result.overdueCount, 0);
    assert.equal(evaluateReminderRule(noon, [], day).shouldTrigger, true);
    assert.equal(evaluateReminderRule({ condition: 'any_remaining' }, [], day).shouldTrigger, false);
    assert.equal(evaluateReminderRule({ condition: 'unconditional' }, [], day).shouldTrigger, true);
    assert.equal(evaluateReminderRule({ condition: 'unknown' }, [], day).shouldTrigger, false);
});
