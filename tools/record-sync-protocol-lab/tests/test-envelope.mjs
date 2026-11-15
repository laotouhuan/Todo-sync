import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataset, createRecord, seal, verifyRecord, validateJoin, validatePin, inspect } from '../envelope.mjs';
import { encode } from '../codec.mjs';

const dataset = createDataset({ datasetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-11-05T00:00:00Z', data: { notes: {}, extension: { keep: true } } });
const actorA = '11111111-1111-4111-8111-111111111111', actorB = '22222222-2222-4222-8222-222222222222';
const make = (number, parents = [], actorId = actorA, value = String(number)) => createRecord({ pin: dataset.pin, actorId,
    id: `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`, createdAt: '2026-11-05T00:00:00Z', parents, operations: [{ type: 'lab.note.set', key: 'test', value }] });
test('描述符最后固定共同基线；加入不依赖最新索引', () => {
    const joined = validateJoin(dataset.pin, dataset.descriptor.bytes, dataset.baseline.bytes);
    assert.equal(joined.baseline.data.extension.keep, true);
    assert.equal(dataset.baseline.name, `baseline.${dataset.pin.baseline_sha256}.json`);
    assert.equal(dataset.descriptor.name, `dataset.${dataset.pin.descriptor_sha256}.json`);
});
test('错误邀请、基线、描述符及原型数据不被自动接受', () => {
    const wrong = { ...dataset.pin, dataset_id: actorA, namespace: `record-sync/${actorA}/` };
    assert.throws(() => validateJoin(wrong, dataset.descriptor.bytes, dataset.baseline.bytes), /INVALID_DATASET_BINDING/);
    assert.throws(() => validateJoin(dataset.pin, dataset.descriptor.bytes, encode({})), /DATASET_HASH_MISMATCH/);
    assert.throws(() => validateJoin({ ...dataset.pin, descriptor_sha256: '0'.repeat(64) }, dataset.descriptor.bytes, dataset.baseline.bytes), /DATASET_HASH_MISMATCH/);
    const old = seal('record', { protocol: 1, id: make(1).value.id });
    assert.throws(() => verifyRecord(dataset.pin, old.name, old.bytes), /INVALID_RECORD_ENVELOPE/);
});
test('同 ID 两份正文同时首次创建得到不同文件且拒绝任意裁决', () => {
    const first = make(1), second = make(1, [], actorB, 'other');
    assert.notEqual(first.name, second.name);
    const remote = new Map([[first.name, first.bytes], [second.name, second.bytes]]);
    assert.equal(remote.size, 2);
    for (const order of [[first, second], [second, first]]) assert.throws(() => inspect(dataset.pin, order), /RECORD_ID_CONTENT_CONFLICT/);
});
test('缺父按精确哈希引用补齐，不按枚举顺序应用', () => {
    const parent = make(1), child = make(2, [parent]);
    const missing = inspect(dataset.pin, [child]);
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.missing.map(p => `${p.id}.${p.sha256}`), [parent.name.slice(8, -5)]);
    const result = inspect(dataset.pin, [child, parent, child]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.ordered.map(r => r.id), [parent.value.id, child.value.id]);
    assert.equal(result.heads[0].id, child.value.id);
});
test('有同 ID 错误父哈希时保留故障，不能按 ID 匹配', () => {
    const parent = make(1), child = make(2, [parent]);
    const bad = seal('record', { ...child.value, parents: [{ id: parent.value.id, sha256: '0'.repeat(64) }] });
    assert.throws(() => inspect(dataset.pin, [bad, parent]), /PARENT_HASH_CONFLICT/);
});
test('依赖齐全后检查精确 Lamport，根时钟也不能伪造', () => {
    const parent = make(1), child = make(2, [parent]);
    const bad = seal('record', { ...child.value, lamport: 99 });
    assert.equal(inspect(dataset.pin, [bad]).complete, false);
    assert.throws(() => inspect(dataset.pin, [bad, parent]), /INVALID_LAMPORT/);
    const root = seal('record', { ...parent.value, lamport: 2 });
    assert.throws(() => inspect(dataset.pin, [root]), /INVALID_LAMPORT/);
});
test('父引用有序唯一、自引用拒绝、安全整数时钟', () => {
    const one = make(1), two = make(2), child = make(3, [two, one]);
    assert.equal(child.value.parents[0].id, one.value.id);
    for (const changes of [{ parents: [...child.value.parents].reverse() }, { parents: [child.value.parents[0], child.value.parents[0]] },
        { parents: [{ id: child.value.id, sha256: one.sha256 }] }, { lamport: 2 ** 53 }]) {
        const bad = seal('record', { ...child.value, ...changes });
        assert.throws(() => verifyRecord(dataset.pin, bad.name, bad.bytes));
    }
});
test('哈希、文件名、协议绑定及未知操作异常不能静默略过', () => {
    const record = make(1);
    assert.throws(() => verifyRecord(dataset.pin, '../' + record.name, record.bytes), /RECORD_FILENAME_HASH_MISMATCH/);
    assert.throws(() => verifyRecord(dataset.pin, record.name, Buffer.from(record.bytes.toString().replace('test', 'oops'))), /RECORD_FILENAME_HASH_MISMATCH/);
    for (const changes of [{ descriptor_sha256: '0'.repeat(64) }, { actor_id: actorA.toUpperCase().replace('1111', 'ABCD') },
        { extra: true }, { created_at: '2026-02-30T00:00:00Z' }, { created_at: '2026-11-05T24:00:00Z' }, { operations: [{ type: 'todo.add', todo: {} }] }]) {
        const bad = seal('record', { ...record.value, ...changes });
        assert.throws(() => inspect(dataset.pin, [bad]));
    }
});
test('所有排列、重复与分批最终给出同一顺序，时区不参与裁决', () => {
    const a = make(1), b = make(2, [], actorB), c = make(3, [a, b]);
    const expected = encode(inspect(dataset.pin, [a, b, c]));
    for (const order of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) {
        for (let n=0;n<order.length;n++) inspect(dataset.pin, order.slice(0,n));
        assert.deepEqual(encode(inspect(dataset.pin, [...order, ...order])), expected);
    }
});
test('UUID和hash字段必须是字符串，不能由数组或对象隐式转换', () => {
    const a = make(1), b = make(2, [a]);
    for (const value of [[actorA], {}, 123, true, null]) {
        const bad = seal('record', { ...a.value, actor_id: value });
        assert.throws(() => verifyRecord(dataset.pin, bad.name, bad.bytes), /INVALID_RECORD_ENVELOPE/);
        const parent = seal('record', { ...b.value, parents: [{ id: value, sha256: a.sha256 }] });
        assert.throws(() => verifyRecord(dataset.pin, parent.name, parent.bytes), /INVALID_PARENT_REFERENCE/);
    }
    for (const changes of [{ dataset_id: [dataset.pin.dataset_id] }, { descriptor_sha256: [dataset.pin.descriptor_sha256] }, { baseline_sha256: [dataset.pin.baseline_sha256] }]) {
        assert.throws(() => validatePin({ ...dataset.pin, ...changes }), /INVALID_DATASET_PIN/);
    }
    const badHash = seal('record', { ...b.value, parents: [{ id: a.value.id, sha256: [a.sha256] }] });
    assert.throws(() => verifyRecord(dataset.pin, badHash.name, badHash.bytes), /INVALID_PARENT_REFERENCE/);
    assert.throws(() => verifyRecord(dataset.pin, [a.name], a.bytes), /RECORD_FILENAME_HASH_MISMATCH/);
    let called = false;
    assert.throws(() => createDataset({ datasetId: { toString() { called = true; return actorA; } }, createdAt: '2026-11-05T00:00:00Z', data: {} }));
    assert.equal(called, false);
});
test('12000条依赖深链正序逆序结果一致，不依赖递归调用栈', () => {
    const records = [];
    for (let n = 1; n <= 12000; n++) {
        const previous = records.at(-1);
        records.push(seal('record', { protocol: 'todo-record-sync/1', dataset_id: dataset.pin.dataset_id, descriptor_sha256: dataset.pin.descriptor_sha256,
            id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, actor_id: actorA, created_at: '2026-11-05T00:00:00Z',
            parents: previous ? [{ id: previous.value.id, sha256: previous.sha256 }] : [], lamport: n,
            operations: [{ type: 'lab.note.set', key: 'deep', value: String(n) }] }));
    }
    const forward = inspect(dataset.pin, records), reverse = inspect(dataset.pin, [...records].reverse());
    assert.equal(reverse.complete, true);
    assert.equal(reverse.ordered.length, 12000);
    assert.deepEqual(reverse.ordered.map(r => r.id), forward.ordered.map(r => r.id));
    assert.deepEqual(reverse.heads, forward.heads);
});
