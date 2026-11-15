import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createDataset, createRecord, validateJoin } from '../envelope.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { normalTodoOperation } from '../normal-record-profile.mjs';
import { periodTodoOperation } from '../period-record-profile.mjs';
import { checkinOperation } from '../checkin-record-profile.mjs';
import { PERSONAL_SERIES_WORKFLOW_V2_PROFILE } from '../series-workflow-profile.mjs';
import { collaborationTodoCreate, openCollaborationRecordLab, COLLABORATION_RECORD_PROFILE as profile } from '../collaboration-record-profile.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-11-07T02:00:00Z';
const later = '2026-11-07T03:00:00Z';
const todo = (fields = {}) => ({ id: id(20), content: '新增 (由 [协作者] 添加)', date: null, task_type: 'normal',
    target_count: null, subtasks: [{ id: id(21), content: '子任务' }], created_at: at, order: -1, ...fields });
const base = (fields = {}) => ({ version: 1, last_updated: at, todos: [], reminder_settings: { updated_at: at, enabled: false },
    time_entries: [], daily_reviews: [], task_series: [], task_series_links: [], future: { keep: ['原值'] }, ...fields });
const dataset = (data = base()) => createDataset({ datasetId: id(1), createdAt: at, data, profile });
const intent = (n, operations, actor = 2) => ({ id: id(n), actorId: id(actor), createdAt: at, operations });
const record = (data, n, operations, parents = []) => createRecord({ pin: data.pin, ...intent(n, operations), profile, parents });
const owner = (data, transport = memoryTransport(), store = new MemoryStore()) => openRecordLab({ dataset: data, transport, store, profile });
const same = (a, b) => assert.deepEqual(encode(a), encode(b));

function collaborator(data, transport, access = 'append', store = new MemoryStore()) {
    const binding = { sourceId: '共享清单', targetKey: '隔离目标', generation: 1, pin: data.pin };
    const open = () => openCollaborationRecordLab({ dataset: data, transport, store, binding, access,
        getCurrentBinding: () => binding, getCurrentAccess: () => access });
    return { binding, open, store };
}

test('协作者可新增三种任务与初始子任务，原数据集其它集合保持，空缓存与恢复包可重放', async () => {
    const data = dataset(), transport = memoryTransport(), c = collaborator(data, transport), client = await c.open();
    const rows = [
        todo({ date: '2026-11-07' }),
        todo({ id: id(22), date: '2026-W45', task_type: 'weekly_checkin', target_count: 2, subtasks: [] }),
        todo({ id: id(23), date: '2026-11', task_type: 'monthly_checkin', subtasks: [{ id: id(24), content: '月子任务' }] })
    ];
    for (const [index, row] of rows.entries()) await client.append(c.binding, intent(10 + index, [collaborationTodoCreate(row)]));
    await client.sync();
    const receiver = await owner(data, transport);
    await receiver.sync();
    const result = receiver.state().view;
    same(result, client.view());
    assert.deepEqual(result.todos.map(item => item.task_type), rows.map(item => item.task_type));
    assert.deepEqual(result.todos.map(item => item.target_count), [null, 2, null]);
    for (const item of result.todos) {
        assert.equal(item.reminder, null);
        assert.equal(item.label, null);
        assert.equal(item.deleted, false);
        assert.equal(item.completed, false);
        assert.deepEqual(item.completed_dates, []);
        assert.ok(item.subtasks.every(child => child.completed === false && child.completed_at === null));
    }
    same(result.future, data.baseline.value.data.future);
    same(result.reminder_settings, (await owner(data)).state().view.reminder_settings);
    const bundle = createRecovery({ dataset: data, state: receiver.state(), profile });
    same(restoreRecovery({ dataset: data, bundle, profile }).view, result);
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, PERSONAL_SERIES_WORKFLOW_V2_PROFILE), /INVALID_DATASET_BINDING/);
});

test('字段白名单拒绝提醒、已有状态、未知字段和异常日期目标', () => {
    for (const fields of [
        { reminder: { reminder_time: '09:00' } }, { reminder: null }, { completed: true }, { deleted: true },
        { completed_dates: ['2026-11-07'] }, { task_series: [] }, { time_entries: [] }, { content: '   ' },
        { date: '2026-02-30' }, { target_count: 1 }, { id: '历史身份' },
        { task_type: 'weekly_checkin', date: '2025-W53' }, { task_type: 'monthly_checkin', date: '2026-13' },
        { task_type: 'weekly_checkin', date: '2026-W45', target_count: 0 },
        { task_type: 'weekly_checkin', date: '2026-W45', target_count: 2147483648 },
        { subtasks: [{ id: id(21), content: '子任务', completed: true }] },
        { subtasks: [{ id: id(20), content: '和父任务同 ID' }] },
        { subtasks: [{ id: id(21), content: '一' }, { id: id(21), content: '二' }] }
    ]) assert.throws(() => collaborationTodoCreate(todo(fields)), /INVALID_/);
});

test('只读可以看到协作新增，新增角色无法调用已有任务、计时或混合批次写入', async () => {
    const data = dataset(), transport = memoryTransport();
    const c = collaborator(data, transport), writer = await c.open(), before = await c.store.load();
    const add = collaborationTodoCreate(todo());
    for (const operations of [[add, add], [normalTodoOperation('put', { ...todo(), updated_at: later })], [{ type: 'time.entry.put' }]]) {
        await assert.rejects(writer.append(c.binding, intent(10, operations)), /COLLABORATION_REQUIRES_ONE_CREATE/);
    }
    same(await c.store.load(), before);
    await writer.append(c.binding, intent(10, [add])); await writer.sync();
    const read = collaborator(data, transport, 'view'), reader = await read.open();
    await reader.sync(); assert.equal(reader.view().todos[0].content, add.todo.content);
    await assert.rejects(reader.append(read.binding, intent(11, [add])), /COLLABORATION_VIEW_ONLY/);
});

