import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport } from '../client.mjs';
import { createDataset, createRecord } from '../envelope.mjs';
import { NOTE_PROFILE } from '../operation-profile.mjs';
import { openCollaborationBoundaryLab } from '../collaboration-boundary.mjs';

const id = n => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-11-07T02:00:00Z';
const dataset = createDataset({ datasetId: id(1), createdAt: at, data: { notes: {} } });
const binding = { sourceId: '测试来源', targetKey: '隔离目录甲', generation: 1, pin: dataset.pin };
const create = { type: 'lab.note.set', key: '只用于测试新增入口', value: '新正文' };
const intent = (operations = [create]) => ({ id: id(10), actorId: id(2), createdAt: at, operations });
const validateCreateOperation = operation => {
    if (operation.key !== create.key) throw new Error('FIXTURE_CREATE_SHAPE_REJECTED');
    NOTE_PROFILE.validateOperation(operation);
};

function harness(options = {}) {
    const store = options.store ?? new MemoryStore();
    const transport = options.transport ?? memoryTransport();
    const config = { current: options.binding ?? binding, access: options.access ?? 'append' };
    const open = (overrides = {}) => openCollaborationBoundaryLab({ dataset, store, transport, binding: config.current,
        getCurrentBinding: () => config.current, getCurrentAccess: () => config.access,
        access: config.access, createType: create.type, validateCreateOperation, profile: NOTE_PROFILE, ...overrides });
    return { open, config, store, transport };
}

test('只读能同步和查看已有记录，不能提交新增', async () => {
    const remote = createRecord({ pin: dataset.pin, ...intent() });
    const { open, transport } = harness({ access: 'view', transport: memoryTransport([remote]) });
    const reader = await open();
    await reader.sync();
    assert.equal(reader.view().notes[create.key], create.value);
    await assert.rejects(reader.append(binding, intent()), /COLLABORATION_VIEW_ONLY/);
    assert.equal(transport.files.size, 1);
    assert.equal(reader.commit, undefined);
});

test('协作新增入口只接受一条已通过业务验证的新建，拒绝个人写入和混入第二项', async () => {
    const { open, store, transport } = harness();
    const client = await open();
    const before = encode(await store.load());
    for (const [ops, code] of [
        [[], /COLLABORATION_REQUIRES_ONE_CREATE/],
        [[{ type: 'todo.normal.put' }], /COLLABORATION_REQUIRES_ONE_CREATE/],
        [[create, create], /COLLABORATION_REQUIRES_ONE_CREATE/],
        [[{ ...create, key: '绕过' }], /FIXTURE_CREATE_SHAPE_REJECTED/],
        [[{ ...create, owner: true }], /UNSUPPORTED_OPERATION/]
    ]) {
        await assert.rejects(client.append(binding, intent(ops)), code);
        assert.deepEqual(encode(await store.load()), before);
    }
    await client.append(binding, intent());
    await client.sync();
    assert.equal(transport.files.size, 1);
});

test('切换代次、目录、数据集或来源时拒绝旧草稿和旧存储', async () => {
    const { open, config, store, transport } = harness();
    const client = await open();
    await client.append(binding, intent());
    const before = encode(await store.load());
    for (const next of [
        { ...binding, generation: 2 },
        { ...binding, targetKey: '隔离目录乙' },
        { ...binding, sourceId: '另一来源' }
    ]) {
        config.current = next;
        await assert.rejects(client.sync(), /COLLABORATION_TARGET_CHANGED/);
        await assert.rejects(open(), /COLLABORATION_STORE_BINDING_MISMATCH/);
        assert.deepEqual(encode(await store.load()), before);
        const fresh = await open({ store: new MemoryStore() });
        await assert.rejects(fresh.append(binding, intent()), /COLLABORATION_DRAFT_BINDING_MISMATCH/);
    }
    const other = createDataset({ datasetId: id(99), createdAt: at, data: { notes: {} } });
    config.current = { ...binding, pin: other.pin };
    await assert.rejects(open(), /COLLABORATION_DATASET_BINDING_MISMATCH/);
    assert.equal(transport.files.size, 0);
});

test('列表读取后换源时拒绝旧结果和上传，原队列保持可恢复', async () => {
    const transport = memoryTransport();
    const h = harness({ transport });
    const read = transport.read;
    let switchBeforePut = true;
    transport.read = async name => {
        const value = await read(name);
        if (switchBeforePut) h.config.current = { ...binding, generation: 2 };
        return value;
    };
    const client = await h.open();
    await client.append(binding, intent());
    await assert.rejects(client.sync(), /COLLABORATION_TARGET_CHANGED/);
    assert.equal(transport.files.size, 0);
    assert.equal((await h.store.load()).state.outbox.length, 1);
    switchBeforePut = false;
    h.config.current = binding;
    const original = await h.open();
    await original.sync();
    assert.equal(transport.files.size, 1);
});

test('请求发出后换源时旧写入只到原固定传输，旧结果不会清空原队列', async () => {
    const transport = memoryTransport();
    const h = harness({ transport });
    const write = transport.write;
    let injected = false;
    transport.write = async (name, bytes) => {
        await write(name, bytes);
        injected = true;
        h.config.current = { ...binding, targetKey: '隔离目录乙', generation: 2 };
    };
    const client = await h.open();
    await client.append(binding, intent());
    await assert.rejects(client.sync(), /COLLABORATION_TARGET_CHANGED/);
    assert.equal(injected, true);
    assert.equal(transport.files.size, 1);
    assert.equal((await h.store.load()).state.outbox.length, 1);
    const freshTarget = memoryTransport();
    const other = await h.open({ store: new MemoryStore(), transport: freshTarget });
    await other.sync();
    assert.equal(freshTarget.files.size, 0);
    h.config.current = binding;
    const original = await h.open();
    await original.sync();
    assert.equal((await h.store.load()).state.outbox.length, 0);
    assert.equal(transport.files.size, 1);
});

test('降为只读后当前实例和重开实例均不会发送待传记录', async () => {
    const h = harness(), writer = await h.open();
    await writer.append(binding, intent());
    h.config.access = 'view';
    await assert.rejects(writer.append(binding, intent()), /COLLABORATION_VIEW_ONLY/);
    await writer.sync();
    const reader = await h.open();
    await reader.sync();
    assert.equal(h.transport.files.size, 0);
    assert.equal((await h.store.load()).state.outbox.length, 1);
});

test('持久队列中的待写记录同样核对目标和业务范围', async () => {
    const h = harness(), client = await h.open();
    const invalid = createRecord({ pin: dataset.pin, ...intent([{ ...create, key: '个人提交绕过' }]) });
    const state = await h.store.load();
    state.state.outbox.push(invalid.name);
    state.state.artifacts.push({ name: invalid.name, base64: invalid.bytes.toString('base64') });
    await h.store.save(state);
    const result = await client.sync();
    assert.deepEqual(result.writeFailures, [invalid.name]);
    assert.equal(h.transport.files.size, 0);
});
