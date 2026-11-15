import assert from 'node:assert/strict';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encode, hash } from './codec.mjs';
import { createDataset } from './envelope.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from './client.mjs';
import { openInitialization } from './initialization.mjs';
import { createRecovery, restoreRecovery } from './recovery.mjs';
import { NORMAL_TODO_PROFILE as profile, normalTodoOperation } from './normal-record-profile.mjs';

const fixedTime = '2026-11-07T02:00:00Z';
const id = value => `60000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const same = (a, b) => assert.deepEqual(encode(a), encode(b));

/** 只读取仓库内合成fixture，传输与存储均为内存替身。 */
export async function runNormalRecordExperiment() {
    const baseline = JSON.parse(await readFile(new URL('../../tests/fixtures/contract/current-personal.json', import.meta.url), 'utf8'));
    baseline.future = JSON.parse('{"__proto__":{"keep":true},"opaque":["固定快照扩展"]}');
    const source = structuredClone(baseline.todos[0]);
    const dataset = createDataset({ datasetId: id(1), createdAt: fixedTime, data: baseline, profile });
    const transport = memoryTransport(), storeA = new MemoryStore(), storeB = new MemoryStore();
    const initialized = await openInitialization({ dataset, store: new MemoryStore(), transport, profile });
    await initialized.publish(); same(await initialized.exposeInvite(), dataset.pin);
    let a = await openRecordLab({ dataset, store: storeA, transport, profile });
    const b = await openRecordLab({ dataset, store: storeB, transport, profile });
    const change = (number, actor, fields) => ({ id: id(number), actorId: id(actor), createdAt: fixedTime,
        operations: [normalTodoOperation(fields.deleted ? 'delete' : 'put', { ...source, updated_at: '2026-11-05T00:00:00Z', ...fields })] });
    await a.commit(change(10, 2, { content: 'z' }));
    await b.commit(change(11, 3, { content: 'aa' }));
    await a.sync(); await b.sync(); await a.sync();
    same(a.state().view, b.state().view);
    assert.equal(a.state().view.todos.find(t => t.id === source.id).content, 'aa');
    const earlier = createRecovery({ dataset, state: a.state(), profile });
    const deletion = change(12, 2, { content: 'aa', deleted: true, updated_at: '2026-11-05T00:01:00Z' });
    const fixed = await a.commit(deletion);
    assert.equal(a.state().outbox.length, 1);
    const restored = restoreRecovery({ dataset, currentState: a.state(), bundle: earlier, profile });
    assert.equal(restored.artifacts.length, 3);
    assert.equal(restored.outbox.length, 1);
    assert.equal(restored.view.todos.find(t => t.id === source.id).deleted, true);
    await storeA.save({ ...a.state(), view: { untrusted: '故意损坏的派生缓存' } });
    a = await openRecordLab({ dataset, store: storeA, transport, profile });
    same(await a.commit(deletion), fixed);
    assert.equal(a.state().view.todos.find(t => t.id === source.id).deleted, true);
    await a.sync(); await b.sync();
    const cold = await openRecordLab({ dataset, store: new MemoryStore(), transport, profile }); await cold.sync();
    same(a.state().view, cold.state().view);
    same(b.state().view, cold.state().view);
    for (const key of Object.keys(baseline).filter(key => !['todos', 'last_updated'].includes(key))) same(cold.state().view[key], baseline[key]);
    same(cold.state().view.todos.find(t => t.id === baseline.todos[1].id), baseline.todos[1]);
    const sources = ['operation-profile.mjs', 'normal-record-profile.mjs', 'normal-record-profile.schema.json', 'envelope.mjs', 'client.mjs',
        'initialization.mjs', 'recovery.mjs', 'codec.mjs', 'file-store.mjs', 'normal-durability-worker.mjs', 'run-normal-records.mjs',
        '../../windows/src/normalTodoConflict.js', '../../windows/src/stableJsonDigest.js', '../../windows/src/dataMerge.js',
        '../../windows/src/timeTracking.js', '../../windows/src/dateUtils.js', '../../windows/src/taskSeries.js',
        '../../tests/fixtures/contract/current-personal.json', '../../tests/fixtures/normal-todo/conflicts.json'];
    const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(new URL(path, import.meta.url)))])));
    return { outcome: 'passed', testedAt: new Date().toISOString(), operationSet: profile.id,
        scope: 'isolated-node-normal-todo-record-chain', storage: 'MemoryStore', transport: 'memory objects; no network',
        checks: ['fixed-baseline-and-descriptor', 'concurrent-normal-whole-record-tie', 'fixed-deletion-record-and-outbox',
            'old-recovery-union-keeps-new-deletion', 'discard-projection-cache-and-reopen', 'cold-rebuild-keeps-full-personal-extensions'],
        records: cold.state().artifacts.length, todoCount: cold.state().view.todos.length,
        baselineSha256: dataset.baseline.sha256, descriptorSha256: dataset.descriptor.sha256,
        projectionSha256: hash(encode(cold.state().view)), sourceHashes,
        limitations: ['新普通业务profile仅Node独立实现，未接入Windows/Android应用仓库',
            '此命令用内存传输，不是WebDAV或本地同步盘实测；真实进程退出另由test-normal-records-durable验证',
            '周期及其他集合仅透传，不能由此profile编辑；未完成完整操作目录、正式迁移、目标绑定或规模验收',
            '恢复只覆盖已知原始记录，不证明远端或离线设备没有遗漏；不清理记录或轮换快照'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length > 3) throw new Error('USE_OPTIONAL_NEW_REPORT_PATH');
    const file = process.argv[2] ? await open(resolve(process.argv[2]), 'wx') : null;
    try {
        const report = await runNormalRecordExperiment();
        if (file) await file.writeFile(JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks.length, records: report.records }));
    } finally { await file?.close(); }
}
