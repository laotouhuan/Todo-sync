import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecordSyncPrototype } from '../run-live.mjs';

const options = { endpoint: 'https://example.test/dav/', directory: 'isolated/codex-webdav-preflight',
    username: 'synthetic-user', password: 'synthetic-password' };

function server({ keepDeleted = false } = {}) {
    const values = new Map();
    const methods = [];
    const collection = new URL(options.directory + '/', options.endpoint);
    const fetchImpl = async (href, request) => {
        const url = new URL(href);
        assert.equal(url.origin, collection.origin);
        assert.ok(url.pathname.startsWith(collection.pathname));
        assert.equal(request.redirect, 'error');
        methods.push(request.method);
        if (request.method === 'PROPFIND') {
            assert.equal(url.href, collection.href);
            const element = path => `<d:response><d:href>${path}</d:href></d:response>`;
            const body = `<d:multistatus xmlns:d="DAV:">${element(collection.pathname)}${[...values.keys()].map(path => element(new URL(path).pathname)).join('')}</d:multistatus>`;
            return new Response(body, { status: 207 });
        }
        assert.match(url.pathname.slice(collection.pathname.length), /^[0-9a-f-]{36}\.json$/);
        if (request.method === 'GET') return new Response(values.get(url.href) ?? null, { status: values.has(url.href) ? 200 : 404 });
        if (request.method === 'PUT') {
            const existed = values.has(url.href);
            values.set(url.href, request.body);
            return new Response(null, { status: existed ? 204 : 201 });
        }
        if (request.method === 'DELETE') {
            if (!keepDeleted) values.delete(url.href);
            return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected request');
    };
    return { fetchImpl, values, methods };
}

test('真实运行器的HTTP替身完整往返，仅使用独立记录且清理读回404', async () => {
    const mock = server();
    const report = await verifyRecordSyncPrototype({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.equal(report.scenario.recordCount, 5);
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.values.size, 0);
    assert.equal(mock.methods.filter(method => method === 'PUT').length, 5);
    const output = JSON.stringify(report);
    for (const secret of [options.username, options.password, 'Authorization']) assert.ok(!output.includes(secret));
    assert.ok(report.cleanup.resources.every(item => item.verificationStatus === 404));
});

test('清理假成功不能由协议场景通过掩盖', async () => {
    const mock = server({ keepDeleted: true });
    const report = await verifyRecordSyncPrototype({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.equal(report.cleanup.removed, false);
    assert.ok(report.cleanup.resources.every(item => item.status === 204 && item.verificationStatus === 200));
    assert.equal(mock.values.size, 5);
});
