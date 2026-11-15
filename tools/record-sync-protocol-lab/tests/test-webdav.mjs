import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebDavTransport } from '../webdav-transport.mjs';
import { verifyRecordSyncProtocolLab } from '../run-live.mjs';
import { verifyBusinessWebDav } from '../run-business-live.mjs';
import { verifyContentAddressedWebDav } from '../run-content-addressed-live.mjs';

const options = { endpoint: 'https://example.test/dav/', directory: 'scratch/codex-webdav-preflight', username: 'synthetic-user', password: 'synthetic-password' };
const recordName = 'records/10000000-0000-4000-8000-000000000001.' + 'a'.repeat(64) + '.json';
const baselineName = 'baseline.' + 'b'.repeat(64) + '.json';

function server({ transformXML = value => value, losePut = false, loseCollection = false, retainDelete = false, denied = false, honorConditionalCreate = false } = {}) {
    const files = new Map(), collections = new Set(), requests = [];
    let lost = false;
    const fetchImpl = async (href, request) => {
        const url = new URL(href);
        requests.push({ href, ...request });
        assert.equal(request.redirect, 'error');
        assert.equal(url.origin, 'https://example.test');
        assert.ok(url.pathname.startsWith('/dav/scratch/codex-webdav-preflight/'));
        assert.ok(!url.pathname.endsWith('/todo_data.json'));
        assert.equal(request.headers.Authorization, `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`);
        if (denied) return new Response(null, { status: 401 });
        if (request.method === 'MKCOL') {
            if (collections.has(href)) return new Response(null, { status: 405 });
            collections.add(href);
            if (loseCollection) throw new Error('secret collection response lost');
            return new Response(null, { status: 201 });
        }
        if (request.method === 'GET') return files.has(href) ? new Response(Buffer.from(files.get(href)), { status: 200 }) : new Response(null, { status: 404 });
        if (request.method === 'PUT') {
            const exists = files.has(href);
            if (exists && honorConditionalCreate && request.headers['If-None-Match'] === '*') return new Response(null, { status: 412 });
            files.set(href, Buffer.from(request.body));
            if (losePut && !lost) { lost = true; throw new Error('secret write response lost'); }
            return new Response(null, { status: exists && request.headers['If-None-Match'] === '*' ? 204 : 201 });
        }
        if (request.method === 'PROPFIND') {
            if (!collections.has(href)) return new Response(null, { status: 404 });
            const row = name => `<d:response><d:href>${name}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
            const children = request.headers.Depth === '0' ? [] : [...files.keys()].filter(name => name.startsWith(href));
            const xml = `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:">${[href, ...children].map(row).join('')}</d:multistatus>`;
            return new Response(transformXML(xml), { status: 207 });
        }
        if (request.method === 'DELETE') {
            if (collections.has(href)) {
                assert.ok(![...files.keys()].some(name => name.startsWith(href)), '不得递归删除非空集合');
                if (!retainDelete) collections.delete(href);
            } else if (!retainDelete) files.delete(href);
            return new Response(null, { status: 204 });
        }
        throw new Error('unexpected request');
    };
    return { files, collections, requests, fetchImpl };
}

test('内容寻址专项在遵守与忽略条件创建的服务上均验证正文和持久证据', async () => {
    for (const honorConditionalCreate of [true, false]) {
        const mock = server({ honorConditionalCreate });
        const report = await verifyContentAddressedWebDav({ ...options, fetchImpl: mock.fetchImpl });
        assert.equal(report.outcome, 'passed', JSON.stringify(report.checks));
        assert.equal(report.checks.length, 5);
        assert.deepEqual(report.concurrentStatuses, [201, honorConditionalCreate ? 412 : 204]);
        assert.equal(report.identityConflict.records.length, 2);
        assert.ok(report.changedReadEvidence.observedBase64);
        assert.equal(report.localCleanup, true);
        assert.equal(report.cleanup.removed, true);
        assert.equal(mock.files.size, 0);
        assert.equal(mock.collections.size, 0);
    }
});

