import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, unlink, readdir, rename } from 'node:fs/promises';
import { encode, decode } from '../codec.mjs';
import { FileStore, recoverStaleLease } from '../file-store.mjs';
import { createOwnedScratch, removeOwnedScratch, runDurabilityExperiments } from '../run-durability.mjs';

const same = (a, b) => assert.ok(encode(a).equals(encode(b)));
async function scratch(t) {
    const owner = await createOwnedScratch();
    t.after(() => removeOwnedScratch(owner));
    return owner.directory;
}
const original = () => ({ artifacts: [{ name: 'synthetic', base64: 'fixed-record' }], outbox: ['synthetic'], retryNames: [], note: '已提交' });

test('FileStore完整state与outbox原子保存，重开保持规范内容且返回副本', async t => {
    const directory = await scratch(t), first = new FileStore(directory);
    assert.equal(await first.load(), null);
    const state = original(), saving = first.save(state);
    state.note = '调用后改变';
    await saving;
    same(await first.load(), original());
    const copy = await first.load(); copy.outbox.length = 0;
    same(await first.load(), original());
    await first.close();
    const second = new FileStore(directory);
    try { same(await second.load(), original()); }
    finally { await second.close(); }
});

test('损坏JSON或checksum失败不能被load当成空，也不能被save覆盖', async t => {
    for (const corruption of ['invalid-json', 'checksum']) {
        const directory = join(await scratch(t), corruption), store = new FileStore(directory);
        try {
            await store.save(original());
            const path = join(directory, 'state.json'), current = decode(await readFile(path));
            const bad = corruption === 'invalid-json' ? Buffer.from('{broken') : encode({ ...current, state: { changed: true } });
            await writeFile(path, bad);
            await assert.rejects(store.load(), /STORE_STATE_CORRUPT/);
            await assert.rejects(store.save({ replacement: true }), /STORE_STATE_CORRUPT/);
            assert.ok((await readFile(path)).equals(bad));
        } finally { await store.close(); }
    }
});

test('已初始化state丢失时重开拒绝，不悄悄初始化空清单', async t => {
    const directory = await scratch(t), first = new FileStore(directory);
    await first.save(original()); await first.close();
    await unlink(join(directory, 'state.json'));
    const second = new FileStore(directory);
    try {
        await assert.rejects(second.load(), /STORE_STATE_MISSING/);
        await assert.rejects(second.save({ empty: true }), /STORE_STATE_MISSING/);
    } finally { await second.close(); }
});

test('同目录第二活动store拒绝，活PID的lease不能显式接管', async t => {
    const directory = await scratch(t), first = new FileStore(directory), second = new FileStore(directory);
    await first.save(original());
    const owner = first.leaseInfo();
    await assert.rejects(second.load(), /STORE_LEASE_ACTIVE_OR_UNKNOWN/);
    await assert.rejects(recoverStaleLease(directory, { expectedPid: owner.pid, expectedToken: owner.token }), /STORE_LEASE_ACTIVE_OR_UNKNOWN/);
    await assert.rejects(recoverStaleLease(directory, { expectedPid: owner.pid, expectedToken: 'wrong-token' }), /STORE_LEASE_OWNER_MISMATCH/);
    await second.close(); await first.close();
    const reopened = new FileStore(directory);
    try { same(await reopened.load(), original()); }
    finally { await reopened.close(); }
});

test('同实例并发close只释放一次lease，并等待在先的完整提交', async t => {
    const directory = await scratch(t), store = new FileStore(directory);
    const saving = store.save(original());
    const first = store.close(), second = store.close();
    assert.equal(first, second);
    await Promise.all([saving, first, second]);
    await store.close();
    await assert.rejects(store.load(), /STORE_CLOSED/);
    const reopened = new FileStore(directory);
    try { same(await reopened.load(), original()); }
    finally { await reopened.close(); }
});

for (const phase of ['before-write', 'tmp-fsynced', 'renamed']) test(`${phase}钩子抛错保留旧或新完整状态，不覆盖故障现场`, async t => {
    const directory = await scratch(t);
    let armed = false;
    const store = new FileStore(directory, { async onStage(event) { if (armed && event.stage === phase) { armed = false; throw new Error('SYNTHETIC_STAGE_FAILURE'); } } });
    try {
        await store.save(original());
        const next = { ...original(), artifacts: [...original().artifacts, { name: 'second', base64: 'second-fixed' }], outbox: ['synthetic', 'second'] };
        armed = true;
        await assert.rejects(store.save(next), /SYNTHETIC_STAGE_FAILURE/);
        same(await store.load(), phase === 'renamed' ? next : original());
        assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
    } finally { await store.close(); }
});

test('真实子进程exit与父进程kill覆盖三个原子提交阶段，旧记录与outbox无半截', async () => {
    const report = await runDurabilityExperiments();
    assert.equal(report.outcome, 'passed');
    assert.equal(report.powerLossTested, false);
    assert.equal(report.scenarios.length, 6);
    assert.ok(report.scenarios.every(item => item.actualChildProcess && item.previousCommittedRecordRetained && item.recordAndOutboxAtomic && item.fixedIntentRetryCreatesNoDuplicate));
    assert.ok(report.scenarios.filter(item => item.stage === 'tmp-fsynced').every(item => item.temporaryFilesAfterExit === 1));
    assert.equal(report.cleanup.removed, true);
});

test('临时rename占用只重试同一原子替换，成功前旧状态始终完整', async t => {
    const directory = await scratch(t);let armed=false,attempts=0;
    const store=new FileStore(directory,{async renameImpl(from,to){
        if(armed&&++attempts<3){same(decode(await readFile(to)).state,original());throw Object.assign(new Error('SYNTHETIC_BUSY'),{code:'EPERM'});}
        await rename(from,to);
    }});
    try{await store.save(original());armed=true;await store.save({...original(),note:'新提交'});assert.equal(attempts,3);assert.equal((await store.load()).note,'新提交');}
    finally{await store.close();}
});

test('rename持续失败时有限重试并保留旧主文件，不删除旧状态', async t => {
    const directory = await scratch(t);let armed=false,attempts=0;
    const store=new FileStore(directory,{async renameImpl(from,to){
        if(armed){attempts++;throw Object.assign(new Error('SYNTHETIC_DENIED'),{code:'EACCES'});}await rename(from,to);
    }});
    try{await store.save(original());const before=await readFile(join(directory,'state.json'));armed=true;
        await assert.rejects(store.save({...original(),note:'未提交'}),/SYNTHETIC_DENIED/);
        assert.equal(attempts,6);assert.deepEqual(await readFile(join(directory,'state.json')),before);same(await store.load(),original());
    }finally{await store.close();}
});
