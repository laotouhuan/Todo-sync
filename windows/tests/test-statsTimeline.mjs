import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableLabels, resolveLearningEntries, taskReference, summarizeLearning } from '../src/timeTracking.js';
import { exportReviews } from '../src/reviewUtils.js';
import { collectSubtaskEvents, collectTimerArcs, arcPath, hitArcs, clockMinute, clockTooltipDateTime } from '../src/statsTimeline.js';
process.env.TZ = 'Asia/Shanghai';
const source = { type: 'personal' }, day = '2026-09-10T12:00:00';
const entry = (id, start = '2026-09-10T09:00:00+08:00', end = '2026-09-10T10:30:00+08:00') => ({ id, task_ref: taskReference({ id: 'task' }), started_at: start, ended_at: end, updated_at: start, created_at: start, label_snapshot: '错字' });

test('悬浮日期不显示年、时间不显示秒，按本地日期处理跨日和补打卡', () => {
    assert.deepEqual(clockTooltipDateTime('2026-09-10T16:05:59.999Z'), { date: '09-11', time: '00:05' });
    assert.deepEqual(clockTooltipDateTime('2026-09-10'), { date: '09-10', time: '' });
    assert.deepEqual(clockTooltipDateTime(Date.parse('2026-12-31T16:00:00Z')), { date: '01-01', time: '00:00' });
});

test('钟面刻度保留秒与毫秒，相邻完成时间顺序准确且与计时圆弧一致', () => {
    const times = ['2026-09-10T13:59:59.999+08:00', '2026-09-10T06:00:00Z', '2026-09-10T14:00:00.001+08:00'];
    const minutes = times.map(clockMinute);
    assert.ok(minutes[0] < minutes[1] && minutes[1] < minutes[2]);
    assert.equal(minutes[1], 840);
    assert.ok(Math.abs(minutes[2] - minutes[1] - 1 / 60000) < 1e-9);
    const arcs = collectTimerArcs([entry('precise', times[0], times[2])], source, 'day', day);
    assert.equal(arcs[0].startMinute, minutes[0]);
    assert.ok(Math.abs(arcs[0].endMinute - minutes[2]) < 1e-9);
    assert.equal(clockMinute('2026-09-10T16:00:00Z'), 0);
});

