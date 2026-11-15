import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createDataset, createRecord, validateJoin } from '../envelope.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { PERSONAL_PERIOD_PROFILE, periodTodoOperation } from '../period-record-profile.mjs';
import { PERSONAL_SERIES_PROFILE as profile, seriesOperation } from '../series-record-profile.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-11-07T02:00:00Z';
const first = '2026-11-07T02:00:00.001100Z';
const sameMillis = '2026-11-07T10:00:00.001900+08:00';
const later = '2026-11-07T02:00:00.002Z';
const todo = { id: id(11), content: '旧任务正文', date: '2026-W45', task_type: 'weekly_checkin', created_at: at, updated_at: at };
const series = { id: id(12), content: '初始名称', period_type: 'week', created_at: at, updated_at: at,
    content_updated_at: at, extension: { history: ['系列'] } };
const link = { todo_id: todo.id, series_id: series.id, period: todo.date, created_at: at, updated_at: at, extension: ['关联'] };
const base = (fields = {}) => ({ version: 1, last_updated: at, todos: [todo], task_series: [series], task_series_links: [link], ...fields });
const dataset = (data = base()) => createDataset({ datasetId: id(1), createdAt: at, data, profile });
const open = (data, store = new MemoryStore(), transport = memoryTransport()) => openRecordLab({ dataset: data, store, transport, profile });
const intent = (n, operations, actor = 2) => ({ id: id(n), actorId: id(actor), createdAt: at, operations });
const record = (data, n, operations) => createRecord({ pin: data.pin, ...intent(n, operations), profile });
const rename = (content, updated_at = first) => seriesOperation('rename', { series_id: series.id, content, updated_at });
const unlink = (updated_at = first) => seriesOperation('link.unlink', { todo_id: todo.id, series_id: series.id, updated_at, next_series_id: id(21) });
const relink = (updated_at = sameMillis) => seriesOperation('link.put', { todo_id: todo.id, series_id: series.id, updated_at });
const same = (a, b) => assert.deepEqual(encode(a), encode(b));

test('离线改名和解除／重新关联的平局与发现顺序无关，原始字段可恢复', async () => {
    const data = dataset(), transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    await a.commit(intent(30, [rename('跑步'), unlink()]));
    await b.commit(intent(31, [rename('散步', sameMillis), relink()], 3));
    await a.sync(); await b.sync(); await a.sync();
    const expected = a.state().view;
    same(expected, b.state().view);
    same(expected.todos[0], todo);
    assert.equal(expected.task_series[0].content, '跑步');
    assert.equal(expected.task_series[0].content_updated_at, first);
    same(expected.task_series[0].extension, series.extension);
    assert.equal(expected.task_series_links[0].deleted, true);
    assert.equal(expected.task_series_links[0].next_series_id, id(21));
    same(expected.task_series_links[0].extension, link.extension);
    const cold = await open(data, new MemoryStore(), transport);
    transport.list = async () => [...transport.files.keys()].reverse().flatMap(name => [name, name]);
    await cold.sync();
    same(cold.state().view, expected);
    const bundle = createRecovery({ dataset: data, state: cold.state(), profile });
    same(restoreRecovery({ dataset: data, bundle, profile }).view, expected);
    await a.commit(intent(32, [rename('散步', later), relink(later)]));
    assert.equal(a.state().view.task_series[0].content, '散步');
    assert.equal(a.state().view.task_series_links[0].deleted, false);
    assert.equal(a.state().view.task_series_links[0].next_series_id, null);
});

test('原关联可解除已清理任务，重新关联仍要求基线有有效任务', async () => {
    const data = dataset(base({ todos: [] })), client = await open(data);
    await assert.rejects(client.commit(intent(30, [relink()])), /SERIES_RELINK_TODO_NOT_ACTIVE_IN_BASELINE/);
    await client.commit(intent(31, [unlink()]));
    assert.deepEqual(client.state().view.todos, []);
    assert.equal(client.state().view.task_series_links[0].next_series_id, id(21));
    assert.equal(client.state().view.task_series_links[0].deleted, true);
});

test('名称与关联按固定基线预检，非法混合批次本地拒绝且远端保留原始证据', async () => {
    const data = dataset(), store = new MemoryStore(), client = await open(data, store);
    const invalid = { ...relink(), todo_id: id(50) };
    const operations = [rename('新名称'), invalid];
    const before = await store.load();
    await assert.rejects(client.commit(intent(30, operations)), /SERIES_LINK_TARGET_NOT_IN_BASELINE/);
    same(await store.load(), before);
    const bad = record(data, 30, operations);
    const remote = await open(data, new MemoryStore(), memoryTransport([bad]));
    await remote.sync();
    assert.equal(remote.state().blocked, true);
    assert.equal(remote.state().view.task_series[0].content, '初始名称');
    assert.equal(remote.state().artifacts[0].base64, bad.bytes.toString('base64'));
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, PERSONAL_PERIOD_PROFILE), /INVALID_DATASET_BINDING/);
});

test('系列名称不覆盖任务历史，系列写入与有效周期操作可在同一批重放', async () => {
    const data = dataset(), client = await open(data);
    const changed = { ...todo, updated_at: later, target_count: 5 };
    await client.commit(intent(30, [rename('新名称'), periodTodoOperation('put', changed), unlink()]));
    assert.equal(client.state().view.task_series[0].content, '新名称');
    assert.equal(client.state().view.todos[0].target_count, 5);
    assert.equal(client.state().view.todos[0].content, '旧任务正文');
    assert.equal(client.state().view.task_series_links[0].deleted, true);
});

test('固定意图必须提供有效时间、名称与新身份，不接受额外字段', () => {
    assert.throws(() => rename('  '), /INVALID_SERIES_NAME/);
    assert.throws(() => rename('合法', '2026-11-07T02:00:00'), /INVALID_TODO_TIMESTAMP/);
    assert.throws(() => profile.validateOperation({ ...unlink(), next_series_id: '无效身份' }), /INVALID_NEXT_SERIES_ID/);
    assert.throws(() => profile.validateOperation({ ...relink(), next_series_id: id(21) }), /INVALID_SERIES_OPERATION/);
    assert.throws(() => seriesOperation('delete', { series_id: series.id, updated_at: at }), /UNSUPPORTED_SERIES_ACTION/);
});
