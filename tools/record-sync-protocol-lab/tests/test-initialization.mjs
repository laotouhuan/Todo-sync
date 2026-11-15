import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../codec.mjs';
import { createDataset } from '../envelope.mjs';
import { openInitialization, readPinnedDataset } from '../initialization.mjs';

const id = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const time = '2026-11-05T10:00:00+08:00';
const make = (number = 1, note = '固定初始文字') => createDataset({ datasetId: id(number), createdAt: time,
    data: { version: 1, todos: [], notes: { initial: note } } });
const copy = value => structuredClone(value);
const same = (actual, expected) => assert.ok(encode(actual).equals(encode(expected)));

// 仅内存事务替身和重新创建对象；这些检查不是实际进程kill或真实文件系统实验。
function store(initial = null, events = []) {
    let value = copy(initial), fault = null;
    const history = [];
    return {
        async load() { return copy(value); },
        async save(next) {
            events.push({ type: 'save', attempted: next.descriptor_publish_attempted, baseline: next.baseline_verified,
                descriptor: next.descriptor_verified, invite: next.invite_exposed });
            const fails = fault && fault.when(next);
            const current = fault;
            if (fails) fault = null;
            if (!fails || current.applied) { value = copy(next); history.push(copy(next)); }
            if (fails) throw new Error(current.applied ? 'SIMULATED_STOP_AFTER_SAVE' : 'SIMULATED_SAVE_FAILED');
        },
        setFault(settings) { fault = settings; },
        current: () => copy(value), history
    };
}

function remote(events = []) {
    const files = new Map(), calls = [];
    let fault = null;
    return {
        async read(name) {
            calls.push({ method: 'read', name }); events.push({ type: 'read', name });
            if (fault?.method === 'read' && fault.name === name) {
                const current = fault; fault = null;
                if (current.missing) return null;
                throw new Error('SYNTHETIC_READ_FAILURE');
            }
            return files.has(name) ? Buffer.from(files.get(name)) : null;
        },
        async write(name, bytes) {
            calls.push({ method: 'write', name, bytes: Buffer.from(bytes) }); events.push({ type: 'write', name });
            if (fault?.method === 'write' && fault.name === name) {
                const current = fault; fault = null;
                if (current.applied) files.set(name, Buffer.from(bytes));
                throw new Error('SYNTHETIC_WRITE_RESULT_UNKNOWN');
            }
            files.set(name, Buffer.from(bytes));
        },
        setFault(settings) { fault = settings; }, files, calls
    };
}

test('意图先落盘，baseline先发送读回，descriptor尝试证据在任何descriptor请求前落盘', async () => {
    const dataset = make(), events = [], local = store(null, events), transport = remote(events);
    const initialization = await openInitialization({ dataset, store: local, transport });
    assert.equal(transport.calls.length, 0);
    assert.equal(events[0].type, 'save');
    const result = await initialization.publish();
    assert.equal(result.status, 'descriptor-verified');
    assert.equal(Object.hasOwn(result, 'pin'), false);
    const firstDescriptorRequest = events.findIndex(event => event.name === dataset.descriptor.name);
    const attemptSaved = events.findIndex(event => event.type === 'save' && event.attempted);
    const baselineSaved = events.findIndex(event => event.type === 'save' && event.baseline);
    assert.ok(baselineSaved > 0 && baselineSaved < attemptSaved && attemptSaved < firstDescriptorRequest);
    assert.deepEqual(transport.calls.map(call => `${call.method}:${call.name}`), [
        `read:${dataset.baseline.name}`, `write:${dataset.baseline.name}`, `read:${dataset.baseline.name}`,
        `read:${dataset.descriptor.name}`, `write:${dataset.descriptor.name}`, `read:${dataset.descriptor.name}`
    ]);
    assert.equal(initialization.state().descriptor_publish_attempted, true);
    assert.equal(initialization.state().descriptor_verified, true);
    assert.equal(initialization.state().invite_exposed, false);
});

test('首次意图保存失败时不联网，也不能悄悄换成另一个意图', async () => {
    const dataset = make(), local = store(), transport = remote();
    local.setFault({ when: () => true, applied: false });
    await assert.rejects(openInitialization({ dataset, store: local, transport }), /SIMULATED_SAVE_FAILED/);
    assert.equal(transport.calls.length, 0);
    assert.equal(local.current(), null);
    await openInitialization({ dataset, store: local, transport });
    await assert.rejects(openInitialization({ dataset: make(2), store: local, transport }), /INITIALIZATION_INTENT_MISMATCH/);
    await assert.rejects(openInitialization({ dataset: make(1, '相同UUID但改正文'), store: local, transport }), /INITIALIZATION_INTENT_MISMATCH/);
    assert.equal(transport.calls.length, 0);
});

test('调用后修改输入artifact字节不改变已持久化固定意图', async () => {
    const dataset = make(), original = Buffer.from(dataset.baseline.bytes), local = store(), transport = remote();
    const pending = openInitialization({ dataset, store: local, transport });
    dataset.baseline.bytes.fill(0);
    dataset.pin.dataset_id = id(2);
    const initialization = await pending;
    await initialization.publish();
    const published = transport.calls.find(call => call.method === 'write' && call.name.startsWith('baseline.'));
    assert.ok(published.bytes.equals(original));
    assert.equal(initialization.state().fixed.pin.dataset_id, id(1));
});