test('标签候选仅取未删除任务，包含完成任务；改正、删除和恢复实时反映', () => {
    const tasks = [{ id: 'a', label: '数学习' }, { id: 'b', label: '阅读', completed: true }, { label: '删除', deleted: true }, { label: '未分类' }];
    assert.deepEqual(availableLabels(tasks), ['数学习', '阅读']);
    tasks[0].label = ' 数学 '; assert.deepEqual(availableLabels(tasks), ['数学', '阅读']);
    tasks[0].deleted = true; assert.deepEqual(availableLabels(tasks), ['阅读']);
    tasks[0].deleted = false; tasks.push({ label: '数学' }); assert.deepEqual(availableLabels(tasks), ['数学', '阅读']);
    assert.deepEqual(availableLabels([{ label: 'e\u0301' }, { label: 'é' }]), ['é']);
});
test('历史记录按当前任务归类，空标签覆盖快照，原始记录不被修改', () => {
    const raw = [entry('a'), entry('b', '2026-09-11T09:00:00+08:00', '2026-09-11T10:00:00+08:00')];
    const before = structuredClone(raw), todo = { id: 'task', label: '阅读' }, tasks = [{ todo, ref: taskReference(todo) }];
    const resolved = resolveLearningEntries(raw, tasks);
    assert.deepEqual(resolved.map(e => e.label_snapshot), ['阅读', '阅读']);
    assert.equal(summarizeLearning(resolved, '2026-09-07', '2026-09-14').count, 2);
    assert.ok(exportReviews({ todos: [todo], time_entries: raw }, 'week', day).content.includes('| 阅读 |'));
    todo.label = null; assert.deepEqual(resolveLearningEntries(raw, tasks).map(e => e.label_snapshot), [null, null]);
    assert.deepEqual(raw, before);
});
test('完整来源隔离，软删除任务沿用当前标签，缺失任务使用统一最新回退', () => {
    const a = entry('a'), b = { ...entry('z'), label_snapshot: '回退' };
    const collab = { ...a, id: 'collab', task_ref: { ...a.task_ref, source_type: 'collaboration', source_id: 'x' } };
    const todo = { id: 'task', label: '新标签', deleted: true };
    const out = resolveLearningEntries([a, b, collab], [{ todo, ref: taskReference(todo) }]);
    assert.deepEqual(out.map(e => e.label_snapshot), ['新标签', '新标签', '错字']);
    assert.equal(out[0].task_deleted, true); assert.equal(out[2].task_unavailable, true);
    assert.deepEqual(resolveLearningEntries([a, b], []).map(e => e.label_snapshot), ['回退', '回退']);
    assert.deepEqual(resolveLearningEntries([b, a], []).map(e => e.label_snapshot), ['回退', '回退']);
});
test('父任务未完成且日期在本期之外，子步骤按自己时间纳入，不改变任务状态', () => {
    const todo = { id: 'task', date: '2030-01-01', completed: false, subtasks: [
        { id: 's', completed: true, completed_at: '2026-09-09T17:30:00Z' },
        { id: 'date', completed: true, completed_at: '2026-09-10' },
        { id: 'none', completed: true }, { id: 'not', completed: false, completed_at: '2026-09-10T12:00:00Z' }
    ] };
    const before = structuredClone(todo), events = collectSubtaskEvents([todo], 'day', day);
    assert.equal(events.length, 2); assert.equal(events[0].date, '2026-09-10'); assert.equal(events[1].explicit, false);
    assert.deepEqual(todo, before); assert.equal(collectSubtaskEvents([{ ...todo, deleted: true }], 'day', day).length, 0);
});
test('90 分钟圆弧及全圆路径、短记录点击容差', () => {
    const arcs = collectTimerArcs([entry('a')], source, 'day', day);
    assert.equal(arcs[0].startMinute, 540); assert.equal(arcs[0].endMinute, 630);
    assert.equal(arcs[0].duration, 5400000); assert.equal(hitArcs(arcs, 600).length, 1); assert.equal(hitArcs(arcs, 700).length, 0);
    assert.equal((arcPath(0, 0, 10, 0, 1440).match(/ A /g) || []).length, 2);
    const short = collectTimerArcs([entry('b', '2026-09-10T09:00:00+08:00', '2026-09-10T09:00:01+08:00')], source, 'day', day);
    assert.ok(short[0].endMinute - short[0].startMinute < 1); assert.equal(hitArcs(short, 541, 2).length, 1);
});
test('跨午夜分片、午夜终点、跨月按真实日期切分并每天计次', () => {
    const e = entry('a', '2026-09-30T23:30:00+08:00', '2026-10-01T00:30:00+08:00');
    const a = collectTimerArcs([e], source, 'month', day), b = collectTimerArcs([e], source, 'month', '2026-10-01T12:00:00');
    assert.deepEqual([a[0].startMinute, a[0].endMinute, b[0].startMinute, b[0].endMinute], [1410, 1440, 0, 30]);
    assert.equal(a[0].duration + b[0].duration, 3600000);
    assert.equal(collectTimerArcs([{ ...e, ended_at: '2026-10-01T00:00:00+08:00' }], source, 'month', '2026-10-01T12:00:00').length, 0);
});
test('多日钟面重叠允许，真实冲突、运行、删除和其他来源不绘制', () => {
    const a = entry('a'), b = entry('b', '2026-09-11T09:00:00+08:00', '2026-09-11T10:00:00+08:00');
    assert.equal(hitArcs(collectTimerArcs([a, b], source, 'week', day), 550).length, 2);
    assert.equal(collectTimerArcs([a, { ...a, id: 'conflict' }], source, 'day', day).length, 0);
    for (const e of [{ ...a, ended_at: null }, { ...a, deleted: true }, { ...a, ended_at: 'bad' }, { ...a, task_ref: { ...a.task_ref, source_type: 'collaboration', source_id: 'x' } }])
        assert.equal(collectTimerArcs([e], source, 'day', day).length, 0);
});
test('夏令时跳进与回拨按钟面分段，统计保留 23/25 小时', () => {
    process.env.TZ = 'America/New_York';
    try {
        const spring = entry('a', '2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00');
        const arcs = collectTimerArcs([spring], source, 'day', '2026-03-08T12:00:00');
        assert.deepEqual(arcs.map(a => [a.startMinute, a.endMinute]), [[0, 120], [180, 1440]]);
        assert.equal(summarizeLearning([spring], '2026-03-08', '2026-03-09').duration, 23 * 3600000);
        const fall = entry('b', '2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00');
        assert.deepEqual(collectTimerArcs([fall], source, 'day', '2026-11-01T12:00:00').map(a => [a.startMinute, a.endMinute]), [[0, 120], [60, 1440]]);
        assert.equal(summarizeLearning([fall], '2026-11-01', '2026-11-02').duration, 25 * 3600000);
    } finally { process.env.TZ = 'Asia/Shanghai'; }
});
