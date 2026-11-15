import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { encode, decode } from '../codec.mjs';
import { openRecordLab } from '../client.mjs';
import { FileStore, recoverStaleLease } from '../file-store.mjs';
import { createOwnedScratch, removeOwnedScratch } from '../run-durability.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { fileObjectTransport } from '../normal-durability-worker.mjs';
import { businessFixture, openFixtureCollaborator } from '../business-e2e-worker.mjs';
import { COLLABORATION_RECORD_PROFILE as profile } from '../collaboration-record-profile.mjs';
import { deleteSeriesWorkflow } from '../series-workflow-profile.mjs';
import { deletePreview } from '../../../windows/src/taskSeries.js';

const same = (a, b) => assert.deepEqual(encode(a), encode(b));

async function runUntilExit(owner, stage) {
    const child = fork(fileURLToPath(new URL('../business-e2e-worker.mjs', import.meta.url)),
        [owner.directory, owner.token, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let message, stderr = '', closed = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('message', value => { message = value; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => { closed = true; resolve(code); });
    });
    let timeout;
    try {
        const code = await Promise.race([exited, new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('BUSINESS_WORKER_TIMEOUT')), 15000);
        })]);
        assert.equal(code, 91, stderr);
        assert.equal(stderr, '');
        assert.equal(message?.stage, stage);
        assert.equal(message.lease.pid, child.pid);
        return message;
    } finally {
        clearTimeout(timeout);
        if (!closed) { child.kill('SIGKILL'); await exited.catch(() => {}); }
    }
}

for (const stage of ['before-upload', 'after-object-write']) {
    test(`业务端到端 ${stage}：协作新增、销卡、系列删除和计时从实盘及空缓存恢复`, async () => {
        const owned = await createOwnedScratch();
        const storePath = name => join(owned.directory, name);
        const fixture = businessFixture();
        const transport = fileObjectTransport(storePath('objects'));
        const ownerStore = new FileStore(storePath('owner'));
        const coldStore = new FileStore(storePath('cold'));
        const recoveryStore = new FileStore(storePath('restored'));
        let collabStore;
        try {
            const openOwner = (store, io = transport) => openRecordLab({ dataset: fixture.dataset, store, transport: io, profile });
            const a = await openOwner(ownerStore);
            const edit = await a.commit(fixture.edit);
            const deleteOp = deleteSeriesWorkflow(deletePreview(a.state().view, fixture.member.id, true), fixture.later);
            const deleted = await a.commit({ ...fixture.edit, id: fixture.deleteRecordId, operations: [deleteOp] });
            assert.equal((await transport.list()).length, 0);

            const { lease, submitted } = await runUntilExit(owned, stage);
            assert.deepEqual(await transport.read(submitted.name),
                stage === 'after-object-write' ? Buffer.from(submitted.base64, 'base64') : null);
            await recoverStaleLease(storePath('collaborator'), { expectedPid: lease.pid, expectedToken: lease.token });
            collabStore = new FileStore(storePath('collaborator'));
            const b = await openFixtureCollaborator(fixture, collabStore, transport);
            assert.deepEqual((await collabStore.load()).state.outbox, [submitted.name]);
            same(await b.append(fixture.binding, fixture.add), submitted);

            await a.sync();
            const bReport = await b.sync();
            assert.deepEqual(bReport.outbox, []);
            assert.deepEqual(await transport.read(submitted.name), Buffer.from(submitted.base64, 'base64'));
            await a.sync();
            assert.deepEqual((await transport.list()).sort(), [edit.name, deleted.name, submitted.name].sort());

            let incomplete = true;
            const delayed = {
                ...transport,
                async list() {
                    return incomplete ? [deleted.name, submitted.name, deleted.name] :
                        (await transport.list()).reverse().flatMap(name => [name, name]);
                },
                async read(name) {
                    return incomplete && [edit.name, submitted.name].includes(name) ? null : transport.read(name);
                }
            };
            const cold = await openOwner(coldStore, delayed);
            const first = await cold.sync();
            assert.equal(first.reason, 'MISSING_DEPENDENCIES');
            assert.ok(first.readFailures.includes(edit.name));
            assert.ok(first.readFailures.includes(submitted.name));
            assert.equal(cold.state().view.task_series[0].deleted, false);
            incomplete = false;
            assert.equal((await cold.sync()).blocked, false);

            const result = a.state().view;
            same(b.view(), result);
            same(cold.state().view, result);
            assert.equal(result.todos[0].content, '所有者离线修改');
            assert.deepEqual(result.todos[1].completed_dates, []);
            assert.equal(result.todos[1].completed, false);
            assert.equal(result.todos[2].deleted, true);
            assert.equal(result.todos[3].task_type, 'monthly_checkin');
            assert.equal(result.todos[3].subtasks[0].content, '初始子任务');
            assert.equal(result.todos[3].reminder, null);
            assert.equal(result.task_series[0].deleted, true);
            assert.equal(result.time_entries[0].ended_at, fixture.later);
            same(result.future, { keep: ['原值'] });

            const bundle = createRecovery({ dataset: fixture.dataset, state: cold.state(), profile });
            const path = storePath('recovery.json');
            await writeFile(path, encode(bundle), { flag: 'wx' });
            const recovered = restoreRecovery({ dataset: fixture.dataset, bundle: decode(await readFile(path)), profile });
            await recoveryStore.save(recovered);
            const restored = await openOwner(recoveryStore);
            same(restored.state().view, result);
            assert.equal(restored.state().artifacts.length, 3);
        } finally {
            await Promise.all([ownerStore.close(), coldStore.close(), recoveryStore.close(), collabStore?.close()]);
            await removeOwnedScratch(owned);
        }
    });
}
