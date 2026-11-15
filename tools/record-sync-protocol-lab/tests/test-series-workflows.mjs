import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createDataset, createRecord, validateJoin } from '../envelope.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { timeEntryOperation } from '../learning-record-profile.mjs';
import { importSeriesWorkflow, deleteSeriesWorkflow, manualTimerStop,
    PERSONAL_SERIES_WORKFLOW_PROFILE as profile, PERSONAL_SERIES_WORKFLOW_V2_PROFILE as v2 } from '../series-workflow-profile.mjs';
import { deletePreview, timingPendingReason, visibleSeriesTodos } from '../../../windows/src/taskSeries.js';
import { mergeTodoData } from '../../../windows/src/dataMerge.js';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const initialTime = '2026-11-07T12:00:00Z';
const importTime = '2026-11-08T16:00:00Z';
const deleteTime = '2026-11-09T12:00:00Z';
const source = { id: id(11), content: '原任务', date: '2026-W45', task_type: 'weekly_checkin',
    created_at: initialTime, updated_at: initialTime, completed_dates: ['2026-11-07'], target_count: 2,
    subtasks: [{ id: id(14), content: '旧子任务', completed: true, completed_at: initialTime }] };
const existing = { id: id(12), content: '系列当前名称', period_type: 'week', created_at: initialTime,
    updated_at: initialTime, content_updated_at: initialTime, content_renamed: true };
const link = { todo_id: source.id, series_id: existing.id, period: source.date, created_at: initialTime, updated_at: initialTime };
const timer = (n, task = source.id, other = {}) => ({ id: id(n), task_ref: { todo_id: task }, created_at: initialTime,
    updated_at: initialTime, started_at: initialTime, ended_at: null, ...other });
const base = (fields = {}) => ({ version: 1, last_updated: initialTime, todos: [source], ...fields });
const dataset = (data = base(), operationProfile = profile) =>
    createDataset({ datasetId: id(1), createdAt: initialTime, data, profile: operationProfile });
const open = (data, store = new MemoryStore(), transport = memoryTransport(), operationProfile = profile) =>
    openRecordLab({ dataset: data, store, transport, profile: operationProfile });
const intent = (n, operations, actor = 2) => ({ id: id(n), actorId: id(actor), createdAt: importTime, operations });
const importOp = (newId = 21, child = 22, overrides = {}) => importSeriesWorkflow({ sourceIds: [source.id], target: '2026-W46',
    updatedAt: importTime, offsetMinutes: 480, generatedIds: [id(newId), id(child)], ...overrides });
const same = (a, b) => assert.deepEqual(encode(a), encode(b));

test('首次跨周导入原子创建系列、任务、两条关联，使用固定日历和身份', async () => {
    const data = dataset(), client = await open(data);
    const operation = importOp();
    const RealDate = globalThis.Date;
    const actualRandomUUID = crypto.randomUUID;
    try {
        globalThis.Date = class extends RealDate {
            constructor(...args) {
                if (!args.length) throw new Error('CURRENT_TIME_READ');
                super(...args);
            }
            static now() { throw new Error('CURRENT_TIME_READ'); }
        };
        crypto.randomUUID = () => { throw new Error('RANDOM_ID_GENERATED'); };
        await client.commit(intent(30, [operation]));
    } finally {
        globalThis.Date = RealDate;
        crypto.randomUUID = actualRandomUUID;
    }
    const view = client.state().view;
    assert.equal(view.task_series[0].id, source.id);
    assert.deepEqual(view.task_series_links.map(row => row.todo_id), [source.id, id(21)]);
    same(view.todos.find(todo => todo.id === source.id), source);
    const imported = view.todos.find(todo => todo.id === id(21));
    assert.deepEqual(imported.completed_dates, []);
    assert.deepEqual(imported.subtasks, [{ id: id(22), content: '旧子任务', completed: false, completed_at: null }]);
    assert.equal(imported.date, '2026-W46');
    assert.equal(imported.created_at, importTime);
    const before = client.state().artifacts;
    await client.commit(intent(30, [operation]));
    same(client.state().artifacts, before);
});

