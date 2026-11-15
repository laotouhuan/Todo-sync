import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir, open, readFile, readdir, realpath, rm, lstat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encode, decode, hash } from './codec.mjs';
import { createRecord } from './envelope.mjs';
import { openRecordLab } from './client.mjs';
import { FileStore, recoverStaleLease } from './file-store.mjs';
import { makeDurabilityFixture } from './durability-worker.mjs';

const labDirectory = dirname(fileURLToPath(import.meta.url));
const prefix = '.scratch-durability-';
const markerName = '.durability-owner.json';
const same = (left, right) => encode(left).equals(encode(right));

export async function createOwnedScratch() {
    const root = await realpath(labDirectory), token = randomUUID();
    const directory = join(root, prefix + token);
    await mkdir(directory);
    const marker = await open(join(directory, markerName), 'wx');
    try { await marker.writeFile(encode({ kind: 'record-sync-durability-test/1', token })); await marker.sync(); }
    finally { await marker.close(); }
    return { directory, token };
}

export async function verifyOwnedScratch(owner) {
    const root = await realpath(labDirectory), requested = resolve(owner.directory), directory = await realpath(requested);
    const entry = await lstat(requested);
    if (!entry.isDirectory() || entry.isSymbolicLink() || directory !== requested || dirname(directory) !== root ||
        basename(directory) !== prefix + owner.token) throw new Error('UNSAFE_SCRATCH_DIRECTORY');
    const marker = decode(await readFile(join(directory, markerName)));
    if (marker.kind !== 'record-sync-durability-test/1' || marker.token !== owner.token) throw new Error('UNSAFE_SCRATCH_DIRECTORY');
    return directory;
}

export async function removeOwnedScratch(owner) {
    const directory = await verifyOwnedScratch(owner);
    // 只有绝对路径范围与本次独占标记都通过后，才删除本次合成测试目录。
    await rm(directory, { recursive: true, force: false });
}

async function interruptWorker(directory, stage, termination) {
    const child = fork(fileURLToPath(new URL('./durability-worker.mjs', import.meta.url)), [directory, stage, termination],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '', ready, closed = false;
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    try {
        ready = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('DURABILITY_STAGE_TIMEOUT')), 10000);
            child.on('message', message => {
                if (message?.type !== 'durability-stage') return;
                clearTimeout(timeout); resolve(message);
            });
            child.once('error', error => { clearTimeout(timeout); reject(error); });
            child.once('close', () => { clearTimeout(timeout); if (!ready) reject(new Error('DURABILITY_STAGE_NOT_REACHED')); });
        });
        assert.equal(ready.stage, stage);
        assert.equal(ready.termination, termination);
        assert.equal(ready.lease.pid, child.pid);
        assert.equal(ready.artifactCount, 2);
        assert.equal(ready.outboxCount, 2);
        if (termination === 'kill') assert.equal(child.kill('SIGKILL'), true);
        const stopped = await exited;
        if (termination === 'exit') assert.equal(stopped.code, 91);
        else assert.ok(stopped.signal !== null || stopped.code !== 0);
        assert.equal(stderr, '');
        return { ...stopped, lease: ready.lease, pid: child.pid };
    } finally {
        if (!closed) { child.kill('SIGKILL'); await exited.catch(() => {}); }
    }
}

