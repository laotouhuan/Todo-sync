import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePlanText, mergePlanningData, planningCalendar, planningChange, ratingAverage, ratingSummary, weeklyPlanState } from '../src/weeklyPlanning.js';
import { PLANNING_OPERATION_SET, replayPersonalRecords } from '../src/recordReplay.js';
import { exportReviews } from '../src/reviewUtils.js';

const week = '2026-11-09', time = week + 'T09:00:00Z';
const baseline = { version: 1, last_updated: time, todos: [] };
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const parent = record => ({ id: record.id });
const replay = records => replayPersonalRecords(baseline, records, PLANNING_OPERATION_SET);
const action = (records, details, number, at = time) => {
    const operation = planningChange(replay(records), { week, ...details }, { id: id(number), at });
    return { id: id(number), created_at: at, operations: [operation], parents: records.map(parent) };
};
const days = first => [first, '', '', '', '', '', ''];
const save = (records, number, text) => action(records, { kind: 'save', days: days(text), reason: '',
    tips: weeklyPlanState(replay(records), week).tips, versionId: id(number + 100) }, number);
const tips = records => weeklyPlanState(replay(records), week).tips;

test('评分覆盖使用完整日历月并过滤清除、删除及月历补位日期', () => {
    const entry = (number, date, score, deleted = false, updated_at = time) =>
        ({ id: id(number), date, score, deleted, created_at: time, updated_at });
    const data = { daily_ratings: [
        entry(1, '2024-02-01', 4), entry(2, '2024-02-01', 2, false, '2026-11-09T08:00:00Z'),
        entry(3, '2024-02-02', null), entry(4, '2024-02-03', 1, true),
        entry(5, '2024-01-31', 5), entry(6, '2024-03-01', 5)
    ] };
    assert.deepEqual(ratingSummary(data, '2024-02-01', '2024-02-29'), { average: '4.0', count: 1, days: 29 });
    assert.deepEqual(ratingSummary(data, '2025-02-01', '2025-02-28'), { average: null, count: 0, days: 28 });
});

test('离线分歧、同时采用、历史互删和从空白重新制定保持因果关系', () => {
    const first = save([], 1, '初版');
    const a = save([first], 2, '修订一');
    const b = save([first], 3, '修订二');
    const both = [first, a, b];
    assert.equal(weeklyPlanState(replay(both), week).state, 'conflict');
    assert.deepEqual(replay(both), replay([first, b, a]));
    const selectA = action(both, { kind: 'resolve', versionId: id(102), tips: tips(both) }, 4);
    const selectB = action(both, { kind: 'resolve', versionId: id(103), tips: tips(both) }, 5);
    const selectA2 = action(both, { kind: 'resolve', versionId: id(102), tips: tips(both) }, 6);
    assert.equal(weeklyPlanState(replay([...both, selectA, selectA2]), week).current.id, id(102));
    const deleteB = action([...both, selectA], { kind: 'delete', versionId: id(103), tips: [id(4)] }, 7);
    const deleteA = action([...both, selectB], { kind: 'delete', versionId: id(102), tips: [id(5)] }, 8);
    const deleted = [...both, selectA, selectB, deleteB, deleteA];
    assert.equal(weeklyPlanState(replay(deleted), week).state, 'restart');
    const restarted = save(deleted, 9, '新计划');
    assert.equal(restarted.operations[0].version.base_version_id, null);
    assert.deepEqual(restarted.operations[0].selection.parent_selection_ids, [id(4), id(5)]);
    const cleared = save([...deleted, restarted], 10, '');
    const result = replay([...deleted, restarted, cleared]);
    assert.deepEqual(weeklyPlanState(result, week).current.days, days(''));
    assert.equal(result.weekly_plan_versions.filter(version => version.deleted).length, 2);
});

test('拒绝缺失、跨周、循环关系和无法从该记录已知状态产生的删除', () => {
    const first = save([], 1, '原版'), next = save([first], 2, '新版');
    const data = replay([first, next]);
    for (const modify of [
        row => ({ ...row, parent_selection_ids: [id(99)] }),
        row => ({ ...row, parent_selection_ids: [id(2)] }),
        row => ({ ...row, week_start: '2026-11-16' })
    ]) assert.throws(() => mergePlanningData({ ...data, weekly_plan_selections: [data.weekly_plan_selections[0],
        modify(data.weekly_plan_selections[1])] }), /INVALID_WEEKLY_PLAN_RELATION/);
    const removed = action([first, next], { kind: 'delete', versionId: id(101), tips: [id(2)] }, 3);
    assert.throws(() => replay([first, next, { ...removed, parents: [parent(first)] }]), /WEEKLY_PLAN_STALE/);
    assert.throws(() => mergePlanningData(data, { weekly_plan_versions: [{ ...data.weekly_plan_versions[0], days: days('被改写') }] }),
        /WEEKLY_PLAN_ID_CONFLICT/);
});