test('并发首次导入保留各自的新任务，系列合一，重复与乱序后空缓存恢复一致', async () => {
    const data = dataset(), transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    await a.commit(intent(30, [importOp()]));
    await b.commit(intent(31, [importOp(23, 24)], 3));
    await a.sync(); await b.sync(); await a.sync();
    const expected = a.state().view;
    same(expected, b.state().view);
    assert.equal(expected.task_series.length, 1);
    assert.deepEqual(expected.todos.map(todo => todo.id), [source.id, id(21), id(23)]);
    assert.equal(expected.task_series_links.length, 3);
    const cold = await open(data, new MemoryStore(), transport);
    transport.list = async () => [...transport.files.keys()].reverse().flatMap(name => [name, name]);
    await cold.sync();
    same(cold.state().view, expected);
    const bundle = createRecovery({ dataset: data, state: cold.state(), profile });
    same(restoreRecovery({ dataset: data, bundle, profile }).view, expected);
    await assert.rejects(a.commit(intent(32, [importOp(25, 26)])), /本期已存在/);
});

test('整体删除可跟在导入之后，只结束确认过且仍运行的个人计时', async () => {
    const originalTimers = [timer(50), timer(51, source.id, { ended_at: importTime }), timer(52, source.id, {
        task_ref: { todo_id: source.id, source_type: 'collaboration', source_id: '协作' }
    })];
    const data = dataset(base({ time_entries: originalTimers })), transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport);
    await a.commit(intent(30, [importOp()]));
    const preview = deletePreview(a.state().view, source.id, true);
    assert.deepEqual(preview.running.map(entry => entry.id), [id(50)]);
    await a.commit(intent(31, [timeEntryOperation('put', timer(53, id(21)))]));
    await a.commit(intent(32, [deleteSeriesWorkflow(preview, deleteTime)]));
    const result = a.state().view;
    assert.ok(result.todos.every(todo => todo.deleted));
    assert.equal(result.task_series[0].deleted, true);
    assert.deepEqual(result.time_entries.map(entry => entry.ended_at), [deleteTime, importTime, null, null]);
    assert.equal(timingPendingReason(result, result.time_entries[3]), '任务已删除，结束时间待核对');
    await a.sync();
    const cold = await open(data, new MemoryStore(), transport);
    transport.list = async () => [...transport.files.keys()].reverse();
    await cold.sync();
    same(cold.state().view, result);
});

test('多选导入作为同一批生效，生成身份不足时整批拒绝', async () => {
    const second = { ...source, id: id(15), content: '另一期任务', subtasks: [] };
    const data = dataset(base({ todos: [source, second] })), store = new MemoryStore(), client = await open(data, store);
    const original = await store.load();
    const sourceIds = [source.id, second.id];
    await assert.rejects(client.commit(intent(30, [importOp(21, 22, { sourceIds })])), /SERIES_IMPORT_GENERATED_ID_CONFLICT/);
    same(await store.load(), original);
    const generatedIds = [id(21), id(22), id(23)];
    await client.commit(intent(30, [importOp(21, 22, { sourceIds, generatedIds })]));
    const view = client.state().view;
    assert.equal(view.todos.length, 4);
    assert.equal(view.task_series.length, 2);
    assert.equal(view.task_series_links.length, 4);
    assert.equal(client.state().artifacts.length, 1);
});

test('两条并发导入重用同一个新身份时冻结并保留原始记录', async () => {
    const data = dataset();
    const a = createRecord({ pin: data.pin, ...intent(30, [importOp()]), profile });
    const b = createRecord({ pin: data.pin, ...intent(31, [importOp(23, 22)], 3), profile });
    const client = await open(data, new MemoryStore(), memoryTransport([b, a]));
    await client.sync();
    assert.equal(client.state().blocked, true);
    assert.ok(client.state().faults.some(fault => fault.code === 'CONCURRENT_SERIES_IMPORT_ID_CONFLICT'));
    assert.equal(client.state().artifacts.length, 2);
});

test('整体删除与离线导入并发时只删已确认成员，迟到任务和计时保留待核对', async () => {
    const data = dataset(base({ task_series: [existing], task_series_links: [link], time_entries: [timer(50)] }));
    const transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    await a.commit(intent(30, [deleteSeriesWorkflow(deletePreview(a.state().view, source.id, true), deleteTime)]));
    await b.commit(intent(31, [importOp()], 3));
    await b.commit(intent(32, [timeEntryOperation('put', timer(51, id(21)))], 3));
    await a.sync(); await b.sync(); await a.sync();
    const result = a.state().view;
    same(result, b.state().view);
    assert.equal(result.task_series[0].deleted, true);
    assert.deepEqual(result.todos.map(todo => todo.deleted ?? false), [true, false]);
    assert.deepEqual(visibleSeriesTodos(result), []);
    assert.equal(result.time_entries[0].ended_at, deleteTime);
    assert.equal(result.time_entries[1].ended_at, null);
    assert.equal(timingPendingReason(result, result.time_entries[1]), '任务已删除，结束时间待核对');
    assert.equal(a.state().artifacts.length, 3);
});