async function oneScenario(root, stage, termination) {
    const directory = join(root, `${stage}-${termination}`), fixture = makeDurabilityFixture();
    const noNetwork = Object.fromEntries(['list', 'read', 'write'].map(method => [method, async () => { throw new Error('DURABILITY_TEST_NETWORK_FORBIDDEN'); }]));
    const initialStore = new FileStore(directory);
    let before;
    try {
        const initial = await openRecordLab({ dataset: fixture.dataset, store: initialStore, transport: noNetwork });
        await initial.commit(fixture.first);
        before = await initialStore.load();
    } finally { await initialStore.close(); }
    const stopped = await interruptWorker(directory, stage, termination);
    const temporaryFiles = (await readdir(directory)).filter(name => /^\.state-[0-9a-f-]+\.tmp$/.test(name)).length;
    await recoverStaleLease(directory, { expectedPid: stopped.pid, expectedToken: stopped.lease.token });
    const reopenedStore = new FileStore(directory);
    let recovered, afterRetry;
    try {
        recovered = await reopenedStore.load();
        const parent = { name: before.artifacts[0].name, bytes: Buffer.from(before.artifacts[0].base64, 'base64') };
        const expected = createRecord({ pin: fixture.dataset.pin, ...fixture.second, parents: [parent] });
        assert.ok(recovered.artifacts.some(item => same(item, before.artifacts[0])));
        assert.ok(recovered.outbox.includes(parent.name));
        assert.equal(recovered.artifacts.length, stage === 'renamed' ? 2 : 1);
        assert.equal(recovered.outbox.length, stage === 'renamed' ? 2 : 1);
        if (stage === 'renamed') {
            const candidate = recovered.artifacts.find(item => item.name === expected.name);
            assert.ok(candidate && Buffer.from(candidate.base64, 'base64').equals(expected.bytes));
            assert.ok(recovered.outbox.includes(expected.name));
        }
        const client = await openRecordLab({ dataset: fixture.dataset, store: reopenedStore, transport: noNetwork });
        const retried = await client.commit(fixture.second);
        assert.equal(retried.name, expected.name);
        assert.ok(Buffer.from(retried.base64, 'base64').equals(expected.bytes));
        afterRetry = await reopenedStore.load();
        assert.equal(afterRetry.artifacts.length, 2);
        assert.equal(afterRetry.outbox.length, 2);
        assert.ok(afterRetry.artifacts.some(item => same(item, before.artifacts[0])));
    } finally { await reopenedStore.close(); }
    const confirmedStore = new FileStore(directory);
    try { assert.ok(same(await confirmedStore.load(), afterRetry)); }
    finally { await confirmedStore.close(); }
    return { stage, termination, passed: true, actualChildProcess: true, exitCode: stopped.code, signal: stopped.signal,
        previousCommittedRecordRetained: true, recordAndOutboxAtomic: true, unacknowledgedCandidateVisibleAfterExit: stage === 'renamed',
        fixedIntentRetryCreatesNoDuplicate: true, temporaryFilesAfterExit: temporaryFiles,
        recoveredStateSha256: hash(encode(recovered)), finalStateSha256: hash(encode(afterRetry)) };
}

export async function runDurabilityExperiments() {
    const owner = await createOwnedScratch();
    const report = { testedAt: new Date().toISOString(), scope: 'isolated-local-file-store', outcome: 'inconclusive',
        evidence: 'real-child-process-exit-and-parent-termination', powerLossTested: false,
        concurrencyScope: 'one-active-store-and-one-explicit-stale-lease-recovery-coordinator', scenarios: [], cleanup: { removed: false } };
    try {
        for (const stage of ['before-write', 'tmp-fsynced', 'renamed']) for (const termination of ['exit', 'kill']) {
            report.scenarios.push(await oneScenario(owner.directory, stage, termination));
        }
        report.outcome = 'passed';
    } finally {
        await removeOwnedScratch(owner);
        report.cleanup.removed = true;
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    let output;
    try {
        if (process.argv[2]) output = await open(resolve(process.argv[2]), 'wx');
        const report = await runDurabilityExperiments();
        const text = JSON.stringify(report, null, 2) + '\n';
        if (output) { await output.writeFile(text, 'utf8'); await output.sync(); }
        process.stdout.write(text);
    } catch {
        process.stderr.write('隔离持久化验证未完成，或报告路径已经存在／不可写。\n');
        process.exitCode = 1;
    } finally { await output?.close(); }
}
