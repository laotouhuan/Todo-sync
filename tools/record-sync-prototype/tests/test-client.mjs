import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, snapshotHash, createRecord, project } from '../protocol.mjs';
import { openClient, MemoryStore, FileStore } from '../client.mjs';
import { createMemoryTransport, createWebDavTransport } from '../transport.mjs';

const snapshot = JSON.parse(readFileSync(new URL('../fixture.json', import.meta.url), 'utf8'));
const id = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const actor = id(9000);
const time = '2026-11-05T12:00:00+08:00';
const patch = content => ({ type: 'todo.patch', todo_id: snapshot.data.todos[0].id, fields: { content } });
const intent = (number, content = `修改${number}`) => ({ id: id(number), actor_id: actor, created_at: time, operations: [patch(content)] });
const make = (number, known = []) => createRecord(snapshot, known, intent(number));
const open = (store = new MemoryStore(), transport = createMemoryTransport()) => openClient({ snapshot, store, transport });
function directory(t) {
    // Windows sandbox的虚拟Temp禁止rename；在当前测试目录内验证真实原子替换。
    const scratchBase = dirname(fileURLToPath(import.meta.url));
    const path = mkdtempSync(join(scratchBase, 'todo-record-client-'));
    t.after(() => {
        assert.equal(dirname(resolve(path)), resolve(scratchBase));
        assert.ok(basename(path).startsWith('todo-record-client-'));
        rmSync(path, { recursive: true, force: true });
    });
    return path;
}

test('commit完整记录和outbox原子保存后才发布，提交不发网络', async () => {
    const calls = [];
    const backing = new MemoryStore();
    const store = { load: () => backing.load(), async save(state) {
        calls.push('save');
        assert.equal(state.records.length, 1);
        assert.deepEqual(state.pendingIds, [state.records[0].id]);
        await backing.save(state);
    } };
    const transport = Object.fromEntries(['read', 'write', 'list'].map(name => [name, async () => { calls.push(name); throw new Error('unexpected-network'); }]));
    const client = await open(store, transport);
    const record = await client.commit(intent(1));
    assert.deepEqual(calls, ['save']);
    assert.deepEqual(client.pendingUploads(), [record.id]);
    assert.equal(client.view().data.todos[0].content, '修改1');
    assert.equal((await backing.load()).snapshot_hash, snapshotHash(snapshot));
});

test('本地保存失败不发布、不发网络，重试仍使用同一提交身份', async () => {
    const backing = new MemoryStore();
    let fail = true, network = 0;
    const store = { load: () => backing.load(), async save(state) { if (fail) throw new Error('disk-failed'); await backing.save(state); } };
    const client = await open(store, { async read() { network++; }, async write() { network++; }, async list() { network++; } });
    await assert.rejects(client.commit(intent(1)), /disk-failed/);
    assert.deepEqual(client.records(), []);
    assert.deepEqual(client.pendingUploads(), []);
    assert.equal(client.view().data.todos[0].content, snapshot.data.todos[0].content);
    assert.equal(network, 0);
    fail = false;
    assert.equal((await client.commit(intent(1))).id, id(1));
});

test('调用commit时立即冻结输入，排队期间调用方修改对象不改变记录', async () => {
    const client = await open();
    const input = intent(1, '最初文字');
    const saved = client.commit(input);
    input.operations[0].fields.content = '调用后修改';
    input.created_at = '2099-01-01T00:00:00Z';
    const record = await saved;
    assert.equal(record.operations[0].fields.content, '最初文字');
    assert.equal(record.created_at, time);
    const retry = await client.commit(intent(1, '最初文字'));
    assert.equal(canonical(retry), canonical(record));
    await assert.rejects(client.commit(intent(1, '同ID不同内容')), /RECORD_ID_CONTENT_CONFLICT/);
});

test('FileStore提交后未上传即重启，恢复完整固定内容和pending', async t => {
    const root = directory(t), transport = createMemoryTransport();
    const first = await open(new FileStore(root), transport);
    const saved = await first.commit(intent(1));
    const bytes = readFileSync(join(root, 'record-sync-state.json'), 'utf8');
    const second = await open(new FileStore(root), transport);
    assert.equal(canonical(second.records()[0]), canonical(saved));
    assert.deepEqual(second.pendingUploads(), [saved.id]);
    assert.equal(readFileSync(join(root, 'record-sync-state.json'), 'utf8'), bytes);
    await second.sync();
    const third = await open(new FileStore(root), transport);
    assert.deepEqual(third.pendingUploads(), []);
    assert.equal(canonical(third.view()), canonical(second.view()));
});

