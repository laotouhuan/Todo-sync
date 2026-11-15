import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runConfiguredPreflight } from '../run-configured-webdav-preflight.mjs';
import { businessFixture } from './business-e2e-worker.mjs';
import { encode, hash } from './codec.mjs';
import { MemoryStore, openRecordLab } from './client.mjs';
import { COLLABORATION_CAUSAL_SERIES_PROFILE as profile } from './collaboration-record-profile.mjs';
import { createDataset } from './envelope.mjs';
import { FileStore } from './file-store.mjs';
import { openInitialization } from './initialization.mjs';
import { normalTodoOperation } from './normal-record-profile.mjs';
import { createWebDavTransport } from './webdav-transport.mjs';

const body = row => Buffer.from(row.base64, 'base64');

export async function verifyContentAddressedWebDav(options) {
    const transport = createWebDavTransport(options);
    const fixture = businessFixture();
    const dataset = createDataset({ datasetId: randomUUID(), createdAt: fixture.later,
        data: fixture.dataset.baseline.value.data, profile });
    const report = { testedAt: new Date().toISOString(), service: new URL(options.endpoint).origin,
        operationSet: profile.id, outcome: 'inconclusive', checks: [], faultInjection: ['lost-upload-response', 'changed-read-body'] };
    let currentCheck, scratch, store;
    const check = async (name, run) => {
        currentCheck = name;
        await run();
        report.checks.push({ name, passed: true });
    };
    const open = (override = transport, local = new MemoryStore()) => openRecordLab({ dataset, store: local, transport: override, profile });
    const reopen = async override => {
        await store?.close();
        store = new FileStore(scratch);
        return open(override, store);
    };
    try {
        await check('isolated-dataset-initialization', async () => {
            const initialization = await openInitialization({ dataset, store: new MemoryStore(), transport, profile });
            await initialization.publish();
            await transport.ensureRecords();
        });
        scratch = await mkdtemp(join(tmpdir(), 'todo-record-proof-'));
        const first = await open();
        const alternate = await open();
        const shared = { ...fixture.edit, id: randomUUID() };
        const a = await first.commit(shared);
        const b = await alternate.commit(shared);
        await check('identical-concurrent-create-final-bytes', async () => {
            assert.deepEqual(a, b);
            assert.equal(await transport.read(a.name), null);
            report.concurrentStatuses = await Promise.all([a, b].map(row => transport.write(row.name, body(row), { conditionalCreate: true })));
            assert.deepEqual(await transport.read(a.name), body(a));
            assert.deepEqual((await first.sync()).outbox, []);
        });
        let writes = 0;
        const lostResponse = { ...transport, async write(name, raw) {
            writes++;
            await transport.write(name, raw, { conditionalCreate: true });
            throw new Error('CLIENT_DISCARDED_RESPONSE');
        } };
        let pending;
        await check('lost-response-durable-reopen-confirms-original-bytes', async () => {
            const client = await reopen(lostResponse);
            await client.sync();
            const intent = { ...fixture.add, id: randomUUID() };
            pending = await client.commit(intent);
            assert.deepEqual((await client.sync()).outbox, [pending.name]);
            const restarted = await reopen(lostResponse);
            assert.deepEqual(await restarted.commit(intent), pending);
            assert.deepEqual((await restarted.sync()).outbox, []);
            assert.equal(writes, 1);
            assert.deepEqual(await transport.read(pending.name), body(pending));
        });
        await check('known-object-changed-read-preserves-evidence-and-pending-on-reopen', async () => {
            const client = await reopen(transport);
            const waiting = await client.commit({ ...fixture.edit, id: randomUUID() });
            const previous = client.state();
            const corrupt = encode({ deliberatelyChanged: '隔离测试合成字节' });
            const altered = { ...transport, async read(name) {
                const actual = await transport.read(name);
                return name === pending.name && actual !== null ? corrupt : actual;
            } };
            const observing = await reopen(altered);
            assert.equal((await observing.sync()).reason, 'FAULT');
            const restarted = await reopen(transport);
            const after = restarted.state();
            assert.equal(after.reason, 'FAULT');
            assert.deepEqual(after.outbox, [waiting.name]);
            assert.deepEqual(after.artifacts, previous.artifacts);
            assert.deepEqual(encode(after.view), encode(previous.view));
            const fault = after.faults.find(item => item.name === pending.name);
            assert.equal(fault?.base64, corrupt.toString('base64'));
            assert.equal(await transport.read(waiting.name), null);
            report.changedReadEvidence = { name: pending.name, code: fault.code, observedBase64: fault.base64,
                expectedSha256: hash(body(pending)), queuedName: waiting.name };
        });
        await check('same-id-different-bytes-use-distinct-paths-and-freeze-both-clients', async () => {
            const [left, right] = await Promise.all([open(), open()]);
            const id = randomUUID();
            const todo = fixture.dataset.baseline.value.data.todos[0];
            const intents = ['合成内容甲', '合成内容乙'].map(content => ({ ...fixture.edit, id,
                operations: [normalTodoOperation('put', { ...todo, content, updated_at: fixture.later })] }));
            const records = await Promise.all([left.commit(intents[0]), right.commit(intents[1])]);
            assert.notEqual(records[0].name, records[1].name);
            const statuses = await Promise.all(records.map(row => transport.write(row.name, body(row), { conditionalCreate: true })));
            for (const row of records) assert.deepEqual(await transport.read(row.name), body(row));
            for (const client of [left, right]) {
                assert.equal((await client.sync()).reason, 'FAULT');
                const state = client.state();
                assert.ok(state.faults.some(item => item.code === 'RECORD_ID_CONTENT_CONFLICT'));
                for (const row of records) assert.ok(state.artifacts.some(item => item.name === row.name && item.base64 === row.base64));
            }
            report.identityConflict = { statuses, records };
        });
        report.outcome = 'passed';
    } catch (error) {
        report.checks.push({ name: currentCheck ?? 'setup', passed: false,
            code: error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'SCENARIO_FAILED' });
    } finally {
        try {
            await store?.close();
            if (scratch) {
                for (const name of ['state.json', 'store.identity.json']) {
                    await unlink(join(scratch, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
                }
                await rmdir(scratch);
            }
            report.localCleanup = true;
        } catch {
            report.localCleanup = false;
        }
        report.cleanup = await transport.cleanup();
        report.requests = transport.requests;
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv[2] !== '--execute' || !process.argv[3]) {
        console.log('用法：node tools/record-sync-protocol-lab/run-content-addressed-live.mjs --execute 新报告路径.json');
    } else {
        try {
            const report = await runConfiguredPreflight({ verify: verifyContentAddressedWebDav, reportPath: process.argv[3] });
            const cleanupConfirmed = report.localCleanup && report.cleanup.removed && report.collectionCleanup.every(item => item.removed);
            console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks,
                concurrentStatuses: report.concurrentStatuses, cleanupConfirmed }, null, 2));
            process.exitCode = report.outcome === 'passed' && cleanupConfirmed ? 0 : 1;
        } catch {
            console.error('专项验收未运行。配置、凭据或报告路径不可用。');
            process.exitCode = 1;
        }
    }
}
