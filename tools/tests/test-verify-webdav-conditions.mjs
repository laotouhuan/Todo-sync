import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebDavConditions } from '../verify-webdav-conditions.mjs';

const options = { endpoint: 'https://example.test/dav/', directory: 'isolated/codex-webdav-preflight', username: 'tester', password: 'not-a-real-secret' };

function server({ ignoreCreate = false, ignoreUpdate = false, ignoreRace = false, weakETag = false,
    missingETag = false, invalidETag = false, ignoreMismatch = false, deny = false, lostCreate = false, cleanupFailure = false,
    retainAfterDelete = false, preexisting = false } = {}) {
    let body = preexisting ? 'unrelated-existing-content' : undefined;
    let revision = 0;
    const requests = [];
    const fetchImpl = async (url, request) => {
        requests.push({ url, ...request });
        assert.equal(request.redirect, 'error');
        assert.ok(url.startsWith('https://example.test/dav/isolated/codex-webdav-preflight/probe-'));
        const etag = invalidETag ? 'unquoted-sensitive-etag-value' : `${weakETag ? 'W/' : ''}"${revision}"`;
        if (deny) return new Response(null, { status: 403 });
        if (request.method === 'GET') return new Response(body ?? null, { status: body === undefined ? 404 : 200, headers: missingETag ? {} : { etag } });
        if (request.method === 'PUT') {
            if (!ignoreCreate && request.headers['If-None-Match'] === '*' && body !== undefined) return new Response(null, { status: 412 });
            const race = request.body.includes('client-a') || request.body.includes('client-b');
            const mismatch = request.body.includes('must-not-match');
            if (!ignoreUpdate && !(ignoreRace && race) && !(ignoreMismatch && mismatch) && request.headers['If-Match'] && request.headers['If-Match'] !== etag) return new Response(null, { status: 412 });
            const status = body === undefined ? 201 : 204;
            body = request.body;
            revision++;
            if (lostCreate && revision === 1) throw new Error('sensitive server details');
            return new Response(null, { status });
        }
        if (request.method === 'DELETE') {
            if (cleanupFailure) return new Response(null, { status: 500 });
            assert.equal(request.headers['If-Match'], weakETag || missingETag || invalidETag ? '*' : etag);
            if (!retainAfterDelete) body = undefined;
            return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected request');
    };
    return { fetchImpl, requests, body: () => body };
}

test('条件创建、更新和双客户端竞争通过，清理本次测试文件', async () => {
    const mock = server();
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.body(), undefined);
    assert.equal(report.checks.filter(item => /client-[ab]-write/.test(item.name) && item.status === 412).length, 1);
    assert.ok(report.checks.every(item => item.passed));
    const output = JSON.stringify(report);
    assert.ok(!output.includes(options.password));
    assert.ok(!output.includes(options.username));
    assert.ok(!output.includes('Authorization'));
});

for (const [name, overrides] of [['忽略条件创建', { ignoreCreate: true }], ['忽略过期ETag', { ignoreUpdate: true }], ['只有弱ETag', { weakETag: true }]]) {
    test(`${name}不能认定支持`, async () => {
        const mock = server(overrides);
        const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
        assert.equal(report.outcome, 'unsupported');
        assert.ok(report.checks.some(item => !item.passed));
    });
}

for (const [kind, overrides] of [['missing', { missingETag: true }], ['weak', { weakETag: true }], ['invalid', { invalidETag: true }]]) {
    test(`读回正文和${kind}ETag分别诊断，仅清理本次随机文件`, async () => {
        const mock = server(overrides);
        const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
        assert.equal(report.outcome, 'unsupported');
        assert.equal(report.checks.find(item => item.name === 'create-readback').passed, true);
        const diagnostic = report.checks.find(item => item.name === 'create-readback-etag');
        assert.equal(diagnostic.passed, false);
        assert.equal(diagnostic.etagKind, kind);
        assert.equal(diagnostic.etagPresent, kind !== 'missing');
        assert.equal(report.checks.find(item => item.name === 'conditional-create-refuses-existing').status, 412);
        assert.equal(report.checks.find(item => item.name === 'unmatched-valid-etag-refused').status, 412);
        assert.equal(report.checks.find(item => item.name === 'unmatched-update-preserves-body').passed, true);
        assert.equal(report.checks.find(item => item.name === 'strong-etag-required-for-valid-update').passed, false);
        assert.equal(mock.requests.filter(request => request.method === 'PUT').length, 3);
        assert.equal(report.cleanup.condition, 'exists');
        assert.equal(report.cleanup.removed, true);
        assert.equal(report.cleanup.verificationStatus, 404);
        assert.ok(!JSON.stringify(report).includes('unquoted-sensitive-etag-value'));
    });
}

test('无强ETag时仍能诊断随机合法If-Match被忽略，且不进行有效标签更新', async () => {
    const mock = server({ missingETag: true, ignoreMismatch: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'unsupported');
    assert.equal(report.checks.find(item => item.name === 'conditional-create-refuses-existing').status, 412);
    assert.equal(report.checks.find(item => item.name === 'unmatched-valid-etag-refused').status, 204);
    assert.equal(report.checks.some(item => item.name === 'conditional-update'), false);
    assert.equal(report.cleanup.removed, true);
});

test('403错误只能判定未确认，不删除未创建资源', async () => {
    const mock = server({ deny: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(mock.requests.length, 1);
    assert.equal(report.cleanup.attempted, false);
});

test('随机路径已有其他内容时不写入也不清理', async () => {
    const mock = server({ preexisting: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.notEqual(report.outcome, 'passed');
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.body(), 'unrelated-existing-content');
    assert.equal(report.cleanup.attempted, false);
});

test('并发时两个条件写均成功不能认定支持', async () => {
    const mock = server({ ignoreRace: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'unsupported');
    assert.equal(report.checks.filter(item => /client-[ab]-write/.test(item.name) && item.status === 204).length, 2);
    assert.equal(report.cleanup.removed, true);
});

test('创建响应丢失时按随机标记确认归属再清理，不输出网络错误', async () => {
    const mock = server({ lostCreate: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.cleanup.removed, true);
    assert.ok(!JSON.stringify(report).includes('sensitive'));
});

test('清理失败报告测试路径，不改写能力验证结论', async () => {
    const mock = server({ cleanupFailure: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.equal(report.cleanup.removed, false);
    assert.equal(report.cleanup.remainingPath, report.targetPath);
    assert.equal(report.cleanup.status, 500);
});

test('DELETE成功但读回仍存在时不得报告清理成功', async () => {
    const mock = server({ retainAfterDelete: true });
    const report = await verifyWebDavConditions({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.equal(report.cleanup.status, 204);
    assert.equal(report.cleanup.verificationStatus, 200);
    assert.equal(report.cleanup.removed, false);
    assert.equal(report.cleanup.remainingPath, report.targetPath);
});

test('禁止正式文件、根目录、目录穿越及URL内嵌凭据，请求不会发生', async () => {
    for (const invalid of [
        { directory: 'todo_data.json' }, { directory: '/' }, { directory: '../codex-webdav-preflight' },
        { directory: '%2e%2e/codex-webdav-preflight' }, { endpoint: 'https://user:secret@example.test/dav/' },
        { endpoint: 'http://example.test/dav/' }, { endpoint: 'https://example.test/dav/?secret=value' }
    ]) {
        let called = false;
        await assert.rejects(verifyWebDavConditions({ ...options, ...invalid, fetchImpl: async () => { called = true; } }));
        assert.equal(called, false);
    }
});
