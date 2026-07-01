#!/usr/bin/env node
/**
 * dateUtils.js 单元测试
 * 使用 Node.js 内置 test runner (node:test)，无需额外依赖
 *
 * 用法: node --test tests/test-dateUtils.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// dateUtils.js 使用 export，我们直接 import
import {
    formatDate, getISOWeekString,
    getTodayString, getTomorrowString, getThisWeekString,
    getThisMonthString, getLastWeekString, getLastMonthString,
    isWeekDate, isMonthDate, isOverdue, getDateLabel, getCompletionStatusLabel,
    sortFunc, parseInputSyntax, createTodo, groupTodosByDate
} from '../src/dateUtils.js';

// ====== formatDate ======
describe('formatDate', () => {
    it('格式化标准日期', () => {
        const d = new Date(2026, 0, 5); // 2026-01-05
        assert.equal(formatDate(d), '2026-01-05');
    });

    it('月份和日期补零', () => {
        const d = new Date(2026, 5, 8); // 2026-06-08
        assert.equal(formatDate(d), '2026-06-08');
    });

    it('12月31日', () => {
        const d = new Date(2025, 11, 31);
        assert.equal(formatDate(d), '2025-12-31');
    });
});

// ====== getISOWeekString ======
describe('getISOWeekString', () => {
    it('2026年1月1日是第1周', () => {
        const d = new Date(2026, 0, 1);
        assert.equal(getISOWeekString(d), '2026-W01');
    });

    it('返回格式为 YYYY-Www', () => {
        const result = getISOWeekString(new Date());
        assert.match(result, /^\d{4}-W\d{2}$/);
    });
});

// ====== 便捷日期函数 ======
describe('便捷日期函数', () => {
    it('getTodayString 返回今天日期', () => {
        const today = getTodayString();
        assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(today, formatDate(new Date()));
    });

    it('getTomorrowString 返回明天日期', () => {
        const tomorrow = getTomorrowString();
        const d = new Date();
        d.setDate(d.getDate() + 1);
        assert.equal(tomorrow, formatDate(d));
    });

    it('getThisWeekString 返回本周字符串', () => {
        const week = getThisWeekString();
        assert.match(week, /^\d{4}-W\d{2}$/);
    });

    it('getThisMonthString 返回本月字符串', () => {
        const month = getThisMonthString();
        assert.match(month, /^\d{4}-\d{2}$/);
        assert.equal(month.length, 7);
    });

    it('getLastWeekString 返回上周', () => {
        const lastWeek = getLastWeekString();
        assert.match(lastWeek, /^\d{4}-W\d{2}$/);
    });

    it('getLastMonthString 返回上月', () => {
        const lastMonth = getLastMonthString();
        assert.match(lastMonth, /^\d{4}-\d{2}$/);
    });

    it('getLastMonthString 一月回退到上一年十二月', () => {
        const jan = new Date(2026, 0, 15); // 2026年1月
        const result = getLastMonthString(jan);
        assert.equal(result, '2025-12');
    });

    it('getLastMonthString 六月回退到五月', () => {
        const jun = new Date(2026, 5, 15); // 2026年6月
        const result = getLastMonthString(jun);
        assert.equal(result, '2026-05');
    });
});

// ====== 日期类型检查 ======
describe('isWeekDate', () => {
    it('识别周日期格式', () => {
        assert.equal(isWeekDate('2026-W03'), true);
        assert.equal(isWeekDate('2026-W52'), true);
    });

    it('拒绝非周日期格式', () => {
        assert.ok(!isWeekDate('2026-06-28'));
        assert.ok(!isWeekDate('2026-06'));
        assert.ok(!isWeekDate(null));
        assert.ok(!isWeekDate(''));
    });
});

describe('isMonthDate', () => {
    it('识别月日期格式', () => {
        assert.equal(isMonthDate('2026-06'), true);
        assert.equal(isMonthDate('2026-01'), true);
    });

    it('拒绝非月日期格式', () => {
        assert.ok(!isMonthDate('2026-06-28'));
        assert.ok(!isMonthDate('2026-W03'));
        assert.ok(!isMonthDate(null));
        assert.ok(!isMonthDate(''));
    });
});

// ====== isOverdue ======
describe('isOverdue', () => {
    it('日期早于今天且待完成 → 逾期', () => {
        const todo = { date: '2020-01-01', completed: false };
        assert.equal(isOverdue(todo, '2026-06-28'), true);
    });

    it('日期早于今天但已完成 → 不逾期', () => {
        const todo = { date: '2020-01-01', completed: true };
        assert.equal(isOverdue(todo, '2026-06-28'), false);
    });

    it('无日期 → 不逾期', () => {
        const todo = { date: null, completed: false };
        assert.equal(isOverdue(todo, '2026-06-28'), false);
    });

    it('周任务 → 不逾期', () => {
        const todo = { date: '2026-W01', completed: false };
        assert.equal(isOverdue(todo, '2026-06-28'), false);
    });

    it('月任务 → 不逾期', () => {
        const todo = { date: '2026-01', completed: false };
        assert.equal(isOverdue(todo, '2026-06-28'), false);
    });

    it('日期等于今天 → 不逾期', () => {
        const todo = { date: '2026-06-28', completed: false };
        assert.equal(isOverdue(todo, '2026-06-28'), false);
    });

    it('日期晚于今天 → 不逾期', () => {
        const todo = { date: '2030-01-01', completed: false };
        assert.equal(isOverdue(todo, '2026-06-28'), false);
    });
});

// ====== getDateLabel ======
describe('getDateLabel', () => {
    it('今天显示"今天"', () => {
        assert.equal(getDateLabel('2026-06-28', '2026-06-28', '2026-06-29'), '今天');
    });

    it('明天显示"明天"', () => {
        assert.equal(getDateLabel('2026-06-29', '2026-06-28', '2026-06-29'), '明天');
    });

    it('周日期显示"周任务"', () => {
        assert.equal(getDateLabel('2026-W26', '2026-06-28', '2026-06-29'), '周任务');
    });

    it('月日期显示"月任务"', () => {
        assert.equal(getDateLabel('2026-06', '2026-06-28', '2026-06-29'), '月任务');
    });

    it('其他日期显示 MM-DD', () => {
        assert.equal(getDateLabel('2026-07-15', '2026-06-28', '2026-06-29'), '07-15');
    });

    it('空日期返回空字符串', () => {
        assert.equal(getDateLabel(null, '2026-06-28', '2026-06-29'), '');
    });
});

// ====== getCompletionStatusLabel ======
describe('getCompletionStatusLabel', () => {
    it('逾期完成', () => {
        const todo = { completed: true, completed_at: '2026-06-30T00:00:00Z', date: '2026-06-28' };
        assert.equal(getCompletionStatusLabel(todo), '逾期完成');
    });

    it('提前完成', () => {
        const todo = { completed: true, completed_at: '2026-06-26T00:00:00Z', date: '2026-06-28' };
        assert.equal(getCompletionStatusLabel(todo), '提前完成');
    });

    it('按时完成', () => {
        const todo = { completed: true, completed_at: '2026-06-28T10:00:00Z', date: '2026-06-28' };
        assert.equal(getCompletionStatusLabel(todo), '按时完成');
    });

    it('待完成返回 null', () => {
        const todo = { completed: false, completed_at: null, date: '2026-06-28' };
        assert.equal(getCompletionStatusLabel(todo), null);
    });

    it('周任务返回 null（日期长度不是10）', () => {
        const todo = { completed: true, completed_at: '2026-06-28T00:00:00Z', date: '2026-W26' };
        assert.equal(getCompletionStatusLabel(todo), null);
    });
});

// ====== sortFunc ======
describe('sortFunc', () => {
    it('待完成排在已完成前面', () => {
        const a = { completed: false, order: 1, created_at: '2026-01-01T00:00:00Z' };
        const b = { completed: true, order: 0, created_at: '2026-01-02T00:00:00Z' };
        assert.ok(sortFunc(a, b) < 0);
    });

    it('相同完成状态按 order 排序', () => {
        const a = { completed: false, order: 5, created_at: '2026-01-01T00:00:00Z' };
        const b = { completed: false, order: 2, created_at: '2026-01-01T00:00:00Z' };
        assert.ok(sortFunc(a, b) > 0); // a.order > b.order
    });

    it('相同 order 按创建时间降序', () => {
        const a = { completed: false, order: 1, created_at: '2026-01-01T00:00:00Z' };
        const b = { completed: false, order: 1, created_at: '2026-06-01T00:00:00Z' };
        assert.ok(sortFunc(a, b) > 0); // b 更新，排前面
    });
});

// ====== parseInputSyntax ======
describe('parseInputSyntax', () => {
    it('解析 @YYYY-MM-DD 日期', () => {
        const result = parseInputSyntax('买菜 @2026-07-01');
        assert.equal(result.content, '买菜');
        assert.equal(result.taskDate, '2026-07-01');
        assert.equal(result.taskType, 'normal');
        assert.equal(result.targetCount, null);
    });

    it('解析 @MM-DD 日期（补全年份）', () => {
        const result = parseInputSyntax('开会 @07-15');
        assert.equal(result.content, '开会');
        assert.equal(result.taskDate, `${new Date().getFullYear()}-07-15`);
        assert.equal(result.taskType, 'normal');
        assert.equal(result.targetCount, null);
    });

    it('无日期语法时返回 null taskDate', () => {
        const result = parseInputSyntax('普通任务');
        assert.equal(result.content, '普通任务');
        assert.equal(result.taskDate, null);
        assert.equal(result.taskType, 'normal');
        assert.equal(result.targetCount, null);
    });

    it('@ 出中间不触发解析', () => {
        const result = parseInputSyntax('发邮件给user@test.com');
        assert.equal(result.content, '发邮件给user@test.com');
        assert.equal(result.taskDate, null);
    });

    it('解析 @week 为不设目标的周打卡任务', () => {
        const result = parseInputSyntax('写周报 @week');
        assert.equal(result.content, '写周报');
        assert.match(result.taskDate, /^\d{4}-W\d{2}$/);
        assert.equal(result.taskType, 'weekly_checkin');
        assert.equal(result.targetCount, null);
    });

    it('解析 @month 为不设目标的月打卡任务', () => {
        const result = parseInputSyntax('打卡 @month');
        assert.equal(result.content, '打卡');
        assert.match(result.taskDate, /^\d{4}-\d{2}$/);
        assert.equal(result.taskType, 'monthly_checkin');
        assert.equal(result.targetCount, null);
    });

    it('解析 @week*3 为周打卡且设定目标 3 次', () => {
        const result = parseInputSyntax('打卡 @week*3');
        assert.equal(result.content, '打卡');
        assert.match(result.taskDate, /^\d{4}-W\d{2}$/);
        assert.equal(result.taskType, 'weekly_checkin');
        assert.equal(result.targetCount, 3);
    });

    it('解析 @month*4 为月打卡且设定目标 4 次', () => {
        const result = parseInputSyntax('打卡 @month*4');
        assert.equal(result.content, '打卡');
        assert.match(result.taskDate, /^\d{4}-\d{2}$/);
        assert.equal(result.taskType, 'monthly_checkin');
        assert.equal(result.targetCount, 4);
    });

    it('解析 @day / @daily 为每天重复任务', () => {
        const res1 = parseInputSyntax('日常任务 @day');
        assert.equal(res1.content, '日常任务');
        assert.equal(res1.taskDate, getTodayString());
        assert.equal(res1.taskType, 'daily_repeat');

        const res2 = parseInputSyntax('日常任务 @daily');
        assert.equal(res2.content, '日常任务');
        assert.equal(res2.taskDate, getTodayString());
        assert.equal(res2.taskType, 'daily_repeat');
    });
});

// ====== createTodo ======
describe('createTodo', () => {
    it('创建包含所有必需字段的 todo', () => {
        const todo = createTodo('测试任务', '2026-06-28');
        assert.equal(todo.content, '测试任务');
        assert.equal(todo.date, '2026-06-28');
        assert.equal(todo.completed, false);
        assert.equal(todo.deleted, false);
        assert.equal(todo.recurring, 'none');
        assert.equal(todo.task_type, 'normal');
        assert.equal(todo.target_count, null);
        assert.deepEqual(todo.completed_dates, []);
        assert.deepEqual(todo.subtasks, []);
        assert.ok(todo.id); // UUID
        assert.ok(todo.created_at);
        assert.ok(todo.updated_at);
    });

    it('无日期创建', () => {
        const todo = createTodo('无日期任务');
        assert.equal(todo.date, null);
    });

    it('每次创建的 ID 不同', () => {
        const a = createTodo('A');
        const b = createTodo('B');
        assert.notEqual(a.id, b.id);
    });
});

// ====== groupTodosByDate ======
describe('groupTodosByDate', () => {
    const todayStr = '2026-06-28';

    it('按日期分组', () => {
        const todos = [
            { date: '2026-06-28', content: 'today' },
            { date: null, content: 'no date' },
            { date: '2026-W26', content: 'week' },
            { date: '2026-06', content: 'month' },
            { date: '2026-12-31', content: 'future' },
            { date: '2026-01-01', content: 'past' },
        ];
        const groups = groupTodosByDate(todos, todayStr);
        assert.equal(groups.todayGroup.length, 1);
        assert.equal(groups.noDateGroup.length, 1);
        assert.equal(groups.weekGroup.length, 1);
        assert.equal(groups.monthGroup.length, 1);
        assert.equal(groups.futureGroup.length, 1);
        assert.equal(groups.pastGroup.length, 1);
    });

    it('空列表返回空分组', () => {
        const groups = groupTodosByDate([], todayStr);
        assert.equal(groups.todayGroup.length, 0);
        assert.equal(groups.noDateGroup.length, 0);
    });

    it('过期的周/月打卡归入 pastGroup，未来的周/月打卡归入 futureGroup', () => {
        const todos = [
            { date: '2026-W25', content: 'past week', task_type: 'weekly_checkin' },
            { date: '2026-W27', content: 'future week', task_type: 'weekly_checkin' },
            { date: '2026-05', content: 'past month', task_type: 'monthly_checkin' },
            { date: '2026-07', content: 'future month', task_type: 'monthly_checkin' },
        ];
        // todayStr is '2026-06-28', which belongs to week '2026-W26' and month '2026-06'
        const groups = groupTodosByDate(todos, todayStr);
        assert.equal(groups.weekGroup.length, 0);
        assert.equal(groups.monthGroup.length, 0);
        assert.equal(groups.pastGroup.length, 2); // 2026-W25 and 2026-05
        assert.equal(groups.futureGroup.length, 2); // 2026-W27 and 2026-07
    });
});
