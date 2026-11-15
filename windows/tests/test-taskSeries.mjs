import { it } from 'node:test';
import { exportReviews } from '../src/reviewUtils.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTodo } from '../src/dateUtils.js';
import { normalizeSeriesData, mergeSeriesData, importPeriods, importCandidates, currentPeriod, seriesFor, displayTaskName, associationPreview, associationSummary, associatePeriods, unlinkPeriod, unlinkPreview, unlinkPeriods, timingPendingReason, deletePreview, deletePeriods, savePeriodEdit, periodRange } from '../src/taskSeries.js';
import { mergeTodoData, hasTodoDataContentChanges } from '../src/dataMerge.js';
import { recentTimingTasks, timingTodos, resolveLearningEntries, summarizeLearning, taskReference } from '../src/timeTracking.js';
import { compareSeriesPeriod } from '../src/periodTaskView.js';

const now = '2026-10-15T12:00:00+08:00';
const todo = (date = '2026-W41') => ({ ...createTodo('抽象代数', date), task_type: 'weekly_checkin', created_at: '2026-10-01T09:00:00+08:00', updated_at: now, target_count: 5 });
function initial() { return normalizeSeriesData({ version: 1, last_updated: now, todos: [todo()], time_entries: [], daily_reviews: [{ id: 'r', fact: '保留复盘' }], reminder_settings: { enabled: true } }); }
function continued() { const d = initial(); return importPeriods(d, d.todos, '2026-W42', now); }
const timer = (t, id = crypto.randomUUID(), start = '2026-10-14T09:00:00+08:00', end = '2026-10-14T10:00:00+08:00') => ({ id, task_ref: taskReference(t), task_content_snapshot: '旧名称', started_at: start, ended_at: end, updated_at: now, created_at: now, deleted: false });

const linkFixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/series-links/conflicts.json', import.meta.url), 'utf8'));
for (const sample of linkFixtures.cases) {
    it(`系列关联：${sample.id}`, () => {
        const a = { ...linkFixtures.base, ...sample.a };
        const b = { ...linkFixtures.base, ...sample.b };
        const data = link => ({ version: 1, last_updated: now, todos: [], task_series_links: [link] });
        const expected = [sample.winner === 'a' ? a : b];
        assert.deepEqual(mergeTodoData(data(a), data(b)).data.task_series_links, expected);
        assert.deepEqual(mergeTodoData(data(b), data(a)).data.task_series_links, expected);
    });
}

const nameFixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/series-names/conflicts.json', import.meta.url), 'utf8'));
for (const sample of nameFixtures.cases) {
    it(`系列名称：${sample.id}`, () => {
        const a = { ...nameFixtures.base, ...sample.a };
        const b = { ...nameFixtures.base, ...sample.b };
        const data = series => ({ version: 1, last_updated: now, todos: [], task_series: [series] });
        const winner = sample.winner === 'a' ? a : b;
        const expected = [{ ...winner, deleted: sample.deleted_at !== null, deleted_at: sample.deleted_at }];
        assert.deepEqual(mergeTodoData(data(a), data(b)).data.task_series, expected);
        assert.deepEqual(mergeTodoData(data(b), data(a)).data.task_series, expected);
    });
}

it('关联摘要按不同周期计数，保留已清理历史，只提示同类型未关联同名任务', () => {
    const d = continued(), current = d.todos[1];
    assert.equal(associationSummary(d, current.id).unlinkedSameName.length, 0);
    d.todos.shift();
    const other = todo('2026-W39'); other.content = '  抽象代数  ';
    d.todos.push(other, { ...todo('2026-09'), task_type: 'monthly_checkin' }, { ...todo(), deleted: true });
    const summary = associationSummary(d, current.id);
    assert.deepEqual(summary.periods, ['2026-W41', '2026-W42']);
    assert.equal(summary.sameNameCount, 1); assert.deepEqual(summary.unlinkedSameName.map(t => t.id), [other.id]);
    const standalone = associationSummary(d, other.id);
    assert.equal(standalone.series, null); assert.deepEqual(standalone.periods, []);
    d.task_series_links.push({ ...d.task_series_links[0], todo_id: crypto.randomUUID() });
    assert.equal(associationSummary(d, current.id).periods.length, 2);
});