test('远端写成功但本地ack落盘失败，重启先读同文件确认而不重复PUT', async t => {
    const backing = new FileStore(directory(t)), remote = createMemoryTransport();
    let failAck = false, writes = 0;
    const store = { load: () => backing.load(), async save(state) { if (failAck && !state.pendingIds.length) throw new Error('ack-disk-failed'); await backing.save(state); } };
    const transport = { ...remote, async write(...args) { writes++; await remote.write(...args); } };
    const first = await open(store, transport);
    await first.commit(intent(1));
    failAck = true;
    await assert.rejects(first.sync(), /ack-disk-failed/);
    assert.deepEqual(first.pendingUploads(), [id(1)]);
    assert.deepEqual((await backing.load()).pendingIds, [id(1)]);
    const restarted = await open(backing, transport);
    await restarted.sync();
    assert.equal(writes, 1);
    assert.deepEqual(restarted.pendingUploads(), []);
});

for (const applied of [false, true]) test(`PUT${applied ? '成功响应丢失' : '请求未到达'}保留pending，重启读回确认且不重建记录`, async t => {
    const store = new FileStore(directory(t)), remote = createMemoryTransport();
    let fail = true;
    const attempts = [];
    const transport = { ...remote, async write(recordId, record) {
        attempts.push(canonical(record));
        if (!fail || applied) await remote.write(recordId, record);
        if (fail) { fail = false; throw new Error('synthetic-request-failed'); }
    } };
    const first = await open(store, transport);
    const saved = await first.commit(intent(1));
    const outcome = await first.sync();
    assert.equal(outcome.writeFailures.length, 1);
    assert.deepEqual(first.pendingUploads(), [id(1)]);
    const restarted = await open(store, transport);
    await restarted.sync();
    assert.deepEqual(restarted.pendingUploads(), []);
    assert.equal(attempts.length, applied ? 1 : 2);
    assert.ok(attempts.every(bytes => bytes === canonical(saved)));
    assert.equal(restarted.records().length, 1);
});

test('上传检查读取失败时不发送PUT；写后确认读取失败仍保留pending', async () => {
    for (const failRead of [1, 2]) {
        const remote = createMemoryTransport();
        let reads = 0, writes = 0;
        const transport = { ...remote, async read(recordId) { if (++reads === failRead) throw new Error('temporary-read-failure'); return remote.read(recordId); },
            async write(...args) { writes++; await remote.write(...args); } };
        const client = await open(new MemoryStore(), transport);
        await client.commit(intent(1));
        const result = await client.sync();
        assert.ok(result.readFailures.some(failure => failure.phase === (failRead === 1 ? 'upload-check' : 'upload-confirmation')));
        assert.deepEqual(client.pendingUploads(), [id(1)]);
        assert.equal(writes, failRead === 1 ? 0 : 1);
        await client.sync();
        assert.deepEqual(client.pendingUploads(), []);
        assert.equal(writes, 1);
    }
});

test('重复乱序和临时漏项不删除已下载记录，未知父依赖保留后补齐', async () => {
    const parent = make(1), child = make(2, [parent]), concurrent = make(3);
    const remote = createMemoryTransport([parent, child, concurrent]);
    const listings = [[child.id, child.id], [], [concurrent.id, parent.id, parent.id], []];
    const client = await open(new MemoryStore(), { ...remote, async list() { return listings.shift(); } });
    await client.sync();
    assert.deepEqual(client.view().pendingIds, [child.id]);
    await client.sync();
    assert.equal(client.records().length, 1);
    await client.sync();
    assert.equal(canonical(client.view()), canonical(project(snapshot, [parent, child, concurrent])));
    await client.sync();
    assert.equal(client.records().length, 3);
});

