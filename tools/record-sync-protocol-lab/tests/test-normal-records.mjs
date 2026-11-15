import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode } from '../codec.mjs';
import { createDataset, createRecord, inspect, seal, validateJoin, verifyRecord } from '../envelope.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { openInitialization, readPinnedDataset } from '../initialization.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { NORMAL_TODO_PROFILE as profile, normalTodoOperation } from '../normal-record-profile.mjs';

const id = value => `40000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const time = '2026-11-07T02:00:00Z';
const taskTime = '2026-11-05T00:00:00Z';
const todo = (fields = {}) => ({ id: id(100), content: '任务', created_at: taskTime, updated_at: taskTime, ...fields });
const operation = raw => normalTodoOperation(raw.deleted ? 'delete' : 'put', raw);
const baseline = (todos = []) => ({ version: 1, last_updated: taskTime, todos,
    reminder_settings: { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] },
    time_entries: [], daily_reviews: [], task_series: [], task_series_links: [], future: { opaque: ['原值'] } });
const dataset = (data = baseline()) => createDataset({ datasetId: id(1), createdAt: time, data, profile });
const intent = (number, raw, fields = {}) => ({ id: id(number), actorId: id(2), createdAt: time, operations: [operation(raw)], ...fields });
const record = (data, number, raw, parents = []) => createRecord({ pin: data.pin, ...intent(number, raw), parents, profile });
const open = (data, store = new MemoryStore(), transport = memoryTransport()) => openRecordLab({ dataset: data, store, transport, profile });
const same = (actual, expected) => assert.deepEqual(encode(actual), encode(expected));
const shared = JSON.parse(readFileSync(new URL('../../../tests/fixtures/normal-todo/conflicts.json', import.meta.url), 'utf8'));

for (const sample of shared.validCases) test(`普通业务日志 ${sample.id}：乱序、遗漏补齐、重复和冷端一致`, async () => {
    const data = dataset(baseline([sample.records[0]])), records = sample.records.map((raw, index) => record(data, index + 10, raw));
    const expected = sample.winners;
    for (const sequence of [records, [...records].reverse(), [...records, ...records]]) {
        const transport = memoryTransport(records), store = new MemoryStore(), client = await open(data, store, transport);
        let listed = sequence.slice(0, 1).map(item => item.name);
        transport.list = async () => listed;
        await client.sync();
        listed = sequence.map(item => item.name); await client.sync();
        same(client.state().view.todos, expected);
        same(client.state().view.future, data.baseline.value.data.future);
        assert.equal(client.state().view.last_updated, time);
        listed = []; await client.sync();
        same(client.state().view.todos, expected);
        assert.equal(client.state().artifacts.length, records.length);
        const cold = await open(data, new MemoryStore(), memoryTransport(records));
        await cold.sync(); same(cold.state().view, client.state().view);
    }
});

test('应用操作仅承载一条普通任务，固定归一并拒绝类型伪装与整文件替换', () => {
    const op = operation(todo({ label: ' \ufeffe\u0301 ' }));
    assert.equal(op.todo.label, 'é');
    assert.equal(op.todo.completed, false);
    assert.equal(op.todo.reminder, null);
    for (const fields of [{ task_type: 'weekly_checkin' }, { date: '2026-W45' }, { recurring: 'monthly' }]) {
        assert.throws(() => operation(todo(fields)), /UNSUPPORTED_NORMAL_RECORD_TASK_TYPE/);
    }
    const data = dataset();
    for (const operations of [[{ type: 'data.replace', data: baseline() }], [{ ...op, data: baseline() }],
        [{ type: 'todo.normal.delete', todo: op.todo }], [{ type: 'todo.normal.put', todo: todo() }]]) {
        assert.throws(() => createRecord({ pin: data.pin, ...intent(10, todo()), operations, profile }),
            /UNSUPPORTED_OPERATION|DELETE_KIND_MISMATCH|NON_NORMALIZED/);
    }
});

test('实验Schema引用可解析、归一输出补齐必填项，旧任务及子任务身份由上下文校验', () => {
    const schema = JSON.parse(readFileSync(new URL('../normal-record-profile.schema.json', import.meta.url), 'utf8'));
    const domain = schema.properties.todo;
    assert.equal(domain.properties.id.type, 'string');
    assert.equal(domain.properties.id.format, undefined);
    assert.equal(domain.properties.subtasks.items.properties.id.type, 'string');
    assert.equal(domain.properties.subtasks.items.properties.id.format, undefined);
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.$ref) {
            const [file, pointer] = value.$ref.split('#');
            let resolved = JSON.parse(readFileSync(new URL(file, new URL('../normal-record-profile.schema.json', import.meta.url)), 'utf8'));
            for (const part of pointer.slice(1).split('/')) resolved = resolved[part.replaceAll('~1', '/').replaceAll('~0', '~')];
            assert.notEqual(resolved, undefined, value.$ref);
        }
        Object.values(value).forEach(visit);
    };
    visit(schema);
    for (const sample of shared.validCases) for (const raw of sample.records) {
        const op = operation(raw);
        for (const key of domain.required) assert.ok(Object.hasOwn(op.todo, key), `${sample.id} 缺少 ${key}`);
        for (const child of op.todo.subtasks) for (const key of domain.properties.subtasks.items.required) assert.ok(Object.hasOwn(child, key));
    }
});

test('描述符固定操作集合，不按未知操作自动换profile，默认notes不能解释普通业务', async () => {
    const data = dataset(), artifact = record(data, 10, todo());
    assert.equal(data.descriptor.value.operation_set, 'lab-normal-todo/1');
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes), /INVALID_DATASET_BINDING/);
    assert.throws(() => verifyRecord(data.pin, artifact.name, artifact.bytes), /UNSUPPORTED_OPERATION/);
    await assert.rejects(openRecordLab({ dataset: data, store: new MemoryStore(), transport: memoryTransport() }), /INVALID_DATASET_BINDING/);
    const initialized = await openInitialization({ dataset: data, store: new MemoryStore(), transport: memoryTransport(), profile });
    await initialized.publish();
    const pin = await initialized.exposeInvite(); same(pin, data.pin);
});

test('冻结ID、时间、字节和outbox，上传成功但确认丢失后重开核对同一记录', async () => {
    const data = dataset(), store = new MemoryStore(), transport = memoryTransport();
    let client = await open(data, store, transport);
    const change = intent(10, todo()), pending = client.commit(change);
    change.operations[0].todo.content = '调用之后修改';
    const saved = await pending;
    assert.equal(client.state().view.todos[0].content, '任务');
    let lost = true; const write = transport.write;
    transport.write = async (name, bytes) => { await write(name, bytes); if (lost) { lost = false; throw new Error('RESPONSE_LOST'); } };
    await client.sync(); assert.equal(client.state().outbox.length, 1);
    client = await open(data, store, transport);
    same(await client.commit(intent(10, todo())), saved);
    await assert.rejects(client.commit(intent(10, todo({ content: '同ID异内容' }))), /RECORD_ID_CONTENT_CONFLICT/);
    await client.sync(); assert.equal(client.state().outbox.length, 0);
    assert.equal(transport.files.size, 1);
    assert.deepEqual(await transport.read(saved.name), Buffer.from(saved.base64, 'base64'));
});

test('本地批次业务预演失败不保存有毒记录，不发布半批任务或触网', async () => {
    const period = { ...operation(todo()).todo, task_type: 'weekly_checkin', date: '2026-W45' };
    const data = dataset(baseline([period])), store = new MemoryStore(), transport = memoryTransport();
    const client = await open(data, store, transport), before = encode(await store.load());
    const operations = [operation(todo({ id: id(101), content: '有效新增' })), operation(todo())];
    await assert.rejects(client.commit(intent(10, todo(), { operations })), /NORMAL_RECORD_TARGET_TYPE_CONFLICT/);
    assert.deepEqual(encode(await store.load()), before);
    assert.equal(client.state().faults.length, 0);
    assert.equal(client.state().artifacts.length, 0);
    assert.equal(transport.files.size, 0);
});

test('新任务ID必须UUIDv4，旧baseline字符串身份仍可修改，删除及恢复沿整条时间规则', async () => {
    const old = todo({ id: '旧字符串身份' }), data = dataset(baseline([old]));
    const client = await open(data);
    await assert.rejects(client.commit(intent(10, todo({ id: '错误的新ID' }))), /INVALID_NEW_TODO_ID/);
    await client.commit(intent(11, { ...old, content: '旧任务修改', updated_at: '2026-11-05T00:01:00Z' }));
    await client.commit(intent(12, { ...old, deleted: true, updated_at: '2026-11-05T00:02:00Z' }));
    assert.equal(client.state().view.todos[0].deleted, true);
    await client.commit(intent(13, { ...old, content: '较新恢复', updated_at: '2026-11-05T00:03:00Z' }));
    assert.equal(client.state().view.todos[0].deleted, false);
    assert.equal(client.state().artifacts.length, 3);
});

test('新子任务必须UUIDv4，基线及历史里已有的旧身份可以编辑和恢复', async () => {
    const legacy = todo({ subtasks: [{ id: '旧子任务', content: '已有内容' }] });
    const client = await open(dataset(baseline([legacy])));
    const before = encode(client.state());
    await assert.rejects(client.commit(intent(10, { ...legacy, subtasks: [{ id: '错误的新子任务', content: '新增' }] })), /INVALID_NEW_SUBTASK_ID/);
    assert.deepEqual(encode(client.state()), before);
    await client.commit(intent(11, { ...legacy, updated_at: '2026-11-05T00:01:00Z', subtasks: [] }));
    await client.commit(intent(12, { ...legacy, updated_at: '2026-11-05T00:02:00Z', subtasks: [{ id: '旧子任务', content: '重新编辑' }] }));
    assert.equal(client.state().view.todos[0].subtasks[0].id, '旧子任务');
    const fresh = await open(dataset());
    await assert.rejects(fresh.commit(intent(13, todo({ subtasks: [{ id: '新孩子', content: '必须UUID' }] }))), /INVALID_NEW_SUBTASK_ID/);
    await assert.rejects(client.commit(intent(14, { ...legacy, id: id(101) })), /INVALID_NEW_SUBTASK_ID/);
});

test('收到域非法整批保留原字节并冻结，恢复包不发布半批结果', async () => {
    const period = { ...operation(todo()).todo, task_type: 'monthly_checkin', date: '2026-11' };
    const data = dataset(baseline([period]));
    const bad = createRecord({ pin: data.pin, ...intent(10, todo(), { operations: [
        operation(todo({ id: id(101) })), operation(todo())
    ] }), profile });
    const client = await open(data, new MemoryStore(), memoryTransport([bad]));
    await client.sync();
    assert.equal(client.state().blocked, true);
    assert.equal(client.state().view.todos.length, 1);
    assert.equal(client.state().artifacts[0].base64, bad.bytes.toString('base64'));
    const packed = createRecovery({ dataset: data, state: client.state(), profile });
    const restored = restoreRecovery({ dataset: data, bundle: packed, profile });
    assert.equal(restored.blocked, true);
    assert.equal(restored.artifacts.length, 1);
    assert.equal(restored.view.todos.length, 1);
    await assert.rejects(client.commit(intent(11, todo({ id: id(101) }))), /DATASET_WRITE_BLOCKED/);
});

test('远端批次混入未知操作，整条记录保留为故障证据，不先应用首项', async () => {
    const data = dataset(), valid = record(data, 10, todo());
    const bad = seal('record', { ...valid.value, operations: [operation(todo()), { type: 'future.operation' }] });
    const client = await open(data, new MemoryStore(), memoryTransport([bad])); await client.sync();
    assert.equal(client.state().blocked, true);
    assert.equal(client.state().view.todos.length, 0);
    assert.equal(client.state().faults[0].base64, bad.bytes.toString('base64'));
});

test('补齐精确父引用后按业务时钟选胜者，因果后继不强行覆盖较新整条', async () => {
    const data = dataset(), parent = record(data, 10, todo({ content: '较新正文', updated_at: '2026-11-05T00:02:00Z' }));
    const child = record(data, 11, todo({ content: '因果后继但时钟更旧', updated_at: '2026-11-05T00:01:00Z' }), [parent]);
    const transport = memoryTransport([parent, child]); transport.list = async () => [child.name];
    const client = await open(data, new MemoryStore(), transport); await client.sync(); await client.sync();
    assert.equal(client.state().view.todos[0].content, '较新正文');
    assert.equal(client.state().artifacts.length, 2);
});

test('完整个人数据其他集合与周期任务原样透传，恢复忽略伪造投影并并入新增日志', async () => {
    const source = JSON.parse(readFileSync(new URL('../../../tests/fixtures/contract/current-personal.json', import.meta.url), 'utf8'));
    source.future = JSON.parse('{"__proto__":{"keep":true},"opaque":["不改写"]}');
    const data = dataset(source), client = await open(data);
    const original = structuredClone(source.todos[0]);
    await client.commit(intent(10, { ...original, deleted: true, updated_at: '2026-11-05T00:02:00Z' }));
    const earlier = createRecovery({ dataset: data, state: client.state(), profile });
    await client.commit(intent(11, todo({ id: id(101), content: '备份之后新增' })));
    const state = client.state(); earlier.state.view = baseline();
    const restored = restoreRecovery({ dataset: data, currentState: state, bundle: earlier, profile });
    assert.equal(restored.artifacts.length, 2);
    assert.equal(restored.outbox.length, 2);
    assert.equal(restored.view.todos.find(t => t.id === original.id).deleted, true);
    same(restored.view.todos.find(t => t.id === source.todos[1].id), source.todos[1]);
    for (const key of Object.keys(source).filter(key => !['todos', 'last_updated'].includes(key))) same(restored.view[key], source[key]);
    same(restored.view, client.state().view);
});

test('普通任务投影不读取当前时钟，固定输入产生固定完整结果且不改原始材料', () => {
    const data = dataset(), artifact = record(data, 10, todo()), records = inspect(data.pin, [artifact], profile).ordered;
    const before = encode(data.baseline.value.data), raw = encode(records);
    const DateClass = globalThis.Date;
    globalThis.Date = class extends DateClass {
        constructor(...args) { if (!args.length) throw new Error('CURRENT_CLOCK_FORBIDDEN'); super(...args); }
        static now() { throw new Error('CURRENT_CLOCK_FORBIDDEN'); }
    };
    try {
        const first = profile.project(data.baseline.value.data, records), second = profile.project(data.baseline.value.data, records);
        same(first, second); same(data.baseline.value.data, decode(before)); same(records, decode(raw));
    } finally { globalThis.Date = DateClass; }
});

test('初始化及固定邀请以普通任务profile核对，默认notes加入不能越过版本绑定', async () => {
    const data = dataset(), transport = memoryTransport(), store = new MemoryStore();
    const initial = await openInitialization({ dataset: data, store, transport, profile });
    await initial.publish(); await initial.exposeInvite();
    const joined = await readPinnedDataset({ pin: data.pin, transport, profile });
    same(joined.baseline.data, data.baseline.value.data);
    await assert.rejects(readPinnedDataset({ pin: data.pin, transport }), /INVALID_DATASET_BINDING/);
});