for (const [kind, periods, firstTime, nextTime] of [
    ['weekly_checkin', ['2026-W40', '2026-W41', '2026-W42'], '2026-10-08T12:00:00+08:00', now],
    ['monthly_checkin', ['2026-08', '2026-09', '2026-10'], '2026-09-15T12:00:00+08:00', now],
]) it(`${kind} 从长期任务往期导入自动沿用关联、当前名称，并保留原记录`, () => {
    const base = initial(); base.todos[0] = { ...todo(periods[0]), task_type: kind };
    const d = importPeriods(base, base.todos, periods[1], firstTime), s = d.task_series[0];
    Object.assign(s, { content: '长期任务新名称', content_renamed: true, content_updated_at: firstTime });
    d.todos.push({ ...todo(periods[2]), task_type: kind, content: s.content });
    d.time_entries.push(timer(d.todos[0])); const before = structuredClone(d);
    const result = importPeriods(d, [d.todos[0]], periods[2], nextTime);
    const imported = result.todos.at(-1);
    assert.equal(seriesFor(result, imported.id).id, s.id);
    assert.equal(imported.content, s.content); assert.equal(result.task_series.length, 1);
    assert.equal(associationSummary(result, imported.id).periods.length, 3);
    assert.equal(seriesFor(result, d.todos.at(-1).id), null);
    assert.deepEqual(result.todos.slice(0, -1), before.todos); assert.deepEqual(result.time_entries, before.time_entries);
    assert.deepEqual(d, before);
    assert.throws(() => importPeriods(result, [d.todos[0]], periods[2], nextTime), /已存在/);
});

it('解除本期或全部只改变关联，包含已清理历史，晚到关联使确认失效', () => {
    const d = continued(), current = d.todos[1]; d.time_entries.push(timer(d.todos[0])); d.todos.shift();
    const other = todo('2026-W39'); d.todos.push(other);
    const one = unlinkPeriods(d, unlinkPreview(d, current.id), now);
    assert.equal(one.task_series_links.filter(l => !l.deleted).length, 1);
    const preview = unlinkPreview(d, current.id, true), all = unlinkPeriods(d, preview, now);
    assert.ok(all.task_series_links.every(l => l.deleted && l.next_series_id));
    assert.equal(new Set(all.task_series_links.map(l => l.next_series_id)).size, 2);
    assert.deepEqual(all.todos, d.todos); assert.deepEqual(all.time_entries, d.time_entries); assert.deepEqual(all.task_series, d.task_series);
    assert.ok(mergeSeriesData(d, all).task_series_links.every(l => l.deleted));
    const changed = structuredClone(d); changed.task_series_links.push({ ...changed.task_series_links[0], todo_id: crypto.randomUUID(), period: '2026-W39' });
    assert.throws(() => unlinkPeriods(changed, preview), /范围已变化/);
    assert.equal(changed.task_series_links.filter(l => l.deleted).length, 0);
});