for (const phase of ['baseline', 'attempt', 'descriptor', 'invite']) test(`实例重开模拟：${phase}落盘后返回丢失，恢复同一固定字节（非实际进程退出）`, async () => {
    const dataset = make(), local = store(), transport = remote();
    const initialization = await openInitialization({ dataset, store: local, transport });
    const when = {
        baseline: state => state.baseline_verified && !state.descriptor_publish_attempted,
        attempt: state => state.descriptor_publish_attempted && !state.descriptor_verified,
        descriptor: state => state.descriptor_verified && !state.invite_exposed,
        invite: state => state.invite_exposed
    }[phase];
    if (phase === 'invite') await initialization.publish();
    local.setFault({ when, applied: true });
    await assert.rejects(phase === 'invite' ? initialization.exposeInvite() : initialization.publish(), /SIMULATED_STOP_AFTER_SAVE/);
    const reopened = await openInitialization({ store: local, transport });
    await reopened.publish();
    same(await reopened.exposeInvite(), dataset.pin);
    assert.equal(transport.calls.filter(call => call.method === 'write' && call.name === dataset.baseline.name).length, 1);
    assert.equal(transport.calls.filter(call => call.method === 'write' && call.name === dataset.descriptor.name).length, 1);
    assert.ok(transport.files.get(dataset.baseline.name).equals(dataset.baseline.bytes));
    assert.ok(transport.files.get(dataset.descriptor.name).equals(dataset.descriptor.bytes));
    await assert.rejects(reopened.cancel({ quiescent: true }), /INITIALIZATION_UNSAFE_CANCEL/);
});

test('descriptor尝试标志保存失败时不读写descriptor；未尝试且静默确认后可取消', async () => {
    const dataset = make(), local = store(), transport = remote();
    const initialization = await openInitialization({ dataset, store: local, transport });
    local.setFault({ when: state => state.descriptor_publish_attempted, applied: false });
    await assert.rejects(initialization.publish(), /SIMULATED_SAVE_FAILED/);
    assert.equal(transport.calls.some(call => call.name === dataset.descriptor.name), false);
    assert.equal(local.current().descriptor_publish_attempted, false);
    const cancelled = await initialization.cancel({ quiescent: true });
    assert.equal(cancelled.remoteCleanupPerformed, false);
    assert.ok(transport.files.has(dataset.baseline.name));
    await assert.rejects(initialization.publish(), /INITIALIZATION_CANCELLED/);
});

test('descriptor尝试标志已保存但确认结果丢失时，旧实例取消也必须重新读标志并拒绝', async () => {
    const local = store(), transport = remote(), initialization = await openInitialization({ dataset: make(), store: local, transport });
    local.setFault({ when: state => state.descriptor_publish_attempted, applied: true });
    await assert.rejects(initialization.publish(), /SIMULATED_STOP_AFTER_SAVE/);
    assert.equal(initialization.state().descriptor_publish_attempted, false);
    await assert.rejects(initialization.cancel({ quiescent: true }), /INITIALIZATION_UNSAFE_CANCEL/);
    assert.equal(initialization.state().descriptor_publish_attempted, true);
});

for (const applied of [false, true]) test(`descriptor请求${applied ? '已应用但响应丢失' : '未到达'}后保留尝试证据，404不允许回退`, async () => {
    const dataset = make(), local = store(), transport = remote();
    const initialization = await openInitialization({ dataset, store: local, transport });
    transport.setFault({ method: 'write', name: dataset.descriptor.name, applied });
    await assert.rejects(initialization.publish(), /INITIALIZATION_WRITE_UNCONFIRMED/);
    assert.equal(local.current().descriptor_publish_attempted, true);
    assert.equal(local.current().descriptor_verified, false);
    const reopened = await openInitialization({ store: local, transport });
    transport.setFault({ method: 'read', name: dataset.descriptor.name, missing: true });
    await assert.rejects(reopened.cancel({ quiescent: true }), /INITIALIZATION_UNSAFE_CANCEL/);
    await reopened.publish();
    const writes = transport.calls.filter(call => call.method === 'write' && call.name === dataset.descriptor.name);
    assert.equal(writes.length, 2);
    assert.ok(writes.every(call => call.bytes.equals(dataset.descriptor.bytes)));
    same(await reopened.exposeInvite(), dataset.pin);
});

test('descriptor首次GET失败也保留尝试证据，不发送PUT、不允许自动取消', async () => {
    const dataset = make(), local = store(), transport = remote();
    const initialization = await openInitialization({ dataset, store: local, transport });
    transport.setFault({ method: 'read', name: dataset.descriptor.name });
    await assert.rejects(initialization.publish(), /INITIALIZATION_READ_UNCONFIRMED/);
    assert.equal(transport.calls.some(call => call.method === 'write' && call.name === dataset.descriptor.name), false);
    await assert.rejects(initialization.cancel({ quiescent: true }), /INITIALIZATION_UNSAFE_CANCEL/);
});

