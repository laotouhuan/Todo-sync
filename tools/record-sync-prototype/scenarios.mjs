import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, project, snapshotHash } from './protocol.mjs';
import { openClient, FileStore } from './client.mjs';

export const snapshot = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
export const actorA = '11111111-1111-4111-8111-111111111111';
export const actorB = '22222222-2222-4222-8222-222222222222';
const root = dirname(fileURLToPath(import.meta.url));
const time = '2026-11-05T08:00:00.000Z';
const week = '2026-11-02';
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export const newTodo = (id, content) => ({ ...structuredClone(snapshot.data.todos[0]), id, content });
export async function createScratch() { return mkdtemp(join(root, '.scratch-prototype-')); }
export async function removeScratch(directory) {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), root);
    assert.ok(basename(absolute).startsWith('.scratch-prototype-'));
    await rm(absolute, { recursive: true, force: true });
}

// 子进程故障实验使用独立文件夹模拟远端；不是应用的本地文件夹同步实现。
export function fileTransport(directory) {
    const target = id => {
        assert.match(id, /^[0-9a-f-]{36}$/i);
        return join(directory, `${id}.json`);
    };
    return {
        async list() { await mkdir(directory, { recursive: true }); return (await readdir(directory)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(name => name.slice(0, -5)); },
        async read(id) { try { return JSON.parse(await readFile(target(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
        async write(id, record) { await mkdir(directory, { recursive: true }); await writeFile(target(id), canonical(record), 'utf8'); }
    };
}

function permutations(items) {
    return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest])) : [[]];
}

/** 相同预置数据驱动两个客户端，故障注入只改变可见性及响应，不改变变更正文。 */
export async function runScenario({ transport, directory, mode = 'simulation', onRecord = () => {}, onCheck = () => {} }) {
    const checks = [];
    const recordSet = new Map();
    const check = (name, condition, details = {}) => {
        assert.ok(condition, name);
        const result = { name, passed: true, ...details };
        checks.push(result); onCheck(result);
    };
    const commit = async (client, actor, operations) => {
        const record = await client.commit({ id: randomUUID(), actor_id: actor, created_at: time, operations });
        recordSet.set(record.id, record); onRecord(record);
        return record;
    };
    const open = (name, adapter = transport) => openClient({ snapshot, store: new FileStore(join(directory, name)), transport: adapter });
    const originalVersion = snapshot.data.weekly_plan_versions[0].id;
    const originalSelection = snapshot.data.weekly_plan_selections[0].id;
    const baseTodo = snapshot.data.todos[0].id;
    const taskA = randomUUID(), taskB = randomUUID(), versionA = randomUUID(), versionB = randomUUID();
    const selectionA = randomUUID(), selectionB = randomUUID();
    const plan = (id, selectionId, content) => [
        { type: 'plan.version.add', version: { id, week_start: week, base_version_id: originalVersion,
            days: [content, '', '', '', '', '', ''], change_reason: '预置模拟修订' } },
        { type: 'plan.selection.add', selection: { id: selectionId, week_start: week, version_id: id,
            parent_selection_ids: [originalSelection], kind: 'save' } }
    ];
    let a = await open('client-a');
    let b = await open('client-b');
    const first = await commit(a, actorA, [
        { type: 'todo.add', todo: newTodo(taskA, '设备 A 新增') },
        { type: 'todo.patch', todo_id: baseTodo, fields: { content: 'A 并发改名' } },
        { type: 'rating.set', id: randomUUID(), date: week, score: 4 },
        ...plan(versionA, selectionA, 'A 周一安排')
    ]);
    const second = await commit(b, actorB, [
        { type: 'todo.add', todo: newTodo(taskB, '模拟协作者 B 新增') },
        { type: 'todo.patch', todo_id: baseTodo, fields: { content: 'B 并发改名' } },
        { type: 'review.set', id: randomUUID(), date: week, fact: 'B 修改复盘', obstacle: '', effective_action: '', next_step: '' },
        ...plan(versionB, selectionB, 'B 周一安排')
    ]);
    check('local-persist-before-network', (await transport.list()).length === 0 && a.pendingUploads().includes(first.id));
    a = await open('client-a');
    check('restart-preserves-frozen-record', canonical(a.records()[0]) === canonical(first));
    await a.sync();
    let lost = false, blockedRead = null;
    const responseLoss = {
        list: () => transport.list(),
        async read(id) { if (id === blockedRead) throw new Error('INJECTED_READ_NOT_AVAILABLE'); return transport.read(id); },
        async write(id, record) {
            await transport.write(id, record);
            if (!lost) { lost = true; blockedRead = id; throw new Error('INJECTED_UPLOAD_RESPONSE_LOST'); }
        }
    };
    b = await open('client-b', responseLoss);
    await b.sync();
    check('upload-response-lost-keeps-durable-intent', lost && b.pendingUploads().includes(second.id));
    const fixedSecond = canonical(second);
    b = await open('client-b');
    await b.sync(); await a.sync();
    check('restart-confirms-existing-record', canonical(b.records().find(record => record.id === second.id)) === fixedSecond && b.pendingUploads().length === 0);
    check('concurrent-records-preserved', a.records().length === 2 && canonical(a.view()) === canonical(b.view()));
    check('equal-time-normal-todo-converges', a.view().data.todos.find(todo => todo.id === baseTodo).content === 'B 并发改名');
    check('rating-review-isolation', a.view().data.daily_ratings[0].score === 4 && a.view().data.daily_reviews[0].fact === 'B 修改复盘');
    check('plan-divergence-visible', a.view().weekStates[week].status === 'conflict');

    const resolvedA = randomUUID(), resolvedB = randomUUID();
    const resolution = (id, version) => ({ type: 'plan.selection.add', selection: { id, week_start: week, version_id: version,
        parent_selection_ids: [selectionA, selectionB].sort(), kind: 'resolve' } });
    const third = await commit(a, actorA, [resolution(resolvedA, versionA),
        { type: 'plan.version.delete', version_id: versionB }, { type: 'todo.delete', todo_id: taskA },
        { type: 'rating.set', id: randomUUID(), date: week, score: null }]);
    // B 尚未读到 A 的删除，保存其合法离线选择与字段修改。
    await commit(b, actorB, [resolution(resolvedB, versionB),
        { type: 'todo.patch', todo_id: taskA, fields: { content: '离线修改不能复活任务' } }]);
    await a.sync();

    let listing = [third.id, third.id], failThird = true;
    const delayedDiscovery = {
        async list() { return listing === null ? [...(await transport.list())].reverse().flatMap(id => [id, id]) : [...listing]; },
        async read(id) { if (id === third.id && failThird) { failThird = false; throw new Error('INJECTED_LISTED_READ_FAILURE'); } return transport.read(id); },
        write: (id, record) => transport.write(id, record)
    };
    const c = await open('client-c', delayedDiscovery);
    const failedRead = await c.sync();
    check('listed-record-read-failure-retained', failedRead.readFailures.some(item => item.id === third.id));
    listing = [];
    await c.sync();
    check('retry-survives-next-listing-omission', c.records().some(record => record.id === third.id));
    check('missing-parent-record-buffered', c.view().pendingIds.includes(third.id) && c.view().appliedIds.length === 0);
    listing = [second.id, first.id, second.id];
    await c.sync();
    check('dependency-backfill-applies-retained-record', c.view().pendingIds.length === 0 && c.view().data.daily_ratings[0].score === null);
    await b.sync(); await a.sync();
    listing = null; await c.sync();
    check('offline-update-does-not-revive-deleted-todo', a.view().data.todos.find(todo => todo.id === taskA).deleted === true);
    check('deleted-plan-candidate-needs-review', a.view().weekStates[week].status === 'needs-review');
    check('duplicates-and-reordered-listings-converge', canonical(c.view()) === canonical(a.view()) && canonical(b.view()) === canonical(a.view()));
    const finalSelection = randomUUID();
    await commit(a, actorA, [{ type: 'plan.selection.add', selection: { id: finalSelection, week_start: week,
        version_id: versionA, parent_selection_ids: a.view().weekStates[week].candidateSelectionIds, kind: 'resolve' } }]);
    await a.sync(); await b.sync(); await c.sync();
    const expected = a.view();
    check('final-selection-preserves-history-and-deletion', expected.weekStates[week].currentVersionId === versionA &&
        expected.data.weekly_plan_versions.length === 3 && expected.data.weekly_plan_versions.find(version => version.id === versionB).deleted);
    check('final-three-client-convergence', canonical(expected) === canonical(b.view()) && canonical(expected) === canonical(c.view()));
    check('fixture-extension-preserved', expected.data.prototype_extension.preserved === true);
    const records = [...recordSet.values()];
    const allOrders = permutations(records);
    for (const order of allOrders) assert.equal(canonical(project(snapshot, order.flatMap(record => [record, record]))), canonical(expected));
    check('all-replay-orders-converge', allOrders.length === 120, { permutations: allOrders.length });

    const derived = join(directory, 'client-a', 'todo_data.json');
    await writeFile(derived, canonical({ todos: [], untrusted: '派生结果不能变成来源' }), 'utf8');
    const restarted = await open('client-a');
    check('derived-result-not-reimported', canonical(restarted.view()) === canonical(expected) && restarted.records().length === 5);
    for (const name of ['client-a', 'client-b', 'client-c']) {
        const cache = resolve(directory, name);
        assert.equal(dirname(cache), resolve(directory));
        await rm(cache, { recursive: true, force: true });
    }
    const cold = await open('cold-client'); await cold.sync();
    check('cold-recovery-only-snapshot-and-remote-records', canonical(cold.view()) === canonical(expected) && cold.records().length === 5);
    check('cold-recovery-includes-tombstones-and-current-selection', cold.view().data.todos.find(todo => todo.id === taskA).deleted &&
        cold.view().data.weekly_plan_versions.find(version => version.id === versionB).deleted && cold.view().weekStates[week].currentVersionId === versionA);
    return { mode, dataset_id: snapshot.dataset_id, snapshot_hash: snapshotHash(snapshot), recordCount: records.length,
        recordIds: records.map(record => record.id).sort(), projectionHash: digest(expected), checks,
        outcome: 'passed', scope: 'prototype-only', globalDiscoveryCompleteness: 'not-assumed' };
}

/** 真实子进程在持久提交前后退出；不依赖仍在内存中的父进程状态。 */
export async function runProcessCrashScenarios(directory) {
    const checks = [];
    for (const phase of ['before-send', 'after-upload-before-ack']) {
        const stateDirectory = join(directory, phase, 'client');
        const remoteDirectory = join(directory, phase, 'remote');
        const id = randomUUID();
        const child = spawnSync(process.execPath, [join(root, 'crash-worker.mjs'), phase, stateDirectory, remoteDirectory, id],
            { windowsHide: true, encoding: 'utf8', timeout: 20000 });
        assert.equal(child.status, 0, `${phase}: child did not reach exit point`);
        const store = new FileStore(stateDirectory);
        const persisted = await store.load();
        assert.ok(persisted.pendingIds.includes(id));
        const frozen = canonical(persisted.records.find(record => record.id === id));
        const remote = fileTransport(remoteDirectory);
        assert.equal((await remote.list()).length, phase === 'before-send' ? 0 : 1);
        const client = await openClient({ snapshot, store, transport: remote });
        await client.sync();
        assert.equal(canonical(client.records().find(record => record.id === id)), frozen);
        assert.equal(client.pendingUploads().length, 0);
        assert.deepEqual(await remote.list(), [id]);
        checks.push({ name: phase, passed: true, execution: 'actual-child-process-exit', recordIdentityAndContentPreserved: true });
    }
    return checks;
}
