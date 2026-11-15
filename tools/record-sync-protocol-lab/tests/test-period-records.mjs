import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createDataset, createRecord, validateJoin } from '../envelope.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { checkinOperation, PERSONAL_CHECKIN_PROFILE } from '../checkin-record-profile.mjs';
import { periodTodoOperation, PERSONAL_PERIOD_PROFILE as profile } from '../period-record-profile.mjs';
import { normalTodoOperation } from '../normal-record-profile.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = '2026-11-05';
const at = '2026-11-07T02:00:00.000Z';
const later = '2026-11-07T02:00:00.001Z';
const latest = '2026-11-07T02:00:00.002Z';
const task = (fields = {}) => ({ id: id(50), content: '阅读', date: '2026-W45', task_type: 'weekly_checkin',
    created_at: at, updated_at: at, target_count: 1, ...fields });
const mark = (todo_id = id(50), updated_at = at, value = day) => checkinOperation('mark', { todo_id, day, updated_at, value });
const clear = (todo_id = id(50), updated_at = later) => checkinOperation('clear', { todo_id, day, updated_at });
const dataset = (todos = []) => createDataset({ datasetId: id(1), createdAt: at,
    data: { version: 1, last_updated: at, todos, task_series: [{ opaque: '系列' }], task_series_links: [{ opaque: '关联' }] }, profile });
const intent = (n, operations, actor = 2) => ({ id: id(n), actorId: id(actor), createdAt: at, operations });
const record = (data, n, operations, parents = []) => createRecord({ pin: data.pin, ...intent(n, operations), profile, parents });
const open = (data, store = new MemoryStore(), transport = memoryTransport()) => openRecordLab({ dataset: data, store, transport, profile });
const same = (a, b) => assert.deepEqual(encode(a), encode(b));

test('新建周／月任务可与打卡一起原子提交，基础字段不带派生列表', async () => {
    const data = dataset(), client = await open(data);
    const month = task({ id: id(51), task_type: 'monthly_checkin', date: '2026-11' });
    await client.commit(intent(10, [mark(), periodTodoOperation('create', task()), periodTodoOperation('create', month), mark(id(51))]));
    assert.deepEqual(client.state().view.todos.map(todo => [todo.completed, todo.completed_at, todo.completed_dates]),
        [[true, null, [day]], [true, null, [day]]]);
    assert.equal(client.state().artifacts.length, 1);
    assert.equal(data.descriptor.value.operation_set, 'lab-personal-period/1');
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, PERSONAL_CHECKIN_PROFILE), /INVALID_DATASET_BINDING/);
});

test('独立编辑保持已有打卡，改目标时从原日期重算，不重写基础时钟和关联', async () => {
    const original = task({ id: '旧周期', completed_dates: [day], completed: true, completed_at: at, extension: { kept: true },
        subtasks: [{ id: '旧子任务', content: '原文字' }] });
    const data = dataset([original]), client = await open(data);
    const update = fields => periodTodoOperation('put', task({ id: original.id, updated_at: later,
        extension: original.extension, subtasks: original.subtasks, ...fields }));
    await client.commit(intent(10, [update({ content: '新名称' })]));
    let todo = client.state().view.todos[0];
    assert.equal(todo.content, '新名称'); assert.equal(todo.completed_at, at); assert.equal(todo.updated_at, later);
    same(todo.extension, original.extension);
    await client.commit(intent(11, [update({ updated_at: latest, target_count: 2 })]));
    todo = client.state().view.todos[0];
    assert.equal(todo.completed, false); assert.equal(todo.completed_at, null);
    assert.deepEqual(todo.completed_dates, [day]);
    same(client.state().view.task_series_links, data.baseline.value.data.task_series_links);
});

test('同毫秒基础候选固定整条选择，旧补卡和晚到销卡独立于基础胜负', async () => {
    const data = dataset([task({ completed_dates: [day] })]);
    const a = record(data, 10, [periodTodoOperation('put', task({ updated_at: later, content: '甲', label: '仅甲' }))]);
    const b = record(data, 11, [periodTodoOperation('put', task({ updated_at: '2026-11-07T10:00:00.001999+08:00', content: '乙', label: '仅乙' }))]);
    const c = record(data, 12, [clear()]);
    const views = [];
    for (const items of [[a, b, c], [c, b, a], [b, a, c]]) {
        const client = await open(data, new MemoryStore(), memoryTransport(items)); await client.sync();
        const view = client.state().view;
        assert.deepEqual(view.todos[0].completed_dates, []);
        assert.equal(view.todos[0].completed, false);
        assert.ok([['甲', '仅甲'], ['乙', '仅乙']].some(([content, label]) => view.todos[0].content === content && view.todos[0].label === label));
        views.push(view);
    }
    for (const view of views) same(view, views[0]);
});

