import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, snapshotHash, createRecord, project } from '../protocol.mjs';

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const time = '2026-11-05T08:00:00+08:00';
const week = '2026-11-02';
const snapshot = { protocol: 1, dataset_id: id(1), data: { version: 1, last_updated: time,
    todos: [{ id: 'todo-1', content: '原内容', completed: false, deleted: false, label: '原分类', date: null,
        created_at: time, updated_at: time, subtasks: [{ id: 'subtask-1', content: '保留子任务' }], custom: { kept: true } }],
    time_entries: [{ id: 'timer-1', payload: '原计时' }], reminder_settings: { enabled: true },
    task_series: [{ id: 'series-1' }], custom_data: { preserve: true } } };
const patch = fields => ({ type: 'todo.patch', todo_id: 'todo-1', fields });
const make = (number, operations, known = [], actor = id(100), created_at = time) =>
    createRecord(snapshot, known, { id: id(number), actor_id: actor, created_at, operations });
const version = (name, base = null, text = name) => ({ id: name, week_start: week, base_version_id: base,
    days: [text, '', '', '', '', '', ''], change_reason: '' });
const selection = (name, target, parents = [], kind = 'save') => ({ id: name, week_start: week,
    version_id: target, parent_selection_ids: parents, kind });
const plan = (name, base = null, parent = []) => [{ type: 'plan.version.add', version: version(name, base) },
    { type: 'plan.selection.add', selection: selection('selection-' + name, name, parent) }];

test('稳定 JSON、快照哈希和深冻结记录，不读取本机时间', () => {
    assert.equal(canonical({ z: 1, a: { y: 2, x: ['中', null] } }), canonical({ a: { x: ['中', null], y: 2 }, z: 1 }));
    assert.equal(snapshotHash(snapshot).length, 64);
    assert.equal(snapshotHash(snapshot), snapshotHash(JSON.parse(canonical(snapshot))));
    const record = make(10, [patch({ content: '修改' })]);
    assert.deepEqual(record.parents, []); assert.equal(record.lamport, 1);
    assert.ok(Object.isFrozen(record)); assert.ok(Object.isFrozen(record.operations[0].fields));
    assert.throws(() => { record.operations[0].fields.content = '偷偷修改'; }, TypeError);
    assert.throws(() => canonical({ value: undefined }));
});

test('同时间并发按演员及记录ID裁决，字段delta保留其他端改动和扩展数据', () => {
    const a = make(10, [patch({ content: 'A' })], [], id(100));
    const b = make(11, [patch({ label: 'B' })], [], id(101));
    const c = make(12, [patch({ content: 'C' })], [], id(101));
    const result = project(snapshot, [c, b, a]);
    assert.equal(result.data.todos[0].content, 'C'); assert.equal(result.data.todos[0].label, 'B');
    assert.deepEqual(result.data.todos[0].subtasks, snapshot.data.todos[0].subtasks);
    for (const key of ['time_entries', 'reminder_settings', 'task_series', 'custom_data']) assert.deepEqual(result.data[key], snapshot.data[key]);
    assert.equal(snapshot.data.todos[0].content, '原内容');
});