test('同毫秒清除优先，随后重新评分生效，平均值保留一位小数', () => {
    const initial = action([], { kind: 'rate', date: week, score: 2 }, 1);
    const sameTime = week + 'T17:00:00.0009+08:00';
    const clear = action([initial], { kind: 'rate', date: week, score: null }, 2, sameTime);
    const change = action([initial], { kind: 'rate', date: week, score: 5 }, 3, sameTime);
    const branches = [initial, clear, change];
    assert.equal(replay(branches).daily_ratings[0].score, null);
    assert.equal(ratingAverage(replay(branches), week, week), null);
    const later = action(branches, { kind: 'rate', date: week, score: 2 }, 4, week + 'T09:00:00.001Z');
    const other = action([...branches, later], { kind: 'rate', date: '2026-11-10', score: 5 }, 5);
    assert.equal(ratingAverage(replay([...branches, later, other]), week, '2026-11-15'), '3.5');
    assert.throws(() => action([], { kind: 'rate', date: week, score: 1.5 }, 6), /INVALID_PLANNING_DATA/);
});

test('月评分格补齐两侧日期，跨年周保留周一及周日', () => {
    const month = planningCalendar('2026-01-01', true);
    assert.deepEqual([month.cells[0], month.cells.at(-1)], [
        { date: '2025-12-29', inRange: false }, { date: '2026-02-01', inRange: false }
    ]);
    assert.equal(month.cells.filter(day => day.inRange).length, 31);
    assert.equal(planningCalendar('2026-01-01').last, '2026-01-04');
});

test('保留 emoji 完整性，新增导出选项转义计划文本且保留旧复盘格式', () => {
    assert.deepEqual(comparePlanText('😀第1天🙂', '😀第2天🙂'), { before: '😀第', removed: '1', added: '2', after: '天🙂' });
    const version = save([], 1, '<b>计划</b>');
    const view = { ...replay([version]), daily_reviews: [{ date: week, fact: '**原有格式**' }] };
    const call = (data, options) => exportReviews(data, 'day', week + 'T12:00:00', false, undefined, undefined, undefined, options);
    assert.equal(call(view, {}).content, call({ ...view, weekly_plan_versions: [] }, {}).content);
    const { content } = call(view, { includePlans: true, includePlanHistory: true });
    assert.ok(content.includes('**原有格式**'));
    assert.ok(content.includes('\\<b\\>计划\\<\\/b\\>'));
    assert.match(content, /## 周计划历史/);
    const history = call(replay([version]), { includePlanHistory: true }).content;
    assert.doesNotMatch(history, /^## 2026-11-09$/m);
    assert.match(history, /2026-11-15/);
});

test('新旧周计划操作混合重放，重点保留在历史并仅按周导出一次', () => {
    const legacy = save([], 1, '旧计划');
    assert.equal(Object.hasOwn(legacy.operations[0].version, 'focus'), false);
    const initialFocus = action([], { week: '2026-11-16', kind: 'save', versionId: id(102),
        tips: [], days: days(''), reason: '', focus: '准备 <例题>\n第二行 😀' }, 2);
    const oldFocus = initialFocus.operations[0].version.focus;
    const later = action([legacy, initialFocus], { week: '2026-11-16', kind: 'save', versionId: id(103),
        tips: [id(2)], days: days(''), reason: '调整', focus: '新的重点' }, 3);
    const records = [legacy, initialFocus, later];
    const data = replay(records);
    assert.equal(weeklyPlanState(data, week).current.focus, '');
    assert.equal(weeklyPlanState(data, '2026-11-16').current.focus, '新的重点');
    assert.equal(weeklyPlanState(data, '2026-11-16').history[0].focus, oldFocus);
    const equivalent = structuredClone(legacy);
    equivalent.operations[0].version.focus = '';
    assert.deepEqual(replay([equivalent, initialFocus, later]), data);
    assert.throws(() => action([], { kind: 'save', versionId: id(104), tips: [], days: days(''), reason: '', focus: '\n  ' }, 4));
    assert.throws(() => mergePlanningData(data, { weekly_plan_versions: [{ ...data.weekly_plan_versions[1], focus: '篡改' }] }),
        /WEEKLY_PLAN_ID_CONFLICT/);
    const { content } = exportReviews(data, 'month', '2026-11-16T12:00:00', false, undefined, undefined, undefined,
        { includePlans: true, includePlanHistory: true });
    assert.equal(content.match(/^### 本周重点$/gm).length, 1);
    assert.match(content, /准备 \\<例题\\>\n第二行 😀/);
});