test('条件创建在发送前拒绝路径和正文不一致的记录', async () => {
    const mock = server();
    const transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await assert.rejects(transport.write(recordName, Buffer.from('{}'), { conditionalCreate: true }),
        /RECORD_FILENAME_HASH_MISMATCH/);
    assert.equal(mock.requests.length, 0);
    assert.equal(transport.tracked.size, 0);
});

test('完整隔离live流程在模拟HTTP服务通过，并拆除所有已知资源', async () => {
    const mock = server();
    const report = await verifyRecordSyncProtocolLab({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.ok(report.checks.every(check => check.passed));
    assert.equal(report.checks.length, 8);
    assert.equal(report.recordFiles, 3);
    assert.equal(report.trackedArtifactCount, 5);
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.files.size, 0);
    assert.equal(mock.collections.size, 0);
    const puts = mock.requests.filter(request => request.method === 'PUT');
    assert.equal(puts.length, 5);
    assert.ok(new URL(puts[0].href).pathname.includes('/baseline.'));
    assert.ok(new URL(puts[1].href).pathname.includes('/dataset.'));
    const output = JSON.stringify(report);
    for (const secret of [options.username, options.password, 'Authorization', 'Basic ']) assert.ok(!output.includes(secret));
    assert.ok(report.limitations.includes('only-synthetic-lab-note-operations'));
});

test('业务记录在模拟 WebDAV 经固定入口写入、冷恢复和完整清理', async () => {
    const mock = server();
    const report = await verifyBusinessWebDav({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed', JSON.stringify(report.checks));
    assert.equal(report.checks.length, 5);
    assert.equal(report.recordFiles, 3);
    assert.equal(report.trackedArtifactCount, 5);
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.files.size, 0);
    assert.equal(mock.collections.size, 0);
    assert.equal(mock.requests.filter(request => request.method === 'PUT').length, 5);
    for (const secret of [options.username, options.password, 'Authorization', 'Basic ']) assert.ok(!JSON.stringify(report).includes(secret));
});

test('适配器只传输字节，支持精确对象读取和records枚举', async () => {
    const mock = server(), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await transport.ensureRecords();
    const bytes = Buffer.from([0xff, 0x00, 0x61]);
    await transport.write(recordName, bytes);
    assert.deepEqual(await transport.read(recordName), bytes);
    assert.deepEqual(await transport.list(), [recordName]);
    assert.equal(await transport.read(baselineName), null);
    assert.equal((await transport.cleanup()).removed, true);
});

test('PUT已执行但响应丢失时固定字节已登记且可清理，不输出原始错误', async () => {
    const mock = server({ losePut: true }), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await assert.rejects(transport.write(baselineName, Buffer.from('{}')), { message: 'WEBDAV_REQUEST_UNCONFIRMED' });
    assert.deepEqual(transport.tracked.get(baselineName), Buffer.from('{}'));
    assert.equal((await transport.cleanup()).removed, true);
    assert.equal(mock.files.size, 0);
});

test('提交字节在调用及对外观察后不可被修改', async () => {
    const mock = server(), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    const bytes = Buffer.from('original');
    const write = transport.write(baselineName, bytes); bytes.fill(0); await write;
    transport.tracked.get(baselineName).fill(0);
    assert.deepEqual(await transport.read(baselineName), Buffer.from('original'));
    assert.equal((await transport.cleanup()).removed, true);
});

test('清理前固定内容不匹配时保留对象，不删除records集合', async () => {
    const mock = server(), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await transport.ensureRecords(); await transport.write(recordName, Buffer.from('ours'));
    mock.files.set(new URL(options.directory + '/' + recordName, options.endpoint).href, Buffer.from('unknown-other-content'));
    const report = await transport.cleanup();
    assert.equal(report.removed, false);
    assert.ok(report.resources.some(item => item.reason === 'fixed-content-not-confirmed'));
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
    assert.equal(mock.collections.size, 1);
});

test('DELETE成功但读回仍存在时不能报告清理成功', async () => {
    const mock = server({ retainDelete: true }), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await transport.ensureRecords(); await transport.write(recordName, Buffer.from('{}'));
    const report = await transport.cleanup();
    assert.equal(report.removed, false);
    assert.equal(report.resources[0].verificationStatus, 200);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE' && request.href.endsWith('/records/')).length, 0);
});

test('集合创建结果未知时保留路径且禁止强制删除', async () => {
    const mock = server({ loseCollection: true }), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await assert.rejects(transport.ensureRecords(), /UNCONFIRMED/);
    await assert.rejects(transport.ensureRecords(), /OWNERSHIP_UNCONFIRMED/);
    const report = await transport.cleanup();
    assert.equal(report.removed, false);
    assert.equal(report.resources[0].created, false);
    assert.ok(report.resources[0].remainingPath.endsWith('/records/'));
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
});

test('未知子项不能被忽略以假装集合为空', async () => {
    const mock = server(), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await transport.ensureRecords();
    mock.files.set(new URL(options.directory + '/records/unrelated.txt', options.endpoint).href, Buffer.from('unknown'));
    await assert.rejects(transport.list(), /INVALID_DIRECTORY_PATH/);
    assert.equal((await transport.cleanup()).removed, false);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
});

for (const [label, transformXML] of [
    ['错误命名空间', xml => xml.replace('xmlns:d="DAV:"', 'xmlns:d="wrong:"')],
    ['跨源href', xml => xml.replace('<d:href>https://example.test', '<d:href>https://other.test')],
    ['目录穿越', xml => xml.replace('/records/</d:href>', '/records/../../todo_data.json</d:href>')],
    ['编码目录穿越', xml => xml.replace('/records/</d:href>', '/records/%2e%2e/todo_data.json</d:href>')],
    ['查询参数', xml => xml.replace('/records/</d:href>', '/records/?secret=value</d:href>')],
    ['未知实体', xml => xml.replace('/records/</d:href>', '/records/&unknown;</d:href>')],
    ['实体定义', xml => xml.replace('?><d:multistatus', '?><!DOCTYPE x><d:multistatus')],
    ['不闭合标签', xml => xml.replace('</d:response>', '')],
    ['重复href', xml => xml.replace('</d:href>', '</d:href><d:href>https://example.test/outside</d:href>')],
    ['非法UTF8', () => Buffer.from([0xff])]
]) test(`严格拒绝目录响应：${label}`, async () => {
    const mock = server({ transformXML }), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    await transport.ensureRecords();
    await assert.rejects(transport.list(), /INVALID_DIRECTORY/);
    const cleanup = await transport.cleanup();
    assert.equal(cleanup.removed, false);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
});

test('HTTP错误不当作404空数据或成功', async () => {
    const transport = createWebDavTransport({ ...options, fetchImpl: server({ denied: true }).fetchImpl });
    await assert.rejects(transport.read(baselineName), /WEBDAV_READ_HTTP_401/);
    await assert.rejects(transport.list(), /WEBDAV_LIST_HTTP_401/);
    await assert.rejects(transport.write(baselineName, Buffer.from('{}')), /WEBDAV_WRITE_HTTP_401/);
});

test('无效目标、正式文件、越界路径均在发请求前被拒绝', async () => {
    for (const invalid of [{ endpoint: 'http://example.test/dav/' }, { endpoint: 'https://user:secret@example.test/dav/' },
        { directory: '../codex-webdav-preflight' }, { directory: 'todo_data.json' }]) {
        let called = false;
        assert.throws(() => createWebDavTransport({ ...options, ...invalid, fetchImpl: async () => { called = true; } }));
        assert.equal(called, false);
    }
    const mock = server(), transport = createWebDavTransport({ ...options, fetchImpl: mock.fetchImpl });
    for (const name of ['todo_data.json', '../' + recordName, 'records/subdir/' + recordName, 'dataset.json']) {
        await assert.rejects(transport.read(name)); await assert.rejects(transport.write(name, Buffer.from('{}')));
    }
    assert.equal(mock.requests.length, 0);
});
