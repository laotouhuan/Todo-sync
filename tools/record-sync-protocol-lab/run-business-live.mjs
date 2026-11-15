import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runConfiguredPreflight } from '../run-configured-webdav-preflight.mjs';
import { encode, hash } from './codec.mjs';
import { MemoryStore, openRecordLab } from './client.mjs';
import { openInitialization } from './initialization.mjs';
import { businessFixture, openFixtureCollaborator } from './business-e2e-worker.mjs';
import { COLLABORATION_RECORD_PROFILE as profile } from './collaboration-record-profile.mjs';
import { deleteSeriesWorkflow } from './series-workflow-profile.mjs';
import { createWebDavTransport } from './webdav-transport.mjs';
import { deletePreview } from '../../windows/src/taskSeries.js';

export async function verifyBusinessWebDav(options) {
    const transport = createWebDavTransport(options);
    const fixture = businessFixture();
    const report = { testedAt: new Date().toISOString(), service: new URL(options.endpoint).origin,
        operationSet: profile.id, outcome: 'inconclusive', storage: 'memory-store-instance-reopen',
        faultInjection: 'client-discarded-write-ack-and-filtered-discovery', checks: [] };
    let currentCheck;
    async function check(name, run) {
        currentCheck = name;
        await run();
        report.checks.push({ name, passed: true });
    }
    try {
        let dataset;
        await check('initialize-and-join-by-exact-remote-pin', async () => {
            const initializer = await openInitialization({ dataset: fixture.dataset, store: new MemoryStore(), transport, profile });
            await initializer.publish();
            const pin = await initializer.exposeInvite();
            dataset = { pin, descriptor: { bytes: await transport.read(fixture.dataset.descriptor.name) },
                baseline: { bytes: await transport.read(fixture.dataset.baseline.name) } };
            assert.deepEqual(dataset.descriptor.bytes, fixture.dataset.descriptor.bytes);
            assert.deepEqual(dataset.baseline.bytes, fixture.dataset.baseline.bytes);
            await transport.ensureRecords();
        });
        const a = await openRecordLab({ dataset, store: new MemoryStore(), transport, profile });
        const bStore = new MemoryStore();
        let writes = 0;
        const bTransport = { ...transport, async write(name, bytes) {
            writes++;
            await transport.write(name, bytes);
            throw new Error('CLIENT_DISCARDED_RESPONSE');
        } };
        const b = await openFixtureCollaborator({ ...fixture, dataset }, bStore, bTransport);
        let edit, deletion, added;
        await check('independent-offline-business-records-publish-to-different-objects', async () => {
            edit = await a.commit(fixture.edit);
            const operation = deleteSeriesWorkflow(deletePreview(a.state().view, fixture.member.id, true), fixture.later);
            deletion = await a.commit({ ...fixture.edit, id: fixture.deleteRecordId, operations: [operation] });
            added = await b.append(fixture.binding, fixture.add);
            const [, result] = await Promise.all([a.sync(), b.sync()]);
            assert.deepEqual(result.outbox, [added.name]);
            assert.equal(writes, 1);
            assert.deepEqual((await transport.list()).sort(), [edit.name, deletion.name, added.name].sort());
        });
        let reopened;
        await check('reopen-recovers-original-collaboration-upload-without-second-put', async () => {
            reopened = await openFixtureCollaborator({ ...fixture, dataset }, bStore, bTransport);
            assert.deepEqual(await reopened.append(fixture.binding, fixture.add), added);
            assert.deepEqual((await reopened.sync()).outbox, []);
            assert.equal(writes, 1);
            assert.deepEqual(await transport.read(added.name), Buffer.from(added.base64, 'base64'));
        });
        let incomplete = true;
        const filtered = { ...transport, async list() {
            const names = await transport.list();
            return incomplete ? [deletion.name, added.name, deletion.name].filter(name => names.includes(name)) :
                names.reverse().flatMap(name => [name, name]);
        }, async read(name) {
            const bytes = await transport.read(name);
            return incomplete && [edit.name, added.name].includes(name) ? null : bytes;
        } };
        const cold = await openRecordLab({ dataset, store: new MemoryStore(), transport: filtered, profile });
        await check('cold-client-holds-view-through-omission-and-read-failure', async () => {
            const result = await cold.sync();
            assert.equal(result.reason, 'MISSING_DEPENDENCIES');
            assert.ok(result.readFailures.includes(edit.name));
            assert.ok(result.readFailures.includes(added.name));
            assert.equal(cold.state().view.task_series[0].deleted, false);
        });
        await check('full-discovery-reconstructs-the-same-business-result', async () => {
            incomplete = false;
            await a.sync();
            assert.equal((await cold.sync()).blocked, false);
            const result = a.state().view;
            assert.deepEqual(encode(result), encode(reopened.view()));
            assert.deepEqual(encode(result), encode(cold.state().view));
            assert.equal(result.todos[0].content, '所有者离线修改');
            assert.deepEqual(result.todos[1].completed_dates, []);
            assert.equal(result.todos[1].completed, false);
            assert.equal(result.todos[2].deleted, true);
            assert.equal(result.todos[3].task_type, 'monthly_checkin');
            assert.equal(result.todos[3].subtasks.length, 1);
            assert.equal(result.todos[3].reminder, null);
            assert.equal(result.task_series[0].deleted, true);
            assert.equal(result.time_entries[0].ended_at, fixture.later);
            assert.deepEqual(result.future, { keep: ['原值'] });
            report.finalProjectionSha256 = hash(encode(result));
            report.recordFiles = cold.state().artifacts.length;
        });
        report.outcome = 'passed';
    } catch {
        report.checks.push({ name: currentCheck ?? 'scenario-initialization', passed: false });
    } finally {
        report.cleanup = await transport.cleanup();
        report.requests = [...transport.requests];
        report.trackedArtifactCount = transport.tracked.size;
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv[2] !== '--execute' || !process.argv[3]) {
        console.log('用法：node tools/record-sync-protocol-lab/run-business-live.mjs --execute 尚不存在的报告路径.json');
    } else {
        try {
            const report = await runConfiguredPreflight({ verify: verifyBusinessWebDav, reportPath: process.argv[3] });
            const removed = report.cleanup.removed && report.collectionCleanup.every(item => item.removed);
            console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks, recordFiles: report.recordFiles,
                requests: report.requests?.length, cleanupConfirmed: removed, setup: report.setup }, null, 2));
            process.exitCode = report.outcome === 'passed' && removed ? 0 : 1;
        } catch {
            console.error('隔离业务实验未完成：配置、网络或报告不可用。');
            process.exitCode = 1;
        }
    }
}