test('响应丢失后重试保留同一记录，换一个记录 ID 不能再新增已有任务', async () => {
    const data = dataset(), transport = memoryTransport();
    const write = transport.write;
    let lose = true;
    transport.write = async (name, bytes) => {
        await write(name, bytes);
        if (lose) { lose = false; throw new Error('模拟丢失响应'); }
    };
    const c = collaborator(data, transport), a = await c.open(), operation = collaborationTodoCreate(todo());
    const submitted = intent(10, [operation]);
    const row = await a.append(c.binding, submitted);
    assert.deepEqual((await a.sync()).outbox, [row.name]);
    const reopened = await c.open();
    same(await reopened.append(c.binding, submitted), row);
    assert.deepEqual((await reopened.sync()).outbox, []);
    assert.equal(transport.files.size, 1);
    assert.equal(reopened.view().todos.length, 1);
    await assert.rejects(reopened.append(c.binding, intent(11, [operation])), /COLLABORATION_TODO_ALREADY_EXISTS/);
    await assert.rejects(reopened.append(c.binding, intent(10, [collaborationTodoCreate(todo({ content: '其他' }))])), /RECORD_ID_CONTENT_CONFLICT/);
});

test('两端离线新增不同任务，乱序与目录漏项补齐后双方都保留全部新增', async () => {
    const data = dataset(), transport = memoryTransport();
    const ca = collaborator(data, transport), cb = collaborator(data, transport);
    const a = await ca.open(), b = await cb.open();
    await a.append(ca.binding, intent(10, [collaborationTodoCreate(todo())]));
    await b.append(cb.binding, intent(11, [collaborationTodoCreate(todo({ id: id(22), content: '另一端新增', subtasks: [] }))], 3));
    await a.sync(); await b.sync();
    const transportWithOmissions = {
        ...transport,
        async list() { return [...transport.files.keys()].reverse().slice(0, 1); }
    };
    const cold = await owner(data, transportWithOmissions);
    await cold.sync();
    assert.equal(cold.state().view.todos.length, 1);
    transportWithOmissions.list = async () => [...transport.files.keys()].reverse().flatMap(name => [name, name]);
    await cold.sync(); await a.sync(); await b.sync();
    const expected = cold.state().view;
    assert.deepEqual(expected.todos.map(item => item.id), [id(20), id(22)]);
    same(a.view(), expected);
    same(b.view(), expected);
});

test('基线身份和两端并发的同身份新增都不会被当成编辑', async () => {
    const original = normalTodoOperation('put', { ...todo({ content: '已有正文' }), updated_at: at }).todo;
    const existing = dataset(base({ todos: [original] })), c = collaborator(existing, memoryTransport()), client = await c.open();
    await assert.rejects(client.append(c.binding, intent(10, [collaborationTodoCreate(todo())])), /COLLABORATION_TODO_ALREADY_EXISTS/);
    assert.equal(client.view().todos[0].content, original.content);
    const data = dataset(), a = record(data, 10, [collaborationTodoCreate(todo())]);
    const b = record(data, 11, [collaborationTodoCreate(todo({ content: '另一份正文' }))]);
    for (const rows of [[a, b], [b, a]]) {
        const target = await owner(data, memoryTransport(rows)); await target.sync();
        assert.equal(target.state().blocked, true);
        assert.ok(target.state().faults.some(row => row.code === 'COLLABORATION_TODO_ALREADY_EXISTS'));
        assert.equal(target.state().artifacts.length, 2);
    }
});

test('所有者能编辑已知的协作普通和周期任务，未知的同身份覆盖会冻结', async () => {
    const data = dataset();
    const regular = record(data, 10, [collaborationTodoCreate(todo())]);
    const periodic = record(data, 11, [collaborationTodoCreate(todo({ id: id(23), date: '2026-W45', task_type: 'weekly_checkin', subtasks: [] }))]);
    const edited = normalTodoOperation('put', { ...todo({ content: '所有者编辑' }), updated_at: later, reminder: { reminder_time: '09:00' } });
    const checked = checkinOperation('mark', { todo_id: id(23), day: '2026-11-07', updated_at: later, value: '2026-11-07' });
    const periodEdit = periodTodoOperation('put', { ...periodic.value.operations[0].todo, target_count: 1, updated_at: later });
    const changed = record(data, 12, [edited, periodEdit, checked], [regular, periodic]);
    const receiver = await owner(data, memoryTransport([changed, periodic, regular])); await receiver.sync();
    assert.equal(receiver.state().blocked, false);
    assert.equal(receiver.state().view.todos[0].reminder.reminder_time, '09:00');
    assert.equal(receiver.state().view.todos[1].completed, true);
    const unrelated = record(data, 13, [edited]);
    const collision = await owner(data, memoryTransport([regular, unrelated])); await collision.sync();
    assert.equal(collision.state().blocked, true);
    assert.ok(collision.state().faults.some(row => row.code === 'COLLABORATION_TODO_ID_CONFLICT'));
});