test('随机重排、重复及分批冷恢复产生完全一致结果', () => {
    const a = make(10, [patch({ content: 'A' })]);
    const b = make(11, [patch({ label: 'B' })], [], id(101));
    const c = make(12, [patch({ completed: true })], [a, b]);
    const d = make(13, [{ type: 'rating.set', id: 'rating-1', date: '2026-11-05', score: 5 }], [a]);
    const records = [a, b, c, d], expected = canonical(project(snapshot, records));
    const permutations = list => list.length ? list.flatMap((item, index) =>
        permutations(list.filter((_, i) => i !== index)).map(rest => [item, ...rest])) : [[]];
    const allOrders = permutations(records);
    assert.equal(allOrders.length, 24);
    for (const order of allOrders) {
        const collected = [];
        for (const record of order) { collected.push(record, structuredClone(record)); project(snapshot, collected); }
        assert.equal(canonical(project(snapshot, collected)), expected);
    }
    let seed = 83;
    const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
    for (let trial = 0; trial < 60; trial++) {
        const shuffled = [...records];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = random(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
        const collected = [];
        for (const record of shuffled) { collected.push(record, structuredClone(record)); project(snapshot, collected); }
        assert.equal(canonical(project(snapshot, collected)), expected);
    }
});

test('因果后继即使设备时钟倒退也胜出', () => {
    const a = make(10, [patch({ content: '未来时钟' })], [], id(100), '2099-01-01T00:00:00Z');
    const b = make(11, [patch({ content: '因果后继' })], [a], id(99), '2000-01-01T00:00:00Z');
    assert.equal(b.lamport, 2); assert.deepEqual(b.parents, [a.id]);
    assert.equal(project(snapshot, [b, a]).data.todos[0].content, '因果后继');
    assert.equal(project(snapshot, [b, a]).data.last_updated, b.created_at);
});

test('未知父依赖保留pending，补齐后应用；循环和非法lamport拒绝', () => {
    const a = make(10, [patch({ content: 'A' })]);
    const b = make(11, [patch({ content: 'B' })], [a]);
    const partial = project(snapshot, [b]);
    assert.deepEqual(partial.appliedIds, []); assert.deepEqual(partial.pendingIds, [b.id]);
    assert.equal(partial.data.todos[0].content, '原内容');
    assert.equal(project(snapshot, [b, a]).data.todos[0].content, 'B');
    assert.deepEqual(project(snapshot, [{ ...b, lamport: 1 }]).pendingIds, [b.id]);
    assert.throws(() => project(snapshot, [a, { ...b, lamport: 1 }]), /lamport/);
    assert.throws(() => project(snapshot, [{ ...a, parents: [b.id] }, b]), /循环/);
    assert.throws(() => project(snapshot, [{ ...a, parents: [a.id] }]), /循环/);
});

test('同ID不同完整正文、跨数据集和不同快照均拒绝', () => {
    const a = make(10, [patch({ content: 'A' })]);
    assert.throws(() => project(snapshot, [a, { ...a, operations: [patch({ content: 'B' })] }]), /同 ID/);
    assert.throws(() => project(snapshot, [{ ...a, dataset_id: id(2) }]), /不匹配/);
    assert.throws(() => project({ ...snapshot, data: { ...snapshot.data, another: true } }, [a]), /不匹配/);
    assert.equal(canonical(make(10, a.operations, [a])), canonical(a));
});

test('任务删除单调保留，离线旧修改和旧记录回流不恢复', () => {
    const deleted = make(10, [{ type: 'todo.delete', todo_id: 'todo-1' }]);
    const offline = make(11, [patch({ content: '离线修改' })], [], id(101));
    const projected = project(snapshot, [offline, deleted, structuredClone(deleted)]);
    assert.equal(projected.data.todos[0].deleted, true);
    assert.equal(projected.data.todos[0].content, '离线修改');
    const late = make(12, [{ type: 'todo.add', todo: structuredClone(snapshot.data.todos[0]) }], [deleted]);
    assert.equal(project(snapshot, [late, deleted]).data.todos[0].deleted, true);
});

test('评分清除独立于复盘，后续改分保留创建时间', () => {
    const a = make(10, [{ type: 'rating.set', id: 'rating-a', date: '2026-11-05', score: 5 }]);
    const b = make(11, [{ type: 'review.set', id: 'review-a', date: '2026-11-05', fact: '事实', obstacle: '', effective_action: '', next_step: '' }], [], id(101));
    const clear = make(12, [{ type: 'rating.set', id: 'rating-a', date: '2026-11-05', score: null }], [a], id(100), '2026-11-06T00:00:00Z');
    const result = project(snapshot, [clear, b, a]);
    assert.equal(result.data.daily_ratings[0].score, null); assert.equal(result.data.daily_reviews[0].fact, '事实');
    assert.equal(result.data.daily_ratings[0].created_at, time);
    assert.equal(result.data.daily_ratings[0].updated_at, clear.created_at);
});

test('新增任务保留完整载荷但时间固定为记录时间', () => {
    const added = make(10, [{ type: 'todo.add', todo: { ...snapshot.data.todos[0], id: 'todo-new', content: '新增任务' } }], [], id(100), '2026-11-06T00:00:00Z');
    const task = project(snapshot, [added]).data.todos.find(todo => todo.id === 'todo-new');
    assert.equal(task.created_at, added.created_at); assert.equal(task.updated_at, added.created_at);
    assert.deepEqual(task.custom, { kept: true });
});

test('计划版本及采用记录冷恢复，同版多末端不分歧，分支明确选择后不回流', () => {
    const initial = make(10, plan('v1'));
    const a = make(11, plan('v2', 'v1', ['selection-v1']), [initial], id(100));
    const b = make(12, plan('v3', 'v1', ['selection-v1']), [initial], id(101));
    const conflict = project(snapshot, [b, initial, a]);
    assert.equal(conflict.weekStates[week].status, 'conflict'); assert.equal(conflict.weekStates[week].currentVersionId, null);
    const parents = ['selection-v2', 'selection-v3'];
    const chooseA = make(13, [{ type: 'plan.selection.add', selection: selection('resolve-a', 'v2', parents, 'resolve') }], [initial, a, b]);
    const chooseB = make(14, [{ type: 'plan.selection.add', selection: selection('resolve-b', 'v2', parents, 'resolve') }], [initial, a, b], id(101));
    const final = project(JSON.parse(JSON.stringify(snapshot)), JSON.parse(JSON.stringify([chooseB, chooseA, b, a, initial, b])));
    assert.equal(final.weekStates[week].status, 'current'); assert.equal(final.weekStates[week].currentVersionId, 'v2');
    assert.equal(final.weekStates[week].candidateSelectionIds.length, 2);
    assert.equal(final.data.weekly_plan_versions.length, 3);
    assert.equal(final.conflicts.length, 0);
});

test('计划删除保持单调，已删除候选待核对，不自动采用历史版', () => {
    const initial = make(10, plan('v1'));
    const next = make(11, plan('v2', 'v1', ['selection-v1']), [initial]);
    const deleted = make(12, [{ type: 'plan.version.delete', version_id: 'v2' }], [initial, next]);
    const result = project(snapshot, [deleted, next, initial, next]);
    assert.equal(result.weekStates[week].status, 'needs-review');
    assert.equal(result.weekStates[week].currentVersionId, null);
    assert.deepEqual(result.weekStates[week].deletedCandidateVersionIds, ['v2']);
    assert.equal(result.data.weekly_plan_versions.find(version => version.id === 'v2').deleted, true);
});

test('并发选择与历史删除交错时保留有效候选和被删候选，明确选择后可继续', () => {
    const initial = make(10, plan('v1'));
    const a = make(11, plan('v2', 'v1', ['selection-v1']), [initial], id(100));
    const b = make(12, plan('v3', 'v1', ['selection-v1']), [initial], id(101));
    const known = [initial, a, b], parents = ['selection-v2', 'selection-v3'];
    const chooseA = make(13, [{ type: 'plan.selection.add', selection: selection('resolve-a', 'v2', parents, 'resolve') },
        { type: 'plan.version.delete', version_id: 'v3' }, { type: 'todo.delete', todo_id: 'todo-1' }], known);
    const chooseB = make(14, [{ type: 'plan.selection.add', selection: selection('resolve-b', 'v3', parents, 'resolve') },
        patch({ content: '离线旧修改' })], known, id(101));
    const combined = [...known, chooseA, chooseB], state = project(snapshot, combined);
    assert.equal(state.weekStates[week].status, 'needs-review');
    assert.deepEqual(state.weekStates[week].candidateVersionIds, ['v2', 'v3']);
    assert.deepEqual(state.weekStates[week].deletedCandidateVersionIds, ['v3']);
    assert.equal(state.data.todos[0].deleted, true);
    const resolved = make(15, [{ type: 'plan.selection.add', selection: selection('resolve-final', 'v2', ['resolve-a', 'resolve-b'], 'resolve') }], combined);
    const final = project(snapshot, [resolved, ...combined]);
    assert.equal(final.weekStates[week].status, 'current'); assert.equal(final.weekStates[week].currentVersionId, 'v2');
    assert.equal(final.data.todos[0].deleted, true);
});

test('拒绝未知操作、越权字段和无时区时间；计划保存原子成对', () => {
    for (const operation of [{ type: 'unknown' }, patch({ deleted: false }), { type: 'rating.set', id: 'r', date: '2026-11-05', score: 6 },
        { type: 'plan.version.add', version: version('v1') }]) assert.throws(() => make(10, [operation]));
    assert.throws(() => make(10, [patch({ content: '无时区' })], [], id(100), '2026-11-05T08:00:00'));
});
