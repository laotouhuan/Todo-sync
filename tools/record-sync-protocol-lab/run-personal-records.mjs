import assert from 'node:assert/strict';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encode, hash } from './codec.mjs';
import { createDataset } from './envelope.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from './client.mjs';
import { createRecovery, restoreRecovery } from './recovery.mjs';
import { normalTodoOperation } from './normal-record-profile.mjs';
import { PERSONAL_CORE_PROFILE as profile, reminderSettingsOperation } from './personal-record-profile.mjs';

const time = '2026-11-07T02:00:00Z';
const id = value => `80000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const same = (a, b) => assert.deepEqual(encode(a), encode(b));

/** 合成个人数据及内存传输；不读取应用配置、凭据或真实待办。 */
export async function runPersonalRecordExperiment() {
    const baseline = JSON.parse(await readFile(new URL('../../tests/fixtures/contract/current-personal.json', import.meta.url), 'utf8'));
    baseline.reminder_settings.future = { keep: true };
    baseline.reminder_settings.global_rules[0].extension = ['原规则扩展'];
    const dataset = createDataset({ datasetId: id(1), createdAt: time, data: baseline, profile });
    const transport = memoryTransport(), storeA = new MemoryStore();
    let a = await openRecordLab({ dataset, store: storeA, transport, profile });
    const b = await openRecordLab({ dataset, store: new MemoryStore(), transport, profile });
    const change = (number, actor, enabled, content) => ({ id: id(number), actorId: id(actor), createdAt: time, operations: [
        normalTodoOperation('put', { ...baseline.todos[0], content, updated_at: time }),
        reminderSettingsOperation({ ...baseline.reminder_settings, enabled, updated_at: time })
    ] });
    await a.commit(change(10, 2, true, 'z'));
    await b.commit(change(11, 3, false, 'aa'));
    await a.sync(); await b.sync(); await a.sync();
    same(a.state().view, b.state().view);
    assert.equal(a.state().view.reminder_settings.enabled, true);
    assert.equal(a.state().view.todos.find(todo => todo.id === baseline.todos[0].id).content, 'aa');
    same(a.state().view.reminder_settings.global_rules[0].extension, ['原规则扩展']);
    const older = createRecovery({ dataset, state: a.state(), profile });
    const clear = { id: id(12), actorId: id(2), createdAt: '2026-11-07T02:01:00Z', operations: [
        reminderSettingsOperation({ ...baseline.reminder_settings, enabled: false, global_rules: [], updated_at: '2026-11-07T02:01:00Z' })
    ] };
    const fixed = await a.commit(clear);
    const restored = restoreRecovery({ dataset, currentState: a.state(), bundle: older, profile });
    assert.equal(restored.artifacts.length, 3);
    assert.equal(restored.outbox.length, 1);
    assert.equal(restored.view.reminder_settings.enabled, false);
    same(restored.view.reminder_settings.global_rules, []);
    await storeA.save({ ...a.state(), view: { reminder_settings: { enabled: true }, todos: [] } });
    a = await openRecordLab({ dataset, store: storeA, transport, profile });
    same(await a.commit(clear), fixed);
    await a.sync(); await b.sync();
    const cold = await openRecordLab({ dataset, store: new MemoryStore(), transport, profile }); await cold.sync();
    same(a.state().view, cold.state().view); same(b.state().view, cold.state().view);
    same(cold.state().view.reminder_settings.future, { keep: true });
    for (const key of Object.keys(baseline).filter(key => !['todos', 'reminder_settings', 'last_updated'].includes(key))) same(cold.state().view[key], baseline[key]);
    const sources = ['personal-record-profile.mjs', 'personal-record-profile.schema.json', 'normal-record-profile.mjs',
        'normal-record-profile.schema.json', 'operation-profile.mjs',
        'envelope.mjs', 'client.mjs', 'initialization.mjs', 'recovery.mjs', 'codec.mjs', 'run-personal-records.mjs',
        '../../windows/src/reminderSettingsConflict.js', '../../windows/src/normalTodoConflict.js', '../../windows/src/stableJsonDigest.js',
        '../../windows/src/dataMerge.js', '../../windows/src/timeTracking.js', '../../windows/src/dateUtils.js', '../../windows/src/taskSeries.js',
        '../../todo_data.schema.json', '../../tests/fixtures/contract/current-personal.json', '../../tests/fixtures/reminder-settings/conflicts.json'];
    const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(new URL(path, import.meta.url)))])));
    return { outcome: 'passed', testedAt: new Date().toISOString(), operationSet: profile.id,
        scope: 'isolated-node-normal-todo-and-reminder-record-chain', storage: 'MemoryStore', transport: 'memory objects; no network',
        checks: ['atomic-mixed-domain-commits', 'same-clock-reminder-on-and-normal-aa-independent-winners',
            'newer-disable-and-explicit-empty-rules', 'old-recovery-union-preserves-new-clear', 'fixed-retry-after-cache-discard',
            'cold-rebuild-and-opaque-personal-data-preserved'], records: cold.state().artifacts.length,
        descriptorSha256: dataset.descriptor.sha256, baselineSha256: dataset.baseline.sha256,
        projectionSha256: hash(encode(cold.state().view)), sourceHashes,
        limitations: ['本命令仅Node独立业务集合，不是双端应用记录同步接入', '内存演练，不是HTTP或真实同步盘验收',
            '原生仓库、其余业务操作、迁移与规模尚未验收；旧normal集合不自动升级解释', '完整仅指本次已知日志，不证明远端没有遗漏记录'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length > 3) throw new Error('USE_OPTIONAL_NEW_REPORT_PATH');
    const file = process.argv[2] ? await open(resolve(process.argv[2]), 'wx') : null;
    try {
        const report = await runPersonalRecordExperiment();
        if (file) await file.writeFile(JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks.length, records: report.records }));
    } finally { await file?.close(); }
}
