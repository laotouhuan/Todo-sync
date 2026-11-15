import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runConfiguredPreflight } from '../run-configured-webdav-preflight.mjs';
import { createDataset } from './envelope.mjs';
import { MemoryStore, openRecordLab } from './client.mjs';
import { openInitialization } from './initialization.mjs';
import { createWebDavTransport } from './webdav-transport.mjs';
import { CLOUD_PLANNING_OPERATION_SET, replayPersonalRecords } from '../../windows/src/recordReplay.js';
import { planningChange, weeklyPlanState } from '../../windows/src/weeklyPlanning.js';

const day = '2026-11-09';
const epoch = '1970-01-01T00:00:00Z';
const profile = {
    id: CLOUD_PLANNING_OPERATION_SET,
    validateBaseline(data) { replayPersonalRecords(data, [], CLOUD_PLANNING_OPERATION_SET); },
    validateOperation(operation) { assert.match(operation.type, /^planning\.(version\.(save|delete)|selection\.resolve|rating\.put)$/); },
    project(data, records) { return replayPersonalRecords(data, records, CLOUD_PLANNING_OPERATION_SET); }
};

async function verify(options) {
    const transport = createWebDavTransport(options);
    const dataset = createDataset({ datasetId: randomUUID(), createdAt: epoch,
        data: { version: 1, last_updated: epoch, todos: [] }, profile });
    const result = { outcome: 'failed', checks: [], operationSet: profile.id };
    let phase = 'initialization';
    try {
        const start = () => openInitialization({ dataset, store: new MemoryStore(), transport, profile });
        await Promise.all([(await start()).publish(), (await start()).publish()]);
        await transport.ensureRecords();
        result.checks.push(phase);
        phase = 'concurrent-plan-and-rating';
        const open = (t = transport, store = new MemoryStore()) => openRecordLab({ dataset, transport: t, store, profile });
        const local = new MemoryStore();
        const [left, right] = await Promise.all([open(transport, local), open()]);
        const actors = [randomUUID(), randomUUID()];
        async function edit(client, actorId, action, at) {
            const id = randomUUID();
            const operation = planningChange(client.state().view, action, { id, at });
            return client.commit({ id, actorId, createdAt: at, operations: [operation] });
        }
        for (const [index, client] of [left, right].entries()) {
            const stamp = day + 'T01:00:00.000Z';
            await edit(client, actors[index], { kind: 'save', week: day, versionId: randomUUID(), tips: [],
                days: ['合成计划 ' + index, '', '', '', '', '', ''], reason: '' }, stamp);
            await edit(client, actors[index], { kind: 'rate', date: day, score: 3 + index }, stamp);
        }
        await Promise.all([left.sync(), right.sync()]);
        await Promise.all([left.sync(), right.sync()]);
        assert.deepEqual(left.state().view, right.state().view);
        const plan = weeklyPlanState(left.state().view, day);
        assert.equal(plan.state, 'conflict');
        assert.equal(plan.candidates.length, 2);
        result.checks.push(phase);
        phase = 'lost-response-resume-and-cold-recovery';
        const at = day + 'T02:00:00.000Z';
        const cleared = await edit(left, actors[0], { kind: 'rate', date: day, score: null }, at);
        await edit(left, actors[0], { kind: 'resolve', week: day, versionId: plan.candidates[0].id, tips: plan.tips }, at);
        let discarded = 0;
        const loss = { ...transport, async write(name, raw) {
            await transport.write(name, raw, { conditionalCreate: true });
            if (name === cleared.name) { discarded++; throw new Error('LOST_RESPONSE'); }
        } };
        const first = await open(loss, local);
        assert.ok((await first.sync()).outbox.includes(cleared.name));
        const resumed = await open(loss, local);
        assert.deepEqual((await resumed.sync()).outbox, []);
        assert.equal(discarded, 1);
        const fresh = await open();
        await fresh.sync();
        assert.deepEqual(fresh.state().view, resumed.state().view);
        assert.equal(weeklyPlanState(fresh.state().view, day).current.id, plan.candidates[0].id);
        assert.equal(fresh.state().view.daily_ratings[0].score, null);
        result.checks.push(phase);
        result.outcome = 'passed';
    } catch (error) {
        result.failedStep = phase;
        result.error = error.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : (error.message.match(/^[A-Z0-9_]+$/)?.[0] ?? 'TEST_FAILED');
    } finally {
        result.cleanup = await transport.cleanup();
    }
    return result;
}

if (process.argv[2] !== '--execute' || !process.argv[3]) {
    console.log('用法：node tools/record-sync-protocol-lab/run-planning-live.mjs --execute 新报告路径.json');
    process.exitCode = 1;
} else {
    const report = await runConfiguredPreflight({ verify, reportPath: process.argv[3] });
    const cleanupConfirmed = report.cleanup?.removed && report.collectionCleanup.every(item => item.removed);
    console.log(JSON.stringify({ outcome: report.outcome, checks: report.checks, failedStep: report.failedStep,
        error: report.error, cleanupConfirmed }));
    process.exitCode = report.outcome === 'passed' && cleanupConfirmed ? 0 : 1;
}
