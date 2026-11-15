import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { encode } from '../codec.mjs';
import { createRecord } from '../envelope.mjs';
import { openRecordLab } from '../client.mjs';
import { FileStore, recoverStaleLease } from '../file-store.mjs';
import { createOwnedScratch, removeOwnedScratch } from '../run-durability.mjs';
import { fileObjectTransport, normalDurabilityFixture } from '../normal-durability-worker.mjs';
import { NORMAL_TODO_PROFILE as profile } from '../normal-record-profile.mjs';

async function interrupted(directory, stage) {
    const child = fork(fileURLToPath(new URL('../normal-durability-worker.mjs', import.meta.url)), [directory, stage],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '', closed = false, ready;
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
    const exited = new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
    });
    try {
        ready = await new Promise((resolveReady, reject) => {
            const timeout = setTimeout(() => reject(new Error('NORMAL_RECORD_STAGE_TIMEOUT')), 10000);
            child.once('message', message => { clearTimeout(timeout); resolveReady(message); });
            child.once('error', error => { clearTimeout(timeout); reject(error); });
            child.once('close', () => { clearTimeout(timeout); if (!ready) reject(new Error('NORMAL_RECORD_STAGE_MISSING')); });
        });
        assert.equal(ready.type, 'normal-record-stage');
        assert.equal(ready.stage, stage);
        assert.equal(ready.lease.pid, child.pid);
        assert.equal((await exited).code, 91);
        assert.equal(stderr, '');
        return ready.lease;
    } finally {
        if (!closed) { child.kill('SIGKILL'); await exited.catch(() => {}); }
    }
}

for (const stage of ['tmp-fsynced', 'renamed', 'before-upload', 'after-object-write']) {
    test(`普通任务实际进程退出 ${stage}：同一记录与删除状态可恢复`, async t => {
        const owner = await createOwnedScratch();
        t.after(() => removeOwnedScratch(owner));
        const lease = await interrupted(owner.directory, stage);
        const directory = join(owner.directory, 'store');
        await recoverStaleLease(directory, { expectedPid: lease.pid, expectedToken: lease.token });
        const store = new FileStore(directory), fixture = normalDurabilityFixture();
        try {
            const transport = fileObjectTransport(join(owner.directory, 'objects'));
            const client = await openRecordLab({ dataset: fixture.dataset, store, transport, profile });
            const committed = stage !== 'tmp-fsynced';
            assert.equal(client.state().artifacts.length, committed ? 1 : 0);
            assert.equal(client.state().view.todos[0].deleted, committed);
            assert.equal(client.state().outbox.length, committed ? 1 : 0);
            const expected = createRecord({ pin: fixture.dataset.pin, ...fixture.intent, profile });
            const retried = await client.commit(fixture.intent);
            assert.equal(retried.name, expected.name);
            assert.deepEqual(Buffer.from(retried.base64, 'base64'), expected.bytes);
            await client.sync();
            assert.equal(client.state().view.todos[0].deleted, true);
            assert.equal(client.state().artifacts.length, 1);
            assert.equal(client.state().outbox.length, 0);
            assert.deepEqual(await transport.read(expected.name), expected.bytes);
            assert.deepEqual(client.state().view.extension, ['原样保留']);
            assert.deepEqual(encode(client.state().view.todos[0].future), encode({ keep: true }));
            assert.equal((await transport.list()).length, 1);
        } finally { await store.close(); }
    });
}

test('退出worker自身拒绝非归属目录，不创建store或对象文件', async t => {
    const owner = await createOwnedScratch(); t.after(() => removeOwnedScratch(owner));
    const directory = join(owner.directory, 'unowned'); await mkdir(directory);
    await writeFile(join(directory, '.durability-owner.json'), encode({ kind: 'record-sync-durability-test/1', token: owner.token }));
    const child = fork(fileURLToPath(new URL('../normal-durability-worker.mjs', import.meta.url)), [directory, 'before-upload'],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
    assert.notEqual(code, 0);
    assert.match(stderr, /UNSAFE_NORMAL_DURABILITY_DIRECTORY/);
    assert.deepEqual(await readdir(directory), ['.durability-owner.json']);
});