test('邀请证据保存失败不返回邀请；保存成功后返回固定pin且副本不可篡改内部状态', async () => {
    const dataset = make(), local = store(), transport = remote();
    const initialization = await openInitialization({ dataset, store: local, transport });
    await assert.rejects(initialization.exposeInvite(), /INITIALIZATION_NOT_PUBLISHED/);
    await initialization.publish();
    local.setFault({ when: state => state.invite_exposed, applied: false });
    await assert.rejects(initialization.exposeInvite(), /SIMULATED_SAVE_FAILED/);
    assert.equal(local.current().invite_exposed, false);
    const exposed = await initialization.exposeInvite();
    assert.equal(local.current().invite_exposed, true);
    same(exposed, dataset.pin);
    exposed.dataset_id = id(2);
    assert.equal(initialization.state().fixed.pin.dataset_id, id(1));
});

test('已有远端对象内容相同只核对不PUT，异内容停止且绝不覆盖', async () => {
    for (const conflict of [null, 'baseline', 'descriptor']) {
        const dataset = make(), local = store(), transport = remote();
        for (const kind of ['baseline', 'descriptor']) transport.files.set(dataset[kind].name,
            kind === conflict ? encode({ unrelated: true }) : Buffer.from(dataset[kind].bytes));
        const initialization = await openInitialization({ dataset, store: local, transport });
        if (conflict) await assert.rejects(initialization.publish(), /INITIALIZATION_REMOTE_CONFLICT/);
        else await initialization.publish();
        assert.equal(transport.calls.filter(call => call.method === 'write').length, 0);
    }
});

test('取消必须显式静默确认，取消不清理远端，也不能靠排队后篡改确认对象取消', async () => {
    const local = store(), transport = remote(), initialization = await openInitialization({ dataset: make(), store: local, transport });
    await assert.rejects(initialization.cancel(), /INITIALIZATION_UNSAFE_CANCEL/);
    const confirmation = { quiescent: false }, attempt = initialization.cancel(confirmation);
    confirmation.quiescent = true;
    await assert.rejects(attempt, /INITIALIZATION_UNSAFE_CANCEL/);
    await initialization.cancel({ quiescent: true });
    const reopened = await openInitialization({ store: local, transport });
    await assert.rejects(reopened.publish(), /INITIALIZATION_CANCELLED/);
    assert.equal(transport.calls.length, 0);
});

test('状态被外部回退或损坏时拒绝恢复，不把丢失的意图当新迁移', async () => {
    const dataset = make(), local = store(), transport = remote();
    const initialization = await openInitialization({ dataset, store: local, transport });
    const prepared = local.current();
    await initialization.publish();
    await local.save(prepared);
    await assert.rejects(initialization.cancel({ quiescent: true }), /INITIALIZATION_STATE_REGRESSION/);
    const bad = copy(prepared); bad.fixed.baseline.bytes_base64 = '';
    await local.save(bad);
    await assert.rejects(openInitialization({ store: local, transport }), /INVALID_INITIALIZATION/);
    await assert.rejects(openInitialization({ store: store(), transport }), /INITIALIZATION_DATASET_REQUIRED/);
});

test('加入固定pin只读取两个精确对象，核对descriptor和baseline身份，不列举或写入', async () => {
    const dataset = make(), transport = remote();
    transport.files.set(dataset.descriptor.name, Buffer.from(dataset.descriptor.bytes));
    transport.files.set(dataset.baseline.name, Buffer.from(dataset.baseline.bytes));
    const joined = await readPinnedDataset({ pin: dataset.pin, transport });
    same(joined.descriptor, decode(dataset.descriptor.bytes));
    same(joined.baseline, decode(dataset.baseline.bytes));
    assert.deepEqual(transport.calls.map(call => call.method), ['read', 'read']);
    await assert.rejects(readPinnedDataset({ pin: { ...dataset.pin, namespace: '../legacy/' }, transport }), /INVALID_INITIALIZATION_PIN/);
    await assert.rejects(readPinnedDataset({ pin: { ...dataset.pin, dataset_id: id(2), namespace: `record-sync/${id(2)}/` }, transport }), /INVALID_DATASET_BINDING/);
    transport.files.delete(dataset.baseline.name);
    await assert.rejects(readPinnedDataset({ pin: dataset.pin, transport }), /INITIALIZATION_JOIN_UNCONFIRMED/);
    assert.equal(transport.calls.some(call => call.method === 'write'), false);
});

test('同一实例publish和exposeInvite串行，不在发布确认前暴露pin', async () => {
    const local = store(), transport = remote(), initialization = await openInitialization({ dataset: make(), store: local, transport });
    const published = initialization.publish();
    const exposed = initialization.exposeInvite();
    await published;
    assert.equal((await exposed).dataset_id, id(1));
    assert.equal(local.current().descriptor_verified, true);
    assert.equal(local.current().invite_exposed, true);
});