test('列表列出但读取失败的ID持久重试，即使重启后列表再次漏项', async t => {
    const parent = make(1), child = make(2, [parent]), remote = createMemoryTransport([parent, child]);
    const store = new FileStore(directory(t));
    let broken = true;
    const first = await open(store, { ...remote, async read(recordId) { if (recordId === parent.id && broken) throw new Error('read-temporary'); return remote.read(recordId); } });
    const result = await first.sync();
    assert.deepEqual(result.downloadRetryIds, [parent.id]);
    assert.deepEqual(first.view().pendingIds, [child.id]);
    broken = false;
    const restarted = await open(store, { ...remote, async list() { return []; } });
    const recovered = await restarted.sync();
    assert.deepEqual(recovered.downloadRetryIds, []);
    assert.equal(canonical(restarted.view()), canonical(project(snapshot, [parent, child])));
});

test('同ID远端内容冲突立即报错且绝不覆盖，已下载记录也再次核对', async () => {
    const remote = createMemoryTransport();
    let writes = 0;
    const transport = { ...remote, async write(...args) { writes++; await remote.write(...args); } };
    const client = await open(new MemoryStore(), transport);
    const local = await client.commit(intent(1));
    const wrong = createRecord(snapshot, [], intent(1, '冲突远端'));
    await remote.write(wrong.id, wrong);
    await assert.rejects(client.sync(), /RECORD_ID_CONTENT_CONFLICT/);
    assert.equal(writes, 0);
    assert.deepEqual(client.pendingUploads(), [id(1)]);
    assert.equal(canonical(client.records()[0]), canonical(local));
    await remote.write(local.id, local);
    await client.sync();
    await remote.write(wrong.id, wrong);
    await assert.rejects(client.sync(), /RECORD_ID_CONTENT_CONFLICT/);
    assert.equal(writes, 0);
    assert.equal(canonical(client.records()[0]), canonical(local));
});

test('冷客户端仅统一snapshot和远端记录恢复完整投影，不上传派生文件', async () => {
    const a = make(1), b = make(2, [a]);
    const remote = createMemoryTransport([b, a]);
    const client = await open(new MemoryStore(), { ...remote, async write() { throw new Error('cold-client-must-not-write'); } });
    const result = await client.sync();
    assert.equal(canonical(client.view()), canonical(project(snapshot, [a, b])));
    assert.deepEqual(client.view().data.prototype_extension, snapshot.data.prototype_extension);
    assert.equal(result.listingCompleteness, 'unknown');
    assert.deepEqual(client.pendingUploads(), []);
});

test('空列表不宣称全局已齐，列表失败不清空本地数据', async () => {
    const client = await open(new MemoryStore(), { async list() { throw new Error('listing-failed'); } });
    const result = await client.sync();
    assert.equal(result.listFailure, 'list-unavailable');
    assert.equal(result.listingCompleteness, 'unknown');
    assert.deepEqual(client.records(), []);
    assert.deepEqual(client.view().data.todos, snapshot.data.todos);
});

test('客户端commit和sync串行，两个提交父关系正确且返回值都是副本', async () => {
    const client = await open();
    const first = client.commit(intent(1));
    const second = client.commit(intent(2));
    const synchronized = client.sync();
    const [a, b] = await Promise.all([first, second]);
    await synchronized;
    assert.deepEqual(b.parents, [a.id]);
    const records = client.records(); records[0].operations[0].fields.content = '外部篡改';
    const view = client.view(); view.data.todos[0].content = '外部篡改';
    assert.equal(client.view().data.todos[0].content, '修改2');
    assert.notEqual(client.records()[0].operations[0].fields.content, '外部篡改');
});

test('已有状态缺少身份、错数据集或集合损坏时拒绝，不静默创建空状态', async () => {
    const valid = { snapshot_hash: snapshotHash(snapshot), dataset_id: snapshot.dataset_id, records: [], pendingIds: [], downloadRetryIds: [] };
    for (const invalid of [undefined, {}, { ...valid, snapshot_hash: '' }, { ...valid, dataset_id: id(100) },
        { ...valid, records: {} }, { ...valid, pendingIds: '' }, { ...valid, downloadRetryIds: undefined }, { ...valid, pendingIds: [id(1)] }]) {
        await assert.rejects(open({ async load() { return invalid; }, async save() { throw new Error('must-not-save'); } }), /LOCAL_/);
    }
});