test('并发手动结束与整体删除的自动结束暂沿用计时整条时间优先', async () => {
    const data = dataset(base({ task_series: [existing], task_series_links: [link], time_entries: [timer(50)] }));
    const transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    const manualStop = '2026-11-09T10:00:00Z';
    await a.commit(intent(30, [deleteSeriesWorkflow(deletePreview(a.state().view, source.id, true), deleteTime)]));
    await b.commit(intent(31, [timeEntryOperation('put', timer(50, source.id, { ended_at: manualStop, updated_at: manualStop }))], 3));
    const actual = mergeTodoData(a.state().view, b.state().view).data;
    assert.equal(actual.time_entries[0].ended_at, deleteTime);
    await a.sync(); await b.sync(); await a.sync();
    assert.equal(a.state().view.time_entries[0].ended_at, deleteTime);
    same(a.state().view, b.state().view);
});

test('引用错误、身份不匹配及错误确认拒绝整条记录，远端保留原始证据', async () => {
    const data = dataset(base({ task_series: [existing], task_series_links: [link],
        time_entries: [timer(50), timer(51, id(99))] }));
    const store = new MemoryStore(), client = await open(data, store);
    const before = await store.load();
    const remove = deleteSeriesWorkflow(deletePreview(client.state().view, source.id, true), deleteTime);
    const invalid = { ...remove, confirmed_timer_ids: [id(51)] };
    for (const [operations, error] of [
        [[importOp(21, 22, { offsetMinutes: 0 })], /参考任务或周期已变化/],
        [[importOp(21, 22, { generatedIds: [source.id, id(22)] })], /SERIES_IMPORT_GENERATED_ID_CONFLICT/],
        [[importOp(21, 22, { generatedIds: [id(21), id(22), id(23)] })], /SERIES_IMPORT_UNUSED_IDS/],
        [[{ ...remove, member_ids: [id(99)] }], /SERIES_DELETE_PREVIEW_CHANGED/],
        [[invalid], /SERIES_DELETE_TIMER_OUTSIDE_PREVIEW/],
        [[importOp(), remove], /SERIES_WORKFLOW_REQUIRES_OWN_RECORD/]
    ]) {
        await assert.rejects(client.commit(intent(30, operations)), error);
        same(await store.load(), before);
    }
    const bad = createRecord({ pin: data.pin, ...intent(30, [invalid]), profile });
    const remote = await open(data, new MemoryStore(), memoryTransport([bad])); await remote.sync();
    assert.equal(remote.state().blocked, true);
    same(remote.state().view, before.view);
    assert.equal(remote.state().artifacts[0].base64, bad.bytes.toString('base64'));
});

const manualEnd = '2026-11-09T10:00:00Z';
const activeSeries = (...time_entries) => base({ task_series: [existing], task_series_links: [link], time_entries });
const stopDataset = (...timers) => dataset(activeSeries(...timers), v2);
const openV2 = (data, transport = memoryTransport()) => open(data, new MemoryStore(), transport, v2);
const deleteOp = (client, at = deleteTime) => deleteSeriesWorkflow(deletePreview(client.state().view, source.id, true), at);

test('手动结束压过同一计时的并发自动结束，其余自动结束与系列删除照常生效', async () => {
    const data = stopDataset(timer(50), timer(51));
    const transport = memoryTransport();
    const a = await openV2(data, transport), b = await openV2(data, transport);
    await a.commit(intent(30, [deleteOp(a)]));
    await b.commit(intent(31, [manualTimerStop(id(50), manualEnd)], 3));
    assert.deepEqual(a.state().view.time_entries.map(entry => entry.ended_at), [deleteTime, deleteTime]);
    await a.sync(); await b.sync(); await a.sync();
    const result = a.state().view;
    same(result, b.state().view);
    assert.equal(result.task_series[0].deleted, true);
    assert.equal(result.todos[0].deleted, true);
    assert.deepEqual(result.time_entries.map(entry => entry.ended_at), [manualEnd, deleteTime]);
    assert.equal(a.state().artifacts.length, 2);
    transport.list = async () => [...transport.files.keys()].reverse().flatMap(name => [name, name]);
    const cold = await openV2(data, transport); await cold.sync();
    same(cold.state().view, result);
    const bundle = createRecovery({ dataset: data, state: a.state(), profile: v2 });
    same(restoreRecovery({ dataset: data, bundle, profile: v2 }).view, result);
    assert.equal(data.descriptor.value.operation_set, 'lab-personal-series-workflows/2');
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, profile), /INVALID_DATASET_BINDING/);
    assert.throws(() => profile.validateOperation(manualTimerStop(id(50), manualEnd)), /UNSUPPORTED_OPERATION/);
});

