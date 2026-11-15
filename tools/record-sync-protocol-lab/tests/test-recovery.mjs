import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { createDataset, createRecord, seal } from '../envelope.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';

const actorId = '11111111-1111-4111-8111-111111111111';
const dataset = createDataset({ datasetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-11-05T00:00:00Z', data: { notes: { initial: '基线' }, extension: ['保留'] } });
const intent = (number, value = String(number)) => ({ id: `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`, actorId,
    createdAt: '2026-11-05T00:00:00Z', operations: [{ type: 'lab.note.set', key: 'task', value }] });
const make = (number, parents = [], value) => createRecord({ pin: dataset.pin, ...intent(number, value), parents });
const row = artifact => ({ name: artifact.name, base64: artifact.bytes.toString('base64') });
const state = (artifacts = [], outbox = []) => ({ version: 1, pin: structuredClone(dataset.pin), artifacts: artifacts.map(row),
    outbox: outbox.map(item => item.name), retryNames: [], faults: [], view: { notes: { cached: '不能当作依据' } }, blocked: false, reason: null });
const equal = (a, b) => assert.deepEqual(encode(a), encode(b));

test('恢复包保留固定数据集原字节，仅声明打包端已知范围；健康时丢弃缓存重算', () => {
    const a = make(1), b = make(2, [a]);
    const bundle = createRecovery({ dataset, state: state([b, a], [b]) });
    assert.equal(bundle.frontier.completeness, 'known-only');
    equal(bundle.frontier.heads, [{ id: b.value.id, sha256: b.sha256 }]);
    assert.equal(Buffer.from(bundle.dataset.baseline.base64, 'base64').equals(dataset.baseline.bytes), true);
    assert.equal(Buffer.from(bundle.dataset.descriptor.base64, 'base64').equals(dataset.descriptor.bytes), true);
    bundle.state.view = { notes: { forged: '伪造缓存' } };
    const restored = restoreRecovery({ dataset, bundle });
    equal(restored.view, { notes: { initial: '基线', task: '2' }, extension: ['保留'] });
    assert.equal(restored.blocked, false);
    assert.deepEqual(restored.outbox, [b.name]);
});

test('旧包与新状态取并集，不覆盖新事件、未上传意图、读取重试或扩展状态', () => {
    const a = make(1), b = make(2, [a]);
    const bundle = createRecovery({ dataset, state: state([a], [a]) });
    bundle.state.retryNames = [a.name];
    const current = state([b], [b]); current.retryNames = [b.name]; current.localDiagnostic = { keep: true };
    const before = structuredClone(current), snapshot = structuredClone(bundle);
    const restored = restoreRecovery({ dataset, currentState: current, bundle });
    assert.equal(restored.artifacts.length, 2);
    assert.deepEqual(restored.outbox, [b.name, a.name]);
    assert.deepEqual(restored.retryNames, [b.name, a.name]);
    assert.equal(restored.view.notes.task, '2');
    assert.equal(restored.localDiagnostic.keep, true);
    equal(current, before); equal(bundle, snapshot);
    equal(restoreRecovery({ dataset, currentState: restored, bundle }), restored);
});

test('恢复输出可交给既有client重新核验并继续发送原outbox', async () => {
    const a = make(1), bundle = createRecovery({ dataset, state: state([a], [a]) });
    const restored = restoreRecovery({ dataset, bundle }), store = new MemoryStore(restored), transport = memoryTransport();
    const client = await openRecordLab({ dataset, store, transport });
    await client.sync();
    assert.equal(transport.files.size, 1);
    assert.equal((await transport.read(a.name)).equals(a.bytes), true);
    assert.deepEqual(client.state().outbox, []);
});

test('outbox缺原记录、错误数据集及固定原字节被篡改均拒绝', () => {
    const a = make(1), invalid = state([], [a]);
    assert.throws(() => createRecovery({ dataset, state: invalid }), /RECOVERY_OUTBOX_MISSING_RECORD/);
    const bundle = createRecovery({ dataset, state: state([a]) });
    const missing = structuredClone(bundle); missing.state.artifacts = []; missing.state.outbox = [a.name];
    assert.throws(() => restoreRecovery({ dataset, bundle: missing }), /RECOVERY_OUTBOX_MISSING_RECORD/);
    const other = createDataset({ datasetId: actorId, createdAt: '2026-11-05T00:00:00Z', data: { notes: {} } });
    assert.throws(() => restoreRecovery({ dataset: other, bundle }), /RECOVERY_DATASET_MISMATCH/);
    const corrupt = structuredClone(bundle); corrupt.dataset.baseline.base64 = Buffer.from('{}').toString('base64');
    assert.throws(() => restoreRecovery({ dataset, bundle: corrupt }), /INVALID_RECOVERY_DATASET/);
    const wrongCurrent = state(); wrongCurrent.pin = other.pin;
    assert.throws(() => restoreRecovery({ dataset, currentState: wrongCurrent, bundle }), /INVALID_RECOVERY_STATE/);
});

test('同ID异体在恢复并集中保留两份，冻结当前视图且不任意选胜者', () => {
    const a = make(1, [], '原文'), b = make(1, [], '异体');
    const bundle = createRecovery({ dataset, state: state([b], [b]) });
    const current = state([a], [a]); current.view = { notes: { lastPublished: '当前暂时结果' } };
    const restored = restoreRecovery({ dataset, currentState: current, bundle });
    assert.equal(restored.artifacts.length, 2);
    assert.equal(restored.outbox.length, 2);
    assert.equal(restored.blocked, true); assert.equal(restored.reason, 'FAULT');
    assert.ok(restored.faults.some(item => item.code === 'RECORD_ID_CONTENT_CONFLICT'));
    equal(restored.view, current.view);
    const abnormal = createRecovery({ dataset, state: restored });
    assert.equal(abnormal.frontier.status, 'FAULT');
    const cold = restoreRecovery({ dataset, bundle: abnormal });
    assert.equal(cold.artifacts.length, 2); assert.equal(cold.blocked, true);
    equal(cold.view, dataset.baseline.value.data);
});

test('未知操作与hash错误保存原字节和诊断，不误称健康完整恢复', () => {
    const a = make(1);
    for (const bad of [seal('record', { ...a.value, operations: [{ type: 'future.operation' }] }), { ...a, bytes: Buffer.from('{}') }]) {
        const bundle = createRecovery({ dataset, state: state([bad], [bad]) });
        assert.equal(bundle.frontier.status, 'FAULT');
        assert.ok(bundle.state.faults.some(item => item.name === bad.name && item.base64 === bad.bytes.toString('base64')));
        const restored = restoreRecovery({ dataset, bundle });
        assert.equal(restored.blocked, true);
        assert.equal(restored.artifacts[0].base64, bad.bytes.toString('base64'));
        assert.deepEqual(restored.outbox, [bad.name]);
        equal(restored.view, dataset.baseline.value.data);
    }
});

test('同路径不同字节均留证据，主状态槽位不被包覆盖', () => {
    const a = make(1), bad = { ...a, bytes: Buffer.from('{}') };
    const bundle = createRecovery({ dataset, state: state([bad]) });
    const restored = restoreRecovery({ dataset, currentState: state([a]), bundle });
    assert.equal(restored.blocked, true);
    assert.equal(restored.artifacts.length, 1);
    assert.equal(restored.artifacts[0].base64, a.bytes.toString('base64'));
    const evidence = restored.faults.filter(item => item.code === 'RECOVERY_PATH_CONTENT_CONFLICT').map(item => item.base64);
    assert.deepEqual(new Set(evidence), new Set([a.bytes.toString('base64'), bad.bytes.toString('base64')]));
});

test('缺父保持冻结和精确补读，后续恢复父记录后重新生成完整已知投影', () => {
    const a = make(1), b = make(2, [a]);
    const bundle = createRecovery({ dataset, state: state([b], [b]) });
    assert.equal(bundle.frontier.status, 'MISSING_DEPENDENCIES');
    const current = state(); current.view = { notes: { current: '当前视图' } };
    const pending = restoreRecovery({ dataset, currentState: current, bundle });
    assert.equal(pending.blocked, true); assert.deepEqual(pending.retryNames, [a.name]);
    equal(pending.view, current.view);
    const complete = restoreRecovery({ dataset, currentState: pending, bundle: createRecovery({ dataset, state: state([a]) }) });
    assert.equal(complete.blocked, false); assert.equal(complete.view.notes.task, '2');
    assert.equal(complete.artifacts.length, 2); assert.deepEqual(complete.outbox, [b.name]);
});

test('包的frontier须和已知证据匹配，不能用被改写的健康声明替代重验', () => {
    const a = make(1), bundle = createRecovery({ dataset, state: state([a]) });
    bundle.frontier.heads = [];
    assert.throws(() => restoreRecovery({ dataset, bundle }), /RECOVERY_FRONTIER_MISMATCH/);
});

test('包与恢复结果均不持有调用者可变数据引用，保留已有故障的全部诊断', () => {
    const a = make(1), original = state([a]);
    original.faults = [{ name: null, code: 'EXISTING_FAULT', detail: { keep: ['原诊断'] } }];
    const bundle = createRecovery({ dataset, state: original });
    original.artifacts[0].base64 = ''; original.faults[0].detail.keep[0] = '外部修改';
    assert.equal(bundle.state.artifacts[0].base64, a.bytes.toString('base64'));
    const restored = restoreRecovery({ dataset, bundle });
    bundle.state.faults[0].detail.keep[0] = '包被修改';
    assert.equal(restored.faults[0].detail.keep[0], '原诊断');
    assert.equal(restored.blocked, true);
});
