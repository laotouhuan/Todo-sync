import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIfMatch } from '../verify-webdav-if-match.mjs';

const options = { endpoint: 'https://example.test/dav/', directory: 'isolated/codex-webdav-preflight', username: 'tester', password: 'not-a-real-secret' };

function server({ noETag = false, invalidETag = false, weakETag = false, ignoreWrong = false, forbidWrong = false,
    ignoreCreateRace = false, ignoreUpdateRace = false, noWrite = false, rejectedWrite = false,
    rejectedDelete = false, lostUpdate = false, failBeforeUpdate = false, cleanupFalse = false, foreignBody = false,
    etagOverride = null } = {}) {
    const data = new Map();
    const requests = [];
    const fetchImpl = async (url, request) => {
        requests.push({ url, ...request });
        assert.equal(request.redirect, 'error');
        const current = data.get(url);
        const tag = current ? `"revision-${current.revision}"` : null;
        if (request.method === 'GET') return new Response(current?.body ?? null, { status: current ? 200 : 404,
            headers: !current || noETag ? {} : { etag: etagOverride ?? (invalidETag ? 'raw-unquoted-tag' : weakETag ? `W/${tag}` : tag) } });
        if (request.method === 'PUT') {
            const parsed = JSON.parse(request.body);
            if (failBeforeUpdate && parsed.scenario === 'correctUpdate' && parsed.revision === 'after') throw new Error('secret early transport error');
            if (request.headers['If-None-Match'] === '*' && current && !(ignoreCreateRace && parsed.scenario === 'concurrentCreate')) return new Response(null, { status: 412 });
            const incorrect = request.headers['If-Match'] && request.headers['If-Match'] !== tag;
            const skip = ignoreWrong || (ignoreUpdateRace && parsed.scenario === 'concurrentUpdate');
            if (incorrect && !skip) {
                if (forbidWrong && parsed.scenario === 'wrongETag') return new Response(null, { status: 403 });
                if (rejectedWrite && parsed.scenario === 'wrongETag') data.set(url, { body: request.body, revision: current.revision + 1 });
                if (rejectedDelete && parsed.scenario === 'wrongETag') data.delete(url);
                return new Response(null, { status: 412 });
            }
            if (!(noWrite && parsed.scenario === 'correctUpdate' && parsed.revision === 'after')) {
                data.set(url, { body: foreignBody ? JSON.stringify({ probe: 'unrelated-resource' }) : request.body, revision: (current?.revision ?? 0) + 1 });
            }
            if (lostUpdate && parsed.scenario === 'correctUpdate' && parsed.revision === 'after') throw new Error('secret transport error');
            return new Response(null, { status: current ? 204 : 201 });
        }
        if (request.method === 'DELETE') {
            if (!cleanupFalse) data.delete(url);
            return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected request');
    };
    return { data, requests, fetchImpl };
}

test('完整条件更新及首次创建逐项通过且最终正文匹配', async () => {
    const mock = server();
    const report = await verifyIfMatch({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.ok(Object.values(report.capabilities).every(outcome => outcome === 'passed'));
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.data.size, 0);
    assert.equal(report.checks.find(item => item.name === 'concurrentCreate:conditional-race').matchesWinner, true);
    assert.equal(report.checks.find(item => item.name === 'concurrentUpdate:conditional-race').matchesWinner, true);
    const output = JSON.stringify(report);
    assert.ok(!output.includes(options.password));
    assert.ok(!output.includes(options.username));
    assert.ok(!output.includes('revision-1'));
    assert.ok(!output.includes('Authorization'));
});

for (const etag of ['"quoted space"', '"quoted\u007fcontrol"']) test('加了引号但含非法字符的标签仍不能作为强ETag', async () => {
    const report = await verifyIfMatch({ ...options, fetchImpl: server({ etagOverride: etag }).fetchImpl });
    assert.equal(report.capabilities.etag, 'unsupported');
    assert.equal(report.capabilities.correctUpdate, 'not-executed');
    assert.equal(report.checks.find(item => item.name === 'etag:raw-format-and-stability').etagKind, 'invalid');
});

for (const [label, overrides] of [['missing', { noETag: true }], ['invalid', { invalidETag: true }], ['weak', { weakETag: true }]]) {
    test(`${label}ETag不阻断随机错误标签及首次创建，其他更新明确未执行`, async () => {
        const mock = server(overrides);
        const report = await verifyIfMatch({ ...options, fetchImpl: mock.fetchImpl });
        assert.equal(report.capabilities.etag, 'unsupported');
        assert.equal(report.capabilities.wrongETag, 'passed');
        assert.equal(report.capabilities.concurrentCreate, 'passed');
        for (const key of ['correctUpdate', 'staleETag', 'concurrentUpdate']) assert.equal(report.capabilities[key], 'not-executed');
        assert.equal(report.cleanup.removed, true);
        const metadata = report.checks.find(item => item.name === 'etag:raw-format-and-stability');
        assert.equal(metadata.etagKind, label);
        assert.equal(metadata.stable, label !== 'missing');
        assert.equal(metadata.quoted, false);
        assert.equal(metadata.weakPrefix, label === 'weak');
        assert.equal(metadata.hexOnly, false);
        assert.equal(metadata.hasWhitespace, false);
        assert.equal(metadata.ASCIIOnly, label !== 'missing');
        assert.ok(!JSON.stringify(report).includes('raw-unquoted-tag'));
    });
}

test('错误标签被忽略，即使返回成功也判不支持且报告正文不符', async () => {
    const report = await verifyIfMatch({ ...options, fetchImpl: server({ ignoreWrong: true }).fetchImpl });
    assert.equal(report.capabilities.wrongETag, 'unsupported');
    assert.equal(report.capabilities.staleETag, 'unsupported');
    assert.equal(report.checks.find(item => item.name === 'wrongETag:random-legal-tag').bodyMatches, false);
});

test('错误标签被403拒绝只能标未确认', async () => {
    const report = await verifyIfMatch({ ...options, fetchImpl: server({ forbidWrong: true }).fetchImpl });
    assert.equal(report.capabilities.wrongETag, 'inconclusive');
    assert.equal(report.capabilities.correctUpdate, 'passed');
});

test('首次创建竞争失败不阻断其他If-Match分项', async () => {
    const report = await verifyIfMatch({ ...options, fetchImpl: server({ ignoreCreateRace: true }).fetchImpl });
    assert.equal(report.capabilities.concurrentCreate, 'unsupported');
    assert.equal(report.capabilities.correctUpdate, 'passed');
    assert.equal(report.capabilities.wrongETag, 'passed');
});

test('两客户端同etag更新均成功判不支持', async () => {
    const report = await verifyIfMatch({ ...options, fetchImpl: server({ ignoreUpdateRace: true }).fetchImpl });
    assert.equal(report.capabilities.concurrentUpdate, 'unsupported');
    assert.equal(report.checks.find(item => item.name === 'concurrentUpdate:conditional-race').exactlyOneWinner, false);
});

test('成功但未写入和拒绝但实际写入均被正文验证识别', async () => {
    const noWrite = await verifyIfMatch({ ...options, fetchImpl: server({ noWrite: true }).fetchImpl });
    assert.equal(noWrite.capabilities.correctUpdate, 'unsupported');
    const rejected = await verifyIfMatch({ ...options, fetchImpl: server({ rejectedWrite: true }).fetchImpl });
    assert.equal(rejected.capabilities.wrongETag, 'unsupported');
    assert.equal(rejected.checks.find(item => item.name === 'wrongETag:random-legal-tag').status, 412);
    const deleted = await verifyIfMatch({ ...options, fetchImpl: server({ rejectedDelete: true }).fetchImpl });
    assert.equal(deleted.capabilities.wrongETag, 'unsupported');
    assert.equal(deleted.checks.find(item => item.name === 'wrongETag:random-legal-tag').readStatus, 404);
});

test('响应丢失仍读回最终正文，但结果为未确认且不输出错误', async () => {
    const mock = server({ lostUpdate: true });
    const report = await verifyIfMatch({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.capabilities.correctUpdate, 'inconclusive');
    const check = report.checks.find(item => item.name === 'correctUpdate:matching-etag');
    assert.equal(check.status, null);
    assert.equal(check.bodyMatches, true);
    assert.equal(check.bodyMatchesBefore, false);
    assert.equal(report.cleanup.removed, true);
    assert.ok(!JSON.stringify(report).includes('secret transport error'));
    assert.equal(mock.requests.filter(request => request.method === 'PUT' &&
        JSON.parse(request.body).scenario === 'correctUpdate' && JSON.parse(request.body).revision === 'after').length, 1);
});

test('请求未到服务端时读回原正文并标未确认，不盲目重发', async () => {
    const mock = server({ failBeforeUpdate: true });
    const report = await verifyIfMatch({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.capabilities.correctUpdate, 'inconclusive');
    const check = report.checks.find(item => item.name === 'correctUpdate:matching-etag');
    assert.equal(check.status, null);
    assert.equal(check.bodyMatches, false);
    assert.equal(check.bodyMatchesBefore, true);
    assert.equal(report.cleanup.removed, true);
    assert.ok(!JSON.stringify(report).includes('secret early transport error'));
    assert.equal(mock.requests.filter(request => request.method === 'PUT' &&
        JSON.parse(request.body).scenario === 'correctUpdate' && JSON.parse(request.body).revision === 'after').length, 1);
});

test('清理返回204但文件仍在时不得报告已移除', async () => {
    const report = await verifyIfMatch({ ...options, fetchImpl: server({ cleanupFalse: true }).fetchImpl });
    assert.equal(report.outcome, 'passed');
    assert.equal(report.cleanup.removed, false);
    assert.ok(report.cleanup.resources.every(resource => !resource.removed && resource.verificationStatus === 200));
});

test('读回归属不明的内容时不执行删除', async () => {
    const mock = server({ foreignBody: true });
    const report = await verifyIfMatch({ ...options, fetchImpl: mock.fetchImpl });
    assert.equal(report.cleanup.removed, false);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
});

test('不接受正式路径或带凭据URL，且无网络请求', async () => {
    for (const invalid of [{ directory: 'todo_data.json' }, { directory: '../codex-webdav-preflight' },
        { endpoint: 'https://user:password@example.test/dav/' }, { endpoint: 'http://example.test/dav/' }]) {
        let called = false;
        await assert.rejects(verifyIfMatch({ ...options, ...invalid, fetchImpl: async () => { called = true; } }));
        assert.equal(called, false);
    }
});