test('FileStore损坏JSON不得被当成新状态或覆盖', async t => {
    const root = directory(t), path = join(root, 'record-sync-state.json');
    writeFileSync(path, '{broken-state');
    await assert.rejects(open(new FileStore(root)), /LOCAL_STATE_UNREADABLE/);
    assert.equal(readFileSync(path, 'utf8'), '{broken-state');
});

const webOptions = { endpoint: 'https://example.test/dav/', directory: 'isolated/codex-webdav-preflight', username: 'synthetic-webdav-user', password: 'synthetic-secret' };
function listing(hrefs) { return `<d:multistatus xmlns:d="DAV:">${hrefs.map(href => `<d:response><d:href>${href}</d:href></d:response>`).join('')}</d:multistatus>`; }

test('WebDAV只写隔离UUID.json的固定规范UTF8字节，列举重复去重且不使用共享索引', async () => {
    const record = make(1), captured = [], values = new Map();
    const collection = 'https://example.test/dav/isolated/codex-webdav-preflight/';
    const transport = createWebDavTransport({ ...webOptions, async fetchImpl(url, request) {
        captured.push({ url, ...request });
        assert.equal(request.redirect, 'error');
        assert.equal(request.headers.Authorization, `Basic ${Buffer.from(`${webOptions.username}:${webOptions.password}`).toString('base64')}`);
        if (request.method === 'PROPFIND') {
            assert.equal(request.headers.Depth, '1');
            return new Response(listing([collection, id(1) + '.json', id(1) + '.json']), { status: 207 });
        }
        assert.equal(url, collection + record.id + '.json');
        if (request.method === 'PUT') { values.set(url, request.body); return new Response(null, { status: 201 }); }
        return new Response(values.get(url) || null, { status: values.has(url) ? 200 : 404 });
    } });
    assert.equal(await transport.read(id(1)), null);
    await transport.write(id(1), record);
    assert.equal(values.values().next().value, canonical(record));
    assert.equal(canonical(await transport.read(id(1))), canonical(record));
    assert.deepEqual(await transport.list(), [id(1)]);
    assert.ok(captured.every(request => !request.url.includes('todo_data.json') && !request.url.includes('index')));
});

test('WebDAV拒绝DTD实体、跨域或跨目录href及畸形目录结果', async () => {
    const bodies = [
        '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///private">]>' + listing([]),
        listing(['https://other.test/' + id(1) + '.json']),
        listing(['../' + id(1) + '.json']), listing(['nested/' + id(1) + '.json']),
        listing(['&unknown;' + id(1) + '.json']), '<d:multistatus><d:response><d:href>x</d:href></d:multistatus>'
    ];
    for (const body of bodies) {
        const transport = createWebDavTransport({ ...webOptions, async fetchImpl() { return new Response(body, { status: 207 }); } });
        await assert.rejects(transport.list(), /INVALID_DIRECTORY_LIST/);
    }
});

test('WebDAV读取非规范JSON、非法UTF8或同ID不同正文时拒绝', async () => {
    const record = make(1);
    for (const body of [canonical(record) + '\n', new Uint8Array([0xff]), canonical({ ...record, id: id(2) })]) {
        const transport = createWebDavTransport({ ...webOptions, async fetchImpl() { return new Response(body, { status: 200 }); } });
        await assert.rejects(transport.read(id(1)), /NON_CANONICAL_RECORD|INVALID_UTF8_RESPONSE|RECORD_ID_CONTENT_CONFLICT/);
    }
});

test('WebDAV配置和ID越界在联网前拒绝，网络错误不含认证信息', async () => {
    let requests = 0;
    for (const invalid of [{ endpoint: 'http://example.test/dav/' }, { endpoint: 'https://user:secret@example.test/dav/' },
        { directory: '../codex-webdav-preflight' }, { directory: 'todo_data.json' }]) {
        assert.throws(() => createWebDavTransport({ ...webOptions, ...invalid, async fetchImpl() { requests++; } }), /INVALID_TRANSPORT_CONFIGURATION/);
    }
    const transport = createWebDavTransport({ ...webOptions, async fetchImpl() { requests++; throw new Error(webOptions.password); } });
    await assert.rejects(transport.read('../todo_data'), /INVALID_RECORD_ID/);
    assert.equal(requests, 0);
    await assert.rejects(transport.read(id(1)), error => error.message === 'WEBDAV_REQUEST_FAILED' && !error.message.includes(webOptions.password));
});