it('旧集合默认值、新成员完整性及 ISO 跨年周', () => {
    assert.deepEqual(initial().task_series, []);
    assert.equal(periodRange('2026-W53')?.start.getFullYear(), 2026); assert.equal(periodRange('2025-W53'), null); assert.equal(periodRange('2026-13'), null);
    assert.throws(() => normalizeSeriesData({ task_series: [{}] }), /异常/);
    assert.throws(() => normalizeSeriesData({ task_series: null }), /异常/);
    for (const [key, value] of [['deleted', null], ['content_renamed', null], ['deleted_at', '无效']]) {
        const d = continued(); d.task_series[0][key] = value; assert.throws(() => normalizeSeriesData(d), /异常/);
    }
});
it('导入不改源时间戳，按身份判重，同名独立任务仍可导入', () => {
    const base = initial(), source = structuredClone(base.todos[0]), d = importPeriods(base, base.todos, '2026-W42', now);
    assert.deepEqual(d.todos[0], source); assert.equal(d.task_series.length, 1); assert.equal(d.task_series_links.length, 2);
    assert.throws(() => importPeriods(d, [d.todos[0]], '2026-W42', now), /已存在/);
    const independent = initial(); independent.todos.push(todo('2026-W42'));
    assert.equal(importPeriods(independent, [independent.todos[0]], '2026-W42', now).todos.length, 3);
    assert.throws(() => importPeriods(base, base.todos, '2026-W43', now), /周期已变化/);
});
it('并发导入保留两条本期记录；重复期不可计时或默认作参考', () => {
    const base = initial(), a = importPeriods(base, base.todos, '2026-W42', now), b = importPeriods(base, base.todos, '2026-W42', now), d = mergeTodoData(a, b).data;
    assert.equal(d.todos.length, 3); assert.equal(d.task_series.length, 1); assert.equal(timingTodos(d, new Date(now)).length, 0);
    const next = new Date('2026-10-21T12:00:00+08:00'), candidate = importCandidates(d, 'week', next)[0];
    assert.equal(candidate.todo, null); assert.equal(candidate.choices.filter(c => c.duplicate).length, 2);
    assert.equal(importPeriods(d, [d.todos.find(t => t.date === '2026-W41')], '2026-W43', next.toISOString()).todos.length, 4);
});
it('明确改名胜过较晚初始化，删除独立保留；合并交换、幂等及不同顺序稳定', () => {
    const base = continued(), a = structuredClone(base), b = structuredClone(base), c = structuredClone(base);
    Object.assign(a.task_series[0], { content: '新名称', content_renamed: true, content_updated_at: '2026-10-15T10:00:00+08:00', updated_at: now });
    Object.assign(b.task_series[0], { content: '离线旧名称', content_updated_at: '2026-10-15T13:00:00+08:00', updated_at: '2026-10-15T13:00:00+08:00' });
    Object.assign(c.task_series[0], { deleted: true, deleted_at: now, updated_at: now });
    const ab = mergeSeriesData(a, b); assert.deepEqual(ab, mergeSeriesData(b, a)); assert.equal(ab.task_series[0].content, '新名称');
    const abc = mergeSeriesData({ ...base, ...ab }, c);
    assert.deepEqual(abc, mergeSeriesData({ ...base, ...mergeSeriesData(a, c) }, b)); assert.ok(abc.task_series[0].deleted);
    assert.deepEqual(mergeSeriesData({ ...base, ...abc }, a), abc); assert.ok(hasTodoDataContentChanges(a, base));
    const equivalent = structuredClone(a); equivalent.task_series[0].content_updated_at = '2026-10-15T02:00:00Z';
    assert.deepEqual(mergeSeriesData(a, equivalent), mergeSeriesData(equivalent, a));
});
it('重复解除不生成新身份，解除后延续不回旧系列', () => {
    const d = continued(), id = d.todos[0].id, old = seriesFor(d, id).id;
    unlinkPeriod(d, id, now); const reserved = d.task_series_links.find(l => l.todo_id === id).next_series_id;
    unlinkPeriod(d, id, now); assert.equal(d.task_series_links.find(l => l.todo_id === id).next_series_id, reserved);
    const result = importPeriods(d, [d.todos[0]], '2026-W42', now);
    assert.equal(seriesFor(result, id).id, reserved); assert.notEqual(reserved, old);
});
it('整体关联包含已清理成员；重复和预览变化阻断提交', () => {
    const d = continued(), archived = d.todos[0].id; d.time_entries.push(timer(d.todos[0])); d.todos = d.todos.filter(t => t.id !== archived);
    const other = todo('2026-W40'); other.content = '历史名称'; d.todos.push(other);
    const ids = d.todos.map(t => t.id), p = associationPreview(d, other.id, ids), result = associatePeriods(d, p, ids, now);
    assert.equal(seriesFor(result, archived).id, seriesFor(result, other.id).id); assert.equal(result.time_entries[0].task_ref.todo_id, archived);
    const changed = structuredClone(d); changed.todos.push(todo('2026-W42')); const selected = changed.todos.map(t => t.id);
    assert.throws(() => associatePeriods(changed, associationPreview(changed, other.id, selected), selected), /重复/);
    assert.throws(() => associatePeriods(changed, p, selected), /范围已变化/);
});
it('删除只停止已展示计时；晚到记录七天清理后仍待核对，真实停止可合并', () => {
    const d = continued(), t = d.todos[1]; d.time_entries.push(timer(t, 'known', '2026-10-15T11:59:50+08:00', null));
    const preview = deletePreview(d, t.id), late = timer(t, 'late', '2026-10-15T11:59:55+08:00', null); d.time_entries.push(late);
    const result = deletePeriods(d, preview, now);
    assert.equal(result.time_entries.find(e => e.id === 'known').ended_at, now); assert.equal(result.time_entries.find(e => e.id === 'known').deleted, false);
    assert.equal(result.time_entries.find(e => e.id === 'late').ended_at, null); assert.match(timingPendingReason(result, late), /已删除/);
    result.todos = result.todos.filter(x => x.id !== t.id); assert.match(timingPendingReason(result, late), /不可用/);
    const stopped = { ...late, ended_at: '2026-10-15T12:00:30+08:00', updated_at: '2026-10-15T12:00:30+08:00' };
    assert.equal(mergeTodoData(result, { ...result, time_entries: [stopped] }).data.time_entries.find(e => e.id === 'late').ended_at, stopped.ended_at);
    const foreign = { ...late, task_ref: { ...late.task_ref, source_type: 'collaboration', source_id: 'remote' } };
    assert.equal(timingPendingReason(result, foreign), '');
    assert.equal(resolveLearningEntries([foreign], [], { data: result, source: { type: 'personal' } })[0].pending_reason, '');
    assert.match(resolveLearningEntries([foreign], [], { data: result, source: { type: 'collaboration', id: 'remote' } })[0].pending_reason, /不可用/);
});
it('全部删除只作用于系列，普通删除保留短计时和其他扩展数据', () => {
    const d = continued(), independent = { ...todo(), task_type: 'normal', date: null }; d.todos.push(independent);
    d.time_entries.push(timer(independent, 'independent', '2026-10-15T11:59:50+08:00', null));
    const all = deletePeriods(d, deletePreview(d, d.todos[0].id, true), now);
    assert.equal(all.todos.find(t => t.id === independent.id).deleted, false); assert.equal(all.time_entries[0].ended_at, null);
    const single = deletePeriods(all, deletePreview(all, independent.id), now);
    assert.equal(single.time_entries[0].deleted, false); assert.equal(single.time_entries[0].ended_at, now); assert.deepEqual(single.daily_reviews, d.daily_reviews);
});
it('编辑只提交实际字段，改名不改历史 Todo 时钟，数组冲突零写入', () => {
    const baseline = continued(), latest = structuredClone(baseline), t = baseline.todos[1];
    Object.assign(latest.task_series[0], { content: '同步新名', content_renamed: true, content_updated_at: now });
    const result = savePeriodEdit(latest, t, { ...t, target_count: 8 }, baseline.task_series[0], now);
    assert.equal(displayTaskName(result, t.id), '同步新名'); assert.equal(result.todos[1].target_count, 8);
    const renamed = savePeriodEdit(baseline, t, { ...t, content: '改名' }, baseline.task_series[0], now);
    assert.deepEqual(renamed.todos, baseline.todos);
    assert.equal(renamed.task_series[0].content_renamed, true);
    for (const member of baseline.todos) assert.equal(displayTaskName(renamed, member.id), '改名');
    const independent = todo();
    renamed.todos.push(independent);
    assert.equal(displayTaskName(renamed, independent.id), independent.content);
    latest.todos[1].completed_dates = ['2026-10-13'];
    assert.throws(() => savePeriodEdit(latest, t, { ...t, completed_dates: ['2026-10-14'] }, baseline.task_series[0], now), /变化/);
    assert.deepEqual(latest.todos[1].completed_dates, ['2026-10-13']);
});
it('旧计时显示当前名称而快照不变，缺失个人引用只计待核对', () => {
    const d = continued(), e = timer(d.todos[0]); d.task_series[0].content = '统一新名';
    const tasks = d.todos.map(todo => ({ todo, ref: taskReference(todo) })), context = { data: d, source: { type: 'personal' } };
    assert.equal(resolveLearningEntries([e], tasks, context)[0].display_content, '统一新名'); assert.equal(e.task_content_snapshot, '旧名称');
    const missing = { ...e, ended_at: null, task_ref: { ...e.task_ref, todo_id: crypto.randomUUID() } };
    const summary = summarizeLearning(resolveLearningEntries([missing], tasks, context), '2026-10-14', '2026-10-15');
    assert.equal(summary.pending, 1); assert.equal(summary.running, 0);
    d.time_entries = [missing]; d.daily_reviews = [{ date: '2026-10-14', fact: '核对记录' }];
    const exported = exportReviews(d, 'day', '2026-10-14T12:00:00').content;
    assert.match(exported, /1 条待核对记录未计入/); assert.doesNotMatch(exported, /条进行中记录未计入/);
});
it('最近计时按系列去重，定位唯一可计时本期，跨周时长守恒', () => {
    const date = new Date(), target = currentPeriod('week', date), previous = new Date(date); previous.setDate(previous.getDate() - 7);
    const d = initial(); d.todos[0].date = currentPeriod('week', previous); const result = importPeriods(d, d.todos, target, date.toISOString());
    result.time_entries = Array.from({ length: 6 }, (_, i) => timer(result.todos[0], String(i)));
    const recent = recentTimingTasks(result.todos, result.time_entries, result); assert.equal(recent.length, 1); assert.equal(recent[0].todo.id, result.todos[1].id);
    const cross = continued(); cross.time_entries = [timer(cross.todos[0], 'cross', '2026-10-11T23:30:00+08:00', '2026-10-12T00:30:00+08:00')];
    const id = seriesFor(cross, cross.todos[0].id).id, a = compareSeriesPeriod(cross, id, '2026-W41'), b = compareSeriesPeriod(cross, id, '2026-W42');
    assert.equal(a.duration + b.duration, 3600000);
    if (new Date(now).getTimezoneOffset() === -480) { assert.equal(a.duration, 1800000); assert.equal(b.duration, 1800000); }
});

