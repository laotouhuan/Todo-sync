import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataset, createRecord, seal, validateJoin } from '../envelope.mjs';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { openInitialization, readPinnedDataset } from '../initialization.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';

const dataset = createDataset({ datasetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-11-05T00:00:00Z', data: { notes: {}, extension: ['保留'] } });
const actorId = '11111111-1111-4111-8111-111111111111';
const intent = (n, text = String(n)) => ({ id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`, actorId,
    createdAt: '2026-11-05T00:00:00Z', operations: [{ type: 'lab.note.set', key: 'task', value: text }] });
const make = (n, parents = [], text) => createRecord({ pin: dataset.pin, ...intent(n, text), parents });
const open = (store, transport) => openRecordLab({ dataset, store, transport });

test('先原子保存再发布；存储失败不出现可见修改和网络写入', async () => {
    const store = new MemoryStore(), transport = memoryTransport();
    const client = await open(store, transport), before = encode(client.state());
    store.save = async () => { throw new Error('DISK_FAILED'); };
    await assert.rejects(client.commit(intent(1)), /DISK_FAILED/);
    assert.deepEqual(encode(client.state()), before);
    assert.equal(transport.files.size, 0);
});
test('上传前重开实例复用同一个ID、正文和outbox', async () => {
    const store = new MemoryStore(), transport = memoryTransport();
    let client = await open(store, transport);
    const fixed = await client.commit(intent(1));
    client = await open(store, transport);
    assert.deepEqual(await client.commit(intent(1)), fixed);
    await client.sync();
    assert.equal(transport.files.size, 1);
    assert.deepEqual(await transport.read(fixed.name), Buffer.from(fixed.base64, 'base64'));
    assert.deepEqual(client.state().outbox, []);
});
test('真实写替身后丢响应，重开读回不重复PUT', async () => {
    const store = new MemoryStore(), transport = memoryTransport(); let writes = 0;
    const normal = transport.write;
    transport.write = async (...args) => { writes++; await normal(...args); if (writes === 1) throw new Error('RESPONSE_LOST'); };
    let client = await open(store, transport);
    await client.commit(intent(1));
    assert.equal((await client.sync()).writeFailures.length, 1);
    assert.equal(client.state().outbox.length, 1);
    client = await open(store, transport);
    await client.sync();
    assert.equal(writes, 1);
    assert.equal(client.state().outbox.length, 0);
});
test('确认落盘失败时重开仍有原outbox，再读回确认', async () => {
    const store = new MemoryStore(), transport = memoryTransport();
    let client = await open(store, transport);
    await client.commit(intent(1));
    const save = store.save.bind(store);
    store.save = async state => { if (!state.outbox.length) throw new Error('ACK_FAILED'); await save(state); };
    await assert.rejects(client.sync(), /ACK_FAILED/);
    assert.equal((await store.load()).outbox.length, 1);
    store.save = save;
    client = await open(store, transport);
    await client.sync();
    assert.equal(client.state().outbox.length, 0);
    assert.equal(transport.files.size, 1);
});
test('父记录未列出也按精确哈希补读；期间不提前发布后继', async () => {
    const a = make(1), b = make(2, [a]), transport = memoryTransport([a, b]), store = new MemoryStore();
    transport.list = async () => [b.name, b.name];
    const read = transport.read; let missing = true;
    transport.read = async name => name === a.name && missing ? null : read(name);
    let client = await open(store, transport);
    await client.sync();
    assert.equal(client.state().reason, 'MISSING_DEPENDENCIES');
    assert.equal(client.state().view.notes.task, undefined);
    await assert.rejects(client.commit(intent(3)), /DATASET_WRITE_BLOCKED/);
    client = await open(store, transport); missing = false;
    transport.list = async () => [];
    await client.sync();
    assert.equal(client.state().blocked, false);
    assert.equal(client.state().view.notes.task, '2');
    assert.equal(client.state().artifacts.length, 2);
});
test('列出但读取失败的根记录重开后仍重试，漏项不删除', async () => {
    const a = make(1), transport = memoryTransport([a]), store = new MemoryStore();
    const read = transport.read; let failed = true;
    transport.read = async name => { if (failed) throw new Error('TEMPORARY'); return read(name); };
    let client = await open(store, transport);
    await client.sync();
    client = await open(store, transport);
    transport.list = async () => []; failed = false;
    await client.sync(); await client.sync();
    assert.equal(client.state().view.notes.task, '1');
    assert.equal(client.state().artifacts.length, 1);
});
test('同 ID 不同正文被发现后冻结已发布暂时视图，重开不得误恢复写入', async () => {
    const a = make(1), b = make(1, [], '争议'), transport = memoryTransport([a]), store = new MemoryStore();
    let client = await open(store, transport);
    await client.sync();
    assert.equal(client.state().view.notes.task, '1');
    await transport.write(b.name, b.bytes);
    await client.sync();
    assert.equal(client.state().blocked, true);
    assert.equal(client.state().artifacts.length, 2);
    assert.equal(client.state().view.notes.task, '1');
    assert.ok(client.state().faults.some(f => f.code === 'RECORD_ID_CONTENT_CONFLICT'));
    client = await open(store, transport);
    await assert.rejects(client.commit(intent(2)), /DATASET_WRITE_BLOCKED/);
});
test('哈希错误和未知操作保留原始证据，不发布局部成功', async () => {
    for (const kind of ['hash', 'operation']) {
        const a = make(1), invalid = kind === 'hash' ? { ...a, bytes: Buffer.from('{}') } : seal('record', { ...a.value, operations: [{ type: 'future.operation' }] });
        const transport = memoryTransport([invalid]), store = new MemoryStore();
        const client = await open(store, transport);
        await client.sync();
        assert.equal(client.state().blocked, true);
        assert.equal(client.state().view.notes.task, undefined);
        assert.equal(client.state().faults[0].base64, invalid.bytes.toString('base64'));
        assert.equal((await store.load()).faults.length, 1);
    }
});
test('冷端仅凭固定数据集和完整记录恢复，并保留扩展', async () => {
    const transport = memoryTransport();
    let client = await open(new MemoryStore(), transport);
    await client.commit(intent(1)); await client.commit(intent(2)); await client.sync();
    const expected = encode(client.state().view);
    client = await open(new MemoryStore(), transport);
    const report = await client.sync();
    assert.deepEqual(encode(client.state().view), expected);
    assert.equal(report.listingCompleteness, 'unknown');
    assert.deepEqual(client.state().view.extension, ['保留']);
});
test('并发两个端根记录不同，分批、重复和乱序补齐后得到相同结果', async () => {
    const a = make(1), b = make(2), c = make(3, [a, b]);
    let expected;
    for (const order of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) {
        const transport = memoryTransport([a,b,c]);
        const client = await open(new MemoryStore(), transport);
        transport.list = async () => [order[0].name, order[0].name]; await client.sync();
        transport.list = async () => order.map(item => item.name); await client.sync();
        const bytes = encode(client.state().view);
        if (!expected) expected = bytes;
        assert.deepEqual(bytes, expected);
        assert.equal(client.state().view.notes.task, '3');
    }
});
test('不接受换目标状态或让提交意图覆盖固定pin', async () => {
    const store = new MemoryStore(), transport = memoryTransport(), client = await open(store, transport);
    await assert.rejects(client.commit({ ...intent(1), pin: {} }), /INVALID_COMMIT_INTENT/);
    const other = createDataset({ datasetId: actorId, createdAt: '2026-11-05T00:00:00Z', data: {} });
    await assert.rejects(openRecordLab({ dataset: other, store, transport }), /LOCAL_STATE_INVALID/);
});
test('同ID重试内容固定，队列冻结意图且后继看见本地未上传父', async () => {
    const client = await open(new MemoryStore(), memoryTransport()), change = intent(1);
    const pending = client.commit(change); change.operations[0].value = '外部篡改';
    const first = await pending;
    await client.commit(intent(2));
    assert.equal(client.state().view.notes.task, '2');
    const second = JSON.parse(Buffer.from(client.state().artifacts[1].base64, 'base64'));
    assert.equal(second.parents[0].id, intent(1).id);
    await assert.rejects(client.commit(intent(1, '新正文')), /RECORD_ID_CONTENT_CONFLICT/);
    assert.deepEqual(await client.commit(intent(1)), first);
});
test('提交已保存但确认丢失，同一实例下一提交不得覆盖已durable修改', async () => {
    const store = new MemoryStore(), transport = memoryTransport(), client = await open(store, transport);
    const save = store.save.bind(store); let lose = true;
    store.save = async value => { await save(value); if (lose && value.artifacts.length === 1) { lose = false; throw new Error('SAVE_RESPONSE_LOST'); } };
    await assert.rejects(client.commit(intent(1)), /SAVE_RESPONSE_LOST/);
    assert.equal(client.state().artifacts.length, 0);
    assert.equal((await store.load()).artifacts.length, 1);
    await client.commit(intent(2));
    assert.equal(client.state().artifacts.length, 2);
    assert.equal(client.state().outbox.length, 2);
    const second = JSON.parse(Buffer.from(client.state().artifacts[1].base64, 'base64'));
    assert.equal(second.parents[0].id, intent(1).id);
    await client.sync();
    assert.equal(transport.files.size, 2);
});
test('故障证据保存后确认丢失，同实例不得用旧可写状态继续提交', async () => {
    const record = make(1), transport = memoryTransport([{ ...record, bytes: Buffer.from('{}') }]);
    const store = new MemoryStore(), client = await open(store, transport), save = store.save.bind(store);
    let lose = true;
    store.save = async value => { await save(value); if (lose && value.faults.length) { lose = false; throw new Error('FAULT_ACK_LOST'); } };
    await assert.rejects(client.sync(), /FAULT_ACK_LOST/);
    await assert.rejects(client.commit(intent(2)), /DATASET_WRITE_BLOCKED/);
    assert.equal(client.state().faults.length, 1);
    assert.equal(client.state().outbox.length, 0);
});
test('超过256条批次上限时，重复完整列举不会饿死第257条', async () => {
    const records = Array.from({ length: 257 }, (_, i) => make(i + 1));
    const client = await open(new MemoryStore(), memoryTransport(records));
    await client.sync();
    assert.equal(client.state().artifacts.length, 256);
    await client.sync();
    assert.equal(client.state().artifacts.length, 257);
    assert.equal(client.state().view.notes.task, '257');
});
test('前256条持续读取失败，持久轮转后队尾仍能在重开时推进', async () => {
    const records = Array.from({ length: 257 }, (_, i) => make(i + 1)), transport = memoryTransport(records), store = new MemoryStore();
    const read = transport.read;
    transport.read = async name => { if (name !== records.at(-1).name) throw new Error('TEMPORARY'); return read(name); };
    let client = await open(store, transport);
    await client.sync(); assert.equal(client.state().artifacts.length, 0);
    client = await open(store, transport);
    await client.sync();
    assert.equal(client.state().artifacts.length, 1);
    assert.equal(client.state().view.notes.task, '257');
    assert.equal(client.state().retryNames.length, 256);
});
test('两端同时首次上传同ID不同正文，均保留不同哈希文件，再发现时双方冻结', async () => {
    const transport = memoryTransport(), a = await open(new MemoryStore(), transport), b = await open(new MemoryStore(), transport);
    await a.commit(intent(1, 'A'));
    await b.commit({ ...intent(1, 'B'), actorId: '22222222-2222-4222-8222-222222222222' });
    await Promise.all([a.sync(), b.sync()]);
    assert.equal(transport.files.size, 2);
    await Promise.all([a.sync(), b.sync()]);
    assert.equal(a.state().blocked, true); assert.equal(b.state().blocked, true);
    assert.equal(a.state().artifacts.length, 2); assert.equal(b.state().artifacts.length, 2);
});

// 用最小独立业务域验证接口，而非依赖待接入的普通任务适配器实现。
const counterProfile = Object.freeze({
    id: 'lab-profile-test-counter/1',
    validateBaseline(data) {
        if (!Number.isSafeInteger(data.total) || data.total < 0) throw new Error('COUNTER_BASELINE_INVALID');
    },
    validateOperation(operation) {
        if (operation?.type !== 'counter.add' || Object.keys(operation).length !== 2 || !Number.isSafeInteger(operation.amount)) {
            throw new Error('COUNTER_OPERATION_INVALID');
        }
    },
    project(baseline, records) {
        const data = structuredClone(baseline);
        for (const record of records) for (const operation of record.operations) {
            data.total += operation.amount;
            if (data.total < 0) throw new Error('COUNTER_NEGATIVE');
        }
        return data;
    }
});
const counterDataset = () => createDataset({ datasetId: dataset.pin.dataset_id, createdAt: '2026-11-05T00:00:00Z',
    data: { total: 0, extension: ['原样'] }, profile: counterProfile });
const counterIntent = (number, amount) => ({ ...intent(number), operations: [{ type: 'counter.add', amount }] });

test('显式profile贯通初始化、固定加入、提交和恢复，默认profile不能自动解释其他目录', async () => {
    const selected = counterDataset(), transport = memoryTransport();
    assert.throws(() => validateJoin(selected.pin, selected.descriptor.bytes, selected.baseline.bytes), /INVALID_DATASET_BINDING/);
    await assert.rejects(openInitialization({ dataset: selected, store: new MemoryStore(), transport }), /INVALID_DATASET_BINDING/);
    await assert.rejects(openRecordLab({ dataset: selected, store: new MemoryStore(), transport }), /INVALID_DATASET_BINDING/);
    const initialization = await openInitialization({ dataset: selected, store: new MemoryStore(), transport, profile: counterProfile });
    await initialization.publish(); await initialization.exposeInvite();
    await assert.rejects(readPinnedDataset({ pin: selected.pin, transport }), /INVALID_DATASET_BINDING/);
    assert.equal((await readPinnedDataset({ pin: selected.pin, transport, profile: counterProfile })).descriptor.operation_set, counterProfile.id);
    const client = await openRecordLab({ dataset: selected, store: new MemoryStore(), transport, profile: counterProfile });
    await client.commit(counterIntent(1, 2)); await client.sync();
    assert.throws(() => createRecovery({ dataset: selected, state: client.state() }), /INVALID_DATASET_BINDING/);
    const bundle = createRecovery({ dataset: selected, state: client.state(), profile: counterProfile });
    assert.throws(() => restoreRecovery({ dataset: selected, bundle }), /INVALID_DATASET_BINDING/);
    const restored = restoreRecovery({ dataset: selected, bundle, profile: counterProfile });
    const reopened = await openRecordLab({ dataset: selected, store: new MemoryStore(restored), transport, profile: counterProfile });
    assert.deepEqual(reopened.state().view, { total: 2, extension: ['原样'] });
});

test('本地业务预演失败不持久化记录、outbox或故障，不冻结后续合法提交', async () => {
    const selected = counterDataset(), store = new MemoryStore(), transport = memoryTransport();
    const client = await openRecordLab({ dataset: selected, store, transport, profile: counterProfile });
    const before = encode(client.state());
    await assert.rejects(client.commit(counterIntent(1, -1)), /COUNTER_NEGATIVE/);
    assert.deepEqual(encode(client.state()), before);
    assert.deepEqual(encode(await store.load()), before);
    assert.equal(transport.files.size, 0);
    await client.commit(counterIntent(2, 2));
    assert.equal(client.state().view.total, 2);
    assert.equal(client.state().artifacts.length, 1);
    assert.equal(client.state().faults.length, 0);
});

test('远端和恢复中的业务重放失败保留原字节与故障，不发布批次前半部分', async () => {
    const selected = counterDataset(), record = createRecord({ pin: selected.pin, ...counterIntent(1, 2),
        operations: [{ type: 'counter.add', amount: 2 }, { type: 'counter.add', amount: -3 }], profile: counterProfile });
    const client = await openRecordLab({ dataset: selected, store: new MemoryStore(), transport: memoryTransport([record]), profile: counterProfile });
    await client.sync();
    assert.equal(client.state().blocked, true);
    assert.equal(client.state().view.total, 0);
    assert.equal(client.state().artifacts[0].base64, record.bytes.toString('base64'));
    assert.ok(client.state().faults.some(fault => fault.code === 'COUNTER_NEGATIVE'));
    const incoming = { version: 1, pin: selected.pin, artifacts: [{ name: record.name, base64: record.bytes.toString('base64') }],
        outbox: [], retryNames: [], faults: [], view: { total: 999 } };
    const bundle = createRecovery({ dataset: selected, state: incoming, profile: counterProfile });
    assert.equal(bundle.frontier.status, 'FAULT');
    const healthy = await openRecordLab({ dataset: selected, store: new MemoryStore(), transport: memoryTransport(), profile: counterProfile });
    const restored = restoreRecovery({ dataset: selected, currentState: healthy.state(), bundle, profile: counterProfile });
    assert.equal(restored.blocked, true);
    assert.equal(restored.view.total, 0);
    assert.equal(restored.artifacts[0].base64, record.bytes.toString('base64'));
    assert.ok(restored.faults.some(fault => fault.code === 'COUNTER_NEGATIVE'));
});