test('删除由基础版本选择，已知打卡不会复活任务，原始动作仍可从空缓存恢复', async () => {
    const data = dataset(), transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    await a.commit(intent(10, [periodTodoOperation('create', task())])); await a.sync(); await b.sync();
    await a.commit(intent(11, [periodTodoOperation('delete', task({ updated_at: later, deleted: true }))]));
    await b.commit(intent(12, [mark(id(50), latest)], 3));
    await a.sync(); await b.sync(); await a.sync();
    const result = a.state();
    same(result.view, b.state().view);
    assert.equal(result.view.todos[0].deleted, true);
    assert.deepEqual(result.view.todos[0].completed_dates, [day]);
    assert.equal(result.artifacts.length, 3);
    const cold = await open(data, new MemoryStore(), transport); await cold.sync();
    same(cold.state().view, result.view);
    const bundle = createRecovery({ dataset: data, state: result, profile });
    same(restoreRecovery({ dataset: data, bundle, profile }).view, result.view);
});

test('先发现打卡子记录时暂等精确父文件，父文件补齐后无需重写可恢复', async () => {
    const data = dataset(), created = record(data, 10, [periodTodoOperation('create', task())]);
    const middle = record(data, 11, [periodTodoOperation('put', task({ updated_at: later, content: '改名' }))], [created]);
    const checked = record(data, 12, [mark(id(50), latest)], [middle]);
    const transport = memoryTransport([checked]), client = await open(data, new MemoryStore(), transport);
    await client.sync();
    assert.equal(client.state().reason, 'MISSING_DEPENDENCIES');
    transport.files.set(middle.name, middle.bytes);
    await client.sync(); assert.equal(client.state().reason, 'MISSING_DEPENDENCIES');
    transport.files.set(created.name, created.bytes);
    await client.sync(); assert.equal(client.state().blocked, false);
    assert.equal(client.state().view.todos[0].content, '改名');
    assert.deepEqual(client.state().view.todos[0].completed_dates, [day]);
});

test('同一 UUID 的创建和引用必须处于同一批或因果历史中', async () => {
    const data = dataset(), created = record(data, 10, [periodTodoOperation('create', task())]);
    const other = record(data, 11, [periodTodoOperation('create', task({ id: id(55) }))]);
    const unrelated = record(data, 12, [mark()], [other]);
    const client = await open(data, new MemoryStore(), memoryTransport([created, other, unrelated]));
    await client.sync();
    assert.equal(client.state().blocked, true);
    assert.ok(client.state().faults.some(fault => fault.code === 'PERIOD_CREATION_NOT_IN_CAUSAL_HISTORY'));
    assert.ok(client.state().artifacts.some(row => row.base64 === unrelated.bytes.toString('base64')));
});

test('禁止旧快照混入日期，拒绝无创建、跨类型或跨周期移动及旧 ID 冒充', async () => {
    assert.throws(() => periodTodoOperation('put', task({ completed_dates: [day] })), /PERIOD_BASE_INCLUDES_CHECKIN_PROJECTION/);
    assert.throws(() => periodTodoOperation('put', task({ completed: true })), /PERIOD_BASE_INCLUDES_CHECKIN_PROJECTION/);
    assert.throws(() => periodTodoOperation('create', task({ date: '2025-W53' })), /INVALID_PERIOD_BASE/);
    assert.throws(() => periodTodoOperation('create', task({ target_count: 2147483648 })), /INVALID_PERIOD_TARGET_COUNT/);
    const data = dataset([task()]), store = new MemoryStore(), client = await open(data, store);
    const original = await store.load();
    const normal = normalTodoOperation('put', { id: id(51), content: '普通', created_at: at, updated_at: at });
    for (const [operations, error] of [
        [[periodTodoOperation('put', task({ date: '2026-W46' }))], /PERIOD_MOVE_UNSUPPORTED/],
        [[periodTodoOperation('put', task({ date: '2026-11', task_type: 'monthly_checkin' }))], /PERIOD_MOVE_UNSUPPORTED/],
        [[periodTodoOperation('create', task({ id: '旧身份' }))], /INVALID_NEW_PERIOD_TODO_ID/],
        [[periodTodoOperation('create', task())], /PERIOD_CREATION_ID_CONFLICT/],
        [[periodTodoOperation('put', task({ id: id(51) }))], /PERIOD_TARGET_WITHOUT_CREATION/],
        [[periodTodoOperation('create', task({ id: id(51), subtasks: [{ id: '旧子任务', content: '原文字' }] }))], /INVALID_NEW_PERIOD_SUBTASK_ID/],
        [[periodTodoOperation('create', task({ id: id(51) })), normal], /PERIOD_NORMAL_ID_CONFLICT/]
    ]) {
        await assert.rejects(client.commit(intent(10, operations)), error);
        same(await store.load(), original);
    }
});