test('自动结束单独到达可先投影，手动结束补齐后改为手动时间', async () => {
    const data = stopDataset(timer(50));
    const preview = deleteOp(await openV2(data));
    const make = (number, operation) => createRecord({ pin: data.pin, ...intent(number, [operation]), profile: v2 });
    const auto = make(31, preview), manual = make(30, manualTimerStop(id(50), manualEnd));
    for (const first of [auto, manual]) {
        const second = first === auto ? manual : auto;
        const transport = memoryTransport([first]), client = await openV2(data, transport);
        await client.sync();
        assert.equal(client.state().view.time_entries[0].ended_at, first === auto ? deleteTime : manualEnd);
        transport.files.set(second.name, second.bytes);
        await client.sync();
        assert.equal(client.state().view.time_entries[0].ended_at, manualEnd);
        assert.equal(client.state().view.task_series[0].deleted, true);
        assert.equal(client.state().artifacts.length, 2);
    }
});

test('删除已看到手动结束时跳过该计时，已结束的计时不能再提交手动停止', async () => {
    const data = stopDataset(timer(50)), client = await openV2(data);
    const preview = deleteOp(client);
    await client.commit(intent(30, [manualTimerStop(id(50), manualEnd)]));
    await client.commit(intent(31, [preview]));
    assert.equal(client.state().view.time_entries[0].ended_at, manualEnd);
    assert.equal(client.state().view.task_series[0].deleted, true);
    await assert.rejects(client.commit(intent(32, [manualTimerStop(id(50), deleteTime)])), /MANUAL_TIMER_NOT_RUNNING/);
    assert.equal(client.state().artifacts.length, 2);
});

test('先手动结束、再重新设为运行、最后删除时，较早的手动结束不会压过有因果顺序的自动结束', async () => {
    const data = stopDataset(timer(50)), client = await openV2(data);
    await client.commit(intent(30, [manualTimerStop(id(50), manualEnd)]));
    const reopened = { ...client.state().view.time_entries[0], ended_at: null, updated_at: '2026-11-09T11:00:00Z' };
    await client.commit(intent(31, [timeEntryOperation('put', reopened)]));
    await client.commit(intent(32, [deleteOp(client)]));
    assert.equal(client.state().view.time_entries[0].ended_at, deleteTime);
});

test('两个手动结束以及其后的普通计时编辑仍沿用原整条合并规则', async () => {
    const data = stopDataset(timer(50));
    const laterManual = '2026-11-09T11:00:00Z';
    const ops = [deleteOp(await openV2(data)), manualTimerStop(id(50), manualEnd), manualTimerStop(id(50), laterManual)];
    const roots = ops.map((operation, index) => createRecord({ pin: data.pin, ...intent(30 + index, [operation]), profile: v2 }));
    const client = await openV2(data, memoryTransport(roots));
    await client.sync();
    assert.equal(client.state().view.time_entries[0].ended_at, laterManual);
    const corrected = { ...client.state().view.time_entries[0], ended_at: manualEnd, updated_at: '2026-11-09T13:00:00Z' };
    await client.commit(intent(34, [timeEntryOperation('put', corrected)]));
    assert.equal(client.state().view.time_entries[0].ended_at, manualEnd);
});

test('手动结束沿用短计时丢弃，并拒绝无效计时或和其他动作混在一条记录中', async () => {
    const shortEnd = '2026-11-07T12:00:30Z';
    const data = stopDataset(timer(50)), transport = memoryTransport();
    const a = await openV2(data, transport), b = await openV2(data, transport);
    await assert.rejects(a.commit(intent(29, [manualTimerStop(id(99), manualEnd)])), /MANUAL_TIMER_NOT_RUNNING/);
    await assert.rejects(a.commit(intent(29, [manualTimerStop(id(50), manualEnd), deleteOp(a)])), /SERIES_WORKFLOW_REQUIRES_OWN_RECORD/);
    assert.equal(a.state().artifacts.length, 0);
    await a.commit(intent(30, [deleteOp(a)]));
    await b.commit(intent(31, [manualTimerStop(id(50), shortEnd)], 3));
    await a.sync(); await b.sync(); await a.sync();
    const entry = a.state().view.time_entries[0];
    assert.equal(entry.ended_at, shortEnd);
    assert.equal(entry.deleted, true);
    same(a.state().view, b.state().view);
});
