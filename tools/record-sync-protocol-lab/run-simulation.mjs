import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { encode, decode, hash } from './codec.mjs';
import { createDataset, createRecord, inspect, seal } from './envelope.mjs';
import { openInitialization, readPinnedDataset } from './initialization.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from './client.mjs';

// 所有传输和存储均为内存替身；只输出合成数据与状态，不读取应用配置。
export async function runSimulation() {
    const checks = [];
    async function check(name, run) { await run(); checks.push({ name, passed: true }); }
    const dataset = createDataset({ datasetId: 'f1234567-1234-4234-8234-123456789abc', createdAt: '2026-11-05T00:00:00Z',
        data: { notes: {}, preserved_extension: { value: '仅合成数据' } } });
    const vectors = JSON.parse(await readFile(new URL('./vectors.json', import.meta.url), 'utf8'));
    await check('RFC数值样本编码及规范字节读回', () => {
        for (const [hex, expected] of vectors.numbers) {
            assert.equal(encode(Buffer.from(hex, 'hex').readDoubleBE()).toString(), expected);
            assert.equal(encode(decode(Buffer.from(expected))).toString(), expected);
        }
    });
    const remote = memoryTransport(), initStore = new MemoryStore();
    const write = remote.write; let descriptorWrites = 0;
    remote.write = async (name, bytes) => {
        await write(name, bytes);
        if (name.startsWith('dataset.') && ++descriptorWrites === 1) throw new Error('SIMULATED_RESPONSE_LOSS');
    };
    let initializer = await openInitialization({ dataset, store: initStore, transport: remote });
    await check('descriptor已写但响应丢失前已有持久尝试证据', async () => {
        await assert.rejects(initializer.publish(), /INITIALIZATION_WRITE_UNCONFIRMED/);
        assert.equal((await initStore.load()).descriptor_publish_attempted, true);
        assert.equal(remote.files.size, 2);
    });
    await check('实例重开不能触发旧协议回退，重读确认不重复写', async () => {
        initializer = await openInitialization({ store: initStore, transport: remote });
        await assert.rejects(initializer.cancel({ quiescent: true }), /INITIALIZATION_UNSAFE_CANCEL/);
        await initializer.publish();
        assert.equal(descriptorWrites, 1);
    });
    await check('邀请暴露先保存证据，加入只读固定对象', async () => {
        const pin = await initializer.exposeInvite();
        assert.equal((await initStore.load()).invite_exposed, true);
        const joined = await readPinnedDataset({ pin, transport: remote });
        assert.equal(joined.baseline.data.preserved_extension.value, '仅合成数据');
    });
    const actorA = '11111111-1111-4111-8111-111111111111', actorB = '22222222-2222-4222-8222-222222222222';
    const intent = (n, actorId, key, value) => ({ id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        actorId, createdAt: '2026-11-05T00:00:00Z', operations: [{ type: 'lab.note.set', key, value }] });
    const storeA = new MemoryStore(), storeB = new MemoryStore();
    const open = (store, transport = remote) => openRecordLab({ dataset, store, transport });
    let a = await open(storeA), b = await open(storeB);
    await check('两端离线提交使用独立根记录及固定字节', async () => {
        await a.commit(intent(1, actorA, 'A', '离线A'));
        await b.commit(intent(2, actorB, 'B', '离线B'));
        assert.equal(storeA.value.outbox.length, 1); assert.equal(storeB.value.outbox.length, 1);
    });
    const rawWrite = remote.write; let recordWrites = 0;
    remote.write = async (name, bytes) => { await rawWrite(name, bytes); if (name.startsWith('records/') && ++recordWrites === 1) throw new Error('SIMULATED_RESPONSE_LOSS'); };
    await check('上传成功丢响应后实例重开先读回，不重新写', async () => {
        await b.sync(); assert.equal(b.state().outbox.length, 1);
        b = await open(storeB); await b.sync();
        assert.equal(b.state().outbox.length, 0); assert.equal(recordWrites, 1);
    });
    await check('两根补齐后客户端视图一致，扩展数据保留', async () => {
        await a.sync(); await b.sync(); await a.sync();
        assert.deepEqual(encode(a.state().view), encode(b.state().view));
        assert.equal(a.state().view.preserved_extension.value, '仅合成数据');
    });
    await a.commit(intent(3, actorA, 'A', '后继A')); await a.sync();
    const child = a.state().artifacts.at(-1), parent = a.state().artifacts[0];
    const read = remote.read; let unavailable = true;
    const hidden = { ...remote, list: async () => [child.name, child.name], read: async name => unavailable && name === parent.name ? null : read(name) };
    const storeC = new MemoryStore(); let c = await open(storeC, hidden);
    await check('只发现后继时精确补父，暂时失败冻结并保留重试', async () => {
        await c.sync(); assert.equal(c.state().blocked, true); assert.ok(c.state().retryNames.includes(parent.name));
        assert.equal(c.state().view.notes.A, undefined);
    });
    await check('实例重开后即使目录漏项仍继续补父并恢复一致', async () => {
        unavailable = false; hidden.list = async () => [];
        c = await open(storeC, hidden); await c.sync();
        assert.equal(c.state().blocked, false);
        assert.deepEqual(encode(c.state().view), encode(a.state().view));
    });
    await check('同集合六种排列及重复重放顺序一致', () => {
        const items = a.state().artifacts.map(item => ({ name: item.name, bytes: Buffer.from(item.base64, 'base64') }));
        const expected = encode(inspect(dataset.pin, items));
        for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) assert.deepEqual(encode(inspect(dataset.pin, [...order, ...order].map(i => items[i]))), expected);
    });
    await check('同ID异体同时首次创建保留两文件并冻结，不任取一个', async () => {
        const one = createRecord({ pin: dataset.pin, ...intent(4, actorA, 'X', '一个') });
        const two = createRecord({ pin: dataset.pin, ...intent(4, actorB, 'X', '另一个') });
        const conflictRemote = memoryTransport([one, two]);
        const client = await open(new MemoryStore(), conflictRemote); await client.sync();
        assert.equal(conflictRemote.files.size, 2); assert.equal(client.state().artifacts.length, 2); assert.equal(client.state().blocked, true);
    });
    await check('未知操作保存原始证据并阻止提交', async () => {
        const unknown = seal('record', { ...createRecord({ pin: dataset.pin, ...intent(5, actorA, 'X', '合成') }).value, operations: [{ type: 'future.operation' }] });
        const client = await open(new MemoryStore(), memoryTransport([unknown])); await client.sync();
        assert.equal(client.state().faults[0].base64, unknown.bytes.toString('base64'));
        await assert.rejects(client.commit(intent(6, actorA, 'X', '拒绝')), /DATASET_WRITE_BLOCKED/);
    });
    await check('丢弃全部客户端缓存后从固定数据集及记录冷恢复', async () => {
        const cold = await open(new MemoryStore()); await cold.sync();
        assert.deepEqual(encode(cold.state().view), encode(a.state().view));
    });
    return { outcome: 'passed', testedAt: new Date().toISOString(), protocol: dataset.pin.protocol, operationSet: 'lab-note/1',
        transport: 'memory', storage: 'memory-atomic-interface', datasetId: dataset.pin.dataset_id,
        descriptorSha256: dataset.pin.descriptor_sha256, baselineSha256: dataset.pin.baseline_sha256,
        numericVectors: vectors.numbers.length, checks, recordFiles: 3, finalProjectionSha256: hash(encode(a.state().view)),
        limitations: ['非真实WebDAV实测', '实例重开不是实际进程kill或断电', '仅Node实验编码，未验收Rust/Kotlin互通',
            '仅lab.note.set，未实现或批准生产业务操作', '未验证规模、完整迁移、协作授权及本地同步盘'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const report = await runSimulation();
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
}
