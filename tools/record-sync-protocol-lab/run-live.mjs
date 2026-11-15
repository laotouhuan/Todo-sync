import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runConfiguredPreflight } from '../run-configured-webdav-preflight.mjs';
import { encode, decode, hash } from './codec.mjs';
import { createDataset, validateJoin } from './envelope.mjs';
import { openInitialization, readPinnedDataset } from './initialization.mjs';
import { MemoryStore, openRecordLab } from './client.mjs';
import { createWebDavTransport } from './webdav-transport.mjs';

/** 仅合成lab.note.set；HTTP真实发送，故障由客户端主动丢响应／延迟发现注入。 */
export async function verifyRecordSyncProtocolLab(options) {
    const transport = createWebDavTransport(options);
    const dataset = createDataset({ datasetId: 'f1234567-1234-4234-8234-123456789abc', createdAt: '2026-11-05T00:00:00Z',
        data: { notes: {}, preserved_extension: { value: '仅合成隔离数据' } } });
    const report = { testedAt: new Date().toISOString(), service: new URL(options.endpoint).origin,
        targetPath: new URL(options.directory + '/', options.endpoint).pathname, outcome: 'inconclusive',
        protocol: 'todo-record-sync/1', operationSet: 'lab-note/1', storage: 'memory-atomic-interface', checks: [],
        faultInjection: 'client-side-response-discard-and-directory-omission-over-http',
        limitations: ['only-synthetic-lab-note-operations', 'no-plan-or-production-business-integration',
            'memory-store-instance-reopen-not-process-kill', 'global-directory-completeness-not-assumed',
            'conforming-writers-only-not-malicious-writer-defense', 'no-formal-migration-or-local-folder-acceptance'] };
    let runningCheck;
    async function check(name, run) { runningCheck = name; await run(); report.checks.push({ name, passed: true }); }
    try {
        const initializationStore = new MemoryStore();
        let descriptorWrites = 0;
        const initializing = { ...transport, async write(name, bytes) {
            await transport.write(name, bytes);
            if (name.startsWith('dataset.') && ++descriptorWrites === 1) throw new Error('CLIENT_DISCARDED_RESPONSE');
        } };
        let initializer = await openInitialization({ dataset, store: initializationStore, transport: initializing });
        await check('baseline-before-descriptor-response-loss-keeps-publication-evidence', async () => {
            await assert.rejects(initializer.publish(), /INITIALIZATION_WRITE_UNCONFIRMED/);
            assert.equal(initializer.state().baseline_verified, true);
            assert.equal(initializer.state().descriptor_publish_attempted, true);
            assert.equal(transport.tracked.size, 2);
            assert.deepEqual([...transport.tracked.keys()].map(name => name.split('.')[0]), ['baseline', 'dataset']);
        });
        await check('initializer-reopen-reads-back-without-descriptor-rewrite', async () => {
            initializer = await openInitialization({ store: initializationStore, transport: initializing });
            await assert.rejects(initializer.cancel({ quiescent: true }), /INITIALIZATION_UNSAFE_CANCEL/);
            await initializer.publish();
            assert.equal(descriptorWrites, 1);
        });
        await check('invite-pin-is-persisted-before-read-only-exact-join', async () => {
            const pin = await initializer.exposeInvite();
            assert.equal(initializer.state().invite_exposed, true);
            const joined = await readPinnedDataset({ pin, transport });
            assert.equal(joined.baseline.data.preserved_extension.value, '仅合成隔离数据');
        });
        await transport.ensureRecords();
        const actorA = '11111111-1111-4111-8111-111111111111', actorB = '22222222-2222-4222-8222-222222222222';
        const intent = (n, actorId, key, value) => ({ id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            actorId, createdAt: '2026-11-05T00:00:00Z', operations: [{ type: 'lab.note.set', key, value }] });
        let bRecordWrites = 0;
        const bTransport = { ...transport, async write(name, bytes) {
            await transport.write(name, bytes);
            if (name.startsWith('records/') && ++bRecordWrites === 1) throw new Error('CLIENT_DISCARDED_RESPONSE');
        } };
        const storeA = new MemoryStore(), storeB = new MemoryStore();
        let a = await openRecordLab({ dataset, store: storeA, transport });
        let b = await openRecordLab({ dataset, store: storeB, transport: bTransport });
        await check('two-independent-clients-upload-concurrent-distinct-record-files', async () => {
            await a.commit(intent(1, actorA, 'A', '离线A'));
            await b.commit(intent(2, actorB, 'B', '离线B'));
            await Promise.all([a.sync(), b.sync()]);
            assert.equal(b.state().outbox.length, 1);
            assert.equal([...transport.tracked.keys()].filter(name => name.startsWith('records/')).length, 2);
        });
        await check('record-response-loss-reopen-confirms-original-bytes-without-rewrite', async () => {
            b = await openRecordLab({ dataset, store: storeB, transport: bTransport });
            await b.sync(); await a.sync(); await b.sync();
            assert.equal(bRecordWrites, 1);
            assert.equal(b.state().outbox.length, 0);
            assert.deepEqual(encode(a.state().view), encode(b.state().view));
            assert.deepEqual({ ...a.state().view.notes }, { A: '离线A', B: '离线B' });
        });
        await a.commit(intent(3, actorA, 'A', '后继A')); await a.sync();
        const child = a.state().artifacts.find(item => decode(Buffer.from(item.base64, 'base64')).id.endsWith('000000000003'));
        const childValue = decode(Buffer.from(child.base64, 'base64'));
        const parent = `records/${childValue.parents[0].id}.${childValue.parents[0].sha256}.json`;
        let unavailable = true, omitAll = false;
        const hidden = { ...transport, async list() { await transport.list(); return omitAll ? [] : [child.name, child.name]; },
            async read(name) { const bytes = await transport.read(name); return unavailable && name === parent ? null : bytes; } };
        const storeC = new MemoryStore();
        let c = await openRecordLab({ dataset, store: storeC, transport: hidden });
        await check('directory-omission-and-parent-delay-preserve-exact-hash-reference', async () => {
            await c.sync();
            assert.equal(c.state().blocked, true);
            assert.ok(c.state().retryNames.includes(parent));
            assert.equal(c.state().view.notes.A, undefined);
        });
        await check('reopen-with-empty-list-retries-exact-parent-and-converges', async () => {
            unavailable = false; omitAll = true;
            c = await openRecordLab({ dataset, store: storeC, transport: hidden }); await c.sync();
            assert.equal(c.state().blocked, false);
            assert.deepEqual(encode(c.state().view), encode(a.state().view));
        });
        await check('cold-client-recovers-from-explicit-pin-and-remote-artifacts', async () => {
            const pin = await initializer.exposeInvite();
            const descriptor = await transport.read(`dataset.${pin.descriptor_sha256}.json`);
            const baseline = await transport.read(`baseline.${pin.baseline_sha256}.json`);
            validateJoin(pin, descriptor, baseline);
            const coldDataset = { pin, descriptor: { bytes: descriptor }, baseline: { bytes: baseline } };
            const cold = await openRecordLab({ dataset: coldDataset, store: new MemoryStore(), transport }); await cold.sync();
            assert.equal(cold.state().blocked, false);
            assert.deepEqual(encode(cold.state().view), encode(a.state().view));
            report.finalProjectionSha256 = hash(encode(cold.state().view));
            report.recordFiles = cold.state().artifacts.length;
        });
        report.outcome = 'passed';
    } catch {
        report.checks.push({ name: runningCheck || 'scenario-completed', passed: false, outcome: 'inconclusive' });
    } finally {
        report.cleanup = await transport.cleanup();
        report.requests = [...transport.requests];
        report.trackedArtifactCount = transport.tracked.size;
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv[2] !== '--execute' || !process.argv[3]) {
        console.log('用法：node tools/record-sync-protocol-lab/run-live.mjs --execute 尚不存在的报告路径.json');
    } else {
        try {
            const report = await runConfiguredPreflight({ verify: verifyRecordSyncProtocolLab, reportPath: process.argv[3] });
            console.log(JSON.stringify({ outcome: report.outcome, protocol: report.protocol, operationSet: report.operationSet,
                checks: report.checks, recordFiles: report.recordFiles, finalProjectionSha256: report.finalProjectionSha256,
                cleanup: report.cleanup, collectionCleanup: report.collectionCleanup }, null, 2));
            process.exitCode = report.outcome === 'passed' && report.cleanup.removed && report.collectionCleanup.every(item => item.removed) ? 0 : 1;
        } catch {
            console.error('隔离协议实验未完成：配置、网络或报告不可用。未输出凭据或底层错误正文。');
            process.exitCode = 1;
        }
    }
}