it('周期对比区分缺失与零、裁剪同期截止，并隔离同 ID 的协作引用', () => {
    const d = continued(), t = d.todos[0], id = seriesFor(d, t.id).id;
    const e = timer(t, 'cross', '2026-10-11T23:30:00+08:00', '2026-10-12T00:30:00+08:00');
    const foreign = { ...timer(t, 'foreign', '2026-10-12T01:00:00+08:00', '2026-10-12T02:00:00+08:00'), task_ref: { todo_id: t.id, source_type: 'collaboration', source_id: 'remote' } };
    d.time_entries = [e, foreign];
    const full = compareSeriesPeriod(d, id, '2026-W42');
    const partial = compareSeriesPeriod(d, id, '2026-W42', new Date('2026-10-12T00:15:00+08:00'));
    if (new Date(now).getTimezoneOffset() === -480) { assert.equal(full.duration, 1800000); assert.equal(partial.duration, 900000); }
    assert.equal(compareSeriesPeriod(d, id, '2026-W40').available, false);
    const empty = structuredClone(d); empty.time_entries = []; assert.equal(compareSeriesPeriod(empty, id, '2026-W42').available, true);
    assert.equal(compareSeriesPeriod(empty, id, '2026-W42').duration, 0);
    const tasks = d.todos.map(todo => ({ todo, ref: taskReference(todo) }));
    assert.equal(resolveLearningEntries([foreign], tasks, { data: d, source: { type: 'personal' } })[0].display_content, '旧名称');
});
