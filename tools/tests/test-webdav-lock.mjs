import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyExclusiveLock, LOCK_CAPABILITY_NAMES } from '../verify-webdav-lock.mjs';

const options = { endpoint: 'https://example.test/dav/', directory: 'isolated/codex-webdav-preflight',
    username: 'synthetic-user', password: 'synthetic-secret' };

function server({ unsupported = false, secondSucceeds = false, ignoreUnqualified = false, ignoreWrongToken = false,
    acceptOldToken = false, timeout = 'Second-1', ignoreExpiry = false, fault = null, preexisting = false,
    omitRefreshTokenHeader = true, deniedStatus = 0, discoveryUnavailable = false, corruptScope = false, delayAfter = null,
    invalidDiscovery = null, incompleteMetadata = false } = {}) {
    const files = new Map(), locks = new Map(), requests = [], sleeps = [], counts = new Map(), appliedWrites = [];
    let clock = 0, sequence = 0, faultUsed = false;
    const active = url => {
        const current = locks.get(url);
        if (current && clock >= current.expires && !ignoreExpiry) locks.delete(url);
        return locks.get(url);
    };
    const ttl = /^Second-(\d+)$/.exec(timeout)?.[1];
    const lockXML = lock => lock ? `<D:activelock xmlns:D="DAV:"><D:lockscope><D:${corruptScope ? 'shared' : 'exclusive'}/></D:lockscope><D:locktype><D:write/></D:locktype><D:depth>${incompleteMetadata ? 'infinity' : '0'}</D:depth>${incompleteMetadata ? '' : `<D:owner>${lock.owner}</D:owner>`}<D:timeout>${timeout}</D:timeout><D:locktoken><D:href>${lock.token}</D:href></D:locktoken></D:activelock>` : '';
    const fetchImpl = async (url, request) => {
        requests.push({ url, ...request });
        assert.equal(request.redirect, 'error');
        assert.match(url, /^https:\/\/example\.test\/dav\/isolated\/codex-webdav-preflight\/lock-(?:create-)?[0-9a-f-]+\.json$/);
        assert.ok(!request.headers['If-None-Match']);
        const number = (counts.get(request.method) || 0) + 1;
        counts.set(request.method, number);
        const fails = !faultUsed && fault?.method === request.method && fault.at === number;
        if (fails) {
            faultUsed = true;
            if (!fault.applied) throw new Error(`${options.password} request-not-arrived`);
        }
        const response = (() => {
            const held = active(url);
            const supplied = /^\(<([^<>]+)>\)$/.exec(request.headers.If || '')?.[1];
            if (request.method === 'GET') return new Response(files.has(url) ? files.get(url) : preexisting ? 'unrelated-private-content' : null,
                { status: files.has(url) || preexisting ? 200 : 404 });
            if (request.method === 'PROPFIND') {
                assert.equal(request.headers.Depth, '0');
                if (discoveryUnavailable) return new Response(null, { status: 500 });
                if (invalidDiscovery) {
                    const prop = invalidDiscovery === 'missing-property' ? '' : '<D:lockdiscovery/>';
                    const status = invalidDiscovery === '404-propstat' ? '<D:status>HTTP/1.1 404 Not Found</D:status>' : '';
                    return new Response(`<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop>${prop}</D:prop>${status}</D:propstat></D:response></D:multistatus>`, { status: 207 });
                }
                return new Response(`<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:lockdiscovery>${lockXML(held)}</D:lockdiscovery></D:prop></D:propstat></D:response></D:multistatus>`, { status: 207 });
            }
            if (request.method === 'LOCK') {
                if (deniedStatus) return new Response(null, { status: deniedStatus });
                if (unsupported) return new Response(null, { status: 405 });
                assert.match(request.headers.Timeout, /^Second-(?:5|60)$/);
                if (request.body === undefined) {
                    if (!held || supplied !== held.token) return new Response(null, { status: 412 });
                    held.expires = ttl ? clock + Number(ttl) * 1000 : Infinity;
                    return new Response(lockXML(held), { status: 200,
                        headers: { Timeout: timeout, ...(omitRefreshTokenHeader ? {} : { 'Lock-Token': `<${held.token}>` }) } });
                }
                assert.equal(request.headers.Depth, '0');
                assert.match(request.body, /<d:lockscope><d:exclusive\/><\/d:lockscope>/);
                assert.match(request.body, /<d:locktype><d:write\/><\/d:locktype>/);
                if (held && !secondSucceeds) return new Response(null, { status: 423 });
                const exists = files.has(url);
                const owner = /<d:owner>([^<]+)<\/d:owner>/.exec(request.body)?.[1];
                const fresh = { token: `opaquelocktoken:synthetic-token-${++sequence}`, owner,
                    expires: ttl ? clock + Number(ttl) * 1000 : Infinity };
                locks.set(url, fresh);
                if (!exists) files.set(url, '');
                return new Response(lockXML(fresh), { status: exists ? 200 : 201,
                    headers: { 'Lock-Token': `<${fresh.token}>`, Timeout: timeout } });
            }
            if (request.method === 'PUT') {
                if (supplied && supplied !== held?.token && !(ignoreWrongToken && held) && !(!held && acceptOldToken)) return new Response(null, { status: 412 });
                if (!supplied && held && !ignoreUnqualified) return new Response(null, { status: 423 });
                const existed = files.has(url);
                files.set(url, request.body);
                appliedWrites.push({ url, body: request.body });
                return new Response(null, { status: existed ? 204 : 201 });
            }
            if (request.method === 'UNLOCK') {
                const token = request.headers['Lock-Token']?.replace(/^<|>$/g, '');
                if (!held || token !== held.token) return new Response(null, { status: 409 });
                locks.delete(url);
                return new Response(null, { status: 204 });
            }
            if (request.method === 'DELETE') {
                if (held) return new Response(null, { status: 423 });
                files.delete(url);
                return new Response(null, { status: 204 });
            }
            throw new Error('Unexpected method');
        })();
        if (delayAfter?.method === request.method && delayAfter.at === number) clock += delayAfter.ms;
        if (fails) throw new Error(`${options.password} response-lost-after-success`);
        return response;
    };
    const sleepImpl = async ms => { sleeps.push(ms); clock += ms; };
    return { fetchImpl, sleepImpl, nowImpl: () => clock, files, locks, requests, sleeps, appliedWrites };
}

async function run(mock, extra = {}) {
    const report = await verifyExclusiveLock({ ...options, fetchImpl: mock.fetchImpl, sleepImpl: mock.sleepImpl, nowImpl: mock.nowImpl, ...extra });
    const serialized = JSON.stringify(report);
    for (const secret of [options.username, options.password, 'synthetic-token-', 'Authorization', 'unrelated-private-content', 'request-not-arrived', 'response-lost-after-success']) {
        assert.ok(!serialized.includes(secret), secret);
    }
    assert.deepEqual(Object.keys(report.capabilities), LOCK_CAPABILITY_NAMES);
    assert.ok(Object.values(report.capabilities).every(status => ['passed', 'unsupported', 'inconclusive', 'not-executed'].includes(status)));
    return report;
}

test('独占锁全流程、服务接受TTL实等、首次创建和串行协作合并均通过', async () => {
    const mock = server();
    const report = await run(mock);
    assert.equal(report.outcome, 'passed');
    assert.ok(Object.values(report.capabilities).every(status => status === 'passed'));
    assert.deepEqual(mock.sleeps, [1100]);
    assert.equal(mock.requests.find(request => request.method === 'LOCK').headers.Timeout, 'Second-60');
    assert.equal(mock.requests.filter(request => request.method === 'LOCK' && request.headers.Timeout === 'Second-5').length, 1);
    assert.ok(report.checks.some(check => check.name === 'finite-expiry-wait' && check.acceptedTimeoutSeconds === 1 && check.waitMs === 1100));
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.files.size, 0);
    assert.equal(mock.locks.size, 0);
    const final = mock.appliedWrites.map(write => JSON.parse(write.body)).findLast(body => body.tasks.some(task => task.id === 'client-b'));
    assert.ok(final.tasks.some(task => task.id === 'client-a'));
    assert.ok(final.tasks.some(task => task.id === 'client-b'));
    const refreshed = mock.requests.find(request => request.method === 'LOCK' && request.body === undefined);
    assert.ok(refreshed.headers.If);
    assert.equal(refreshed.headers['Lock-Token'], undefined);
    assert.equal(report.capabilities.responseRecovery, 'passed');
    assert.equal(report.checks.filter(check => /creation-client-[ab]-reads-absent/.test(check.name)).length, 2);
    assert.ok(report.checks.some(check => check.name === 'first-creation-loser-unqualified-write-refused' && check.passed));
    assert.ok(report.checks.some(check => check.name === 'first-creation-loser-wrong-token-refused' && check.passed));
    for (const method of ['lock', 'put', 'unlock']) assert.ok(report.checks.some(check =>
        check.name.includes(method) && check.injection === 'not-sent' && check.passed));
    assert.ok(report.checks.some(check => check.name === 'discarded-put-confirmed-by-readback' && check.injection === 'response-discarded' && check.observedStatus === 204));
});

test('续锁响应没有Lock-Token头时从正文识别原token，不误判失败', async () => {
    const report = await run(server({ omitRefreshTokenHeader: true }));
    assert.equal(report.capabilities.refresh, 'passed');
});

test('LOCK405明确不支持，依赖项不执行但仍独立探测首次创建', async () => {
    const mock = server({ unsupported: true });
    const report = await run(mock);
    assert.equal(report.capabilities.exclusiveLock, 'unsupported');
    assert.equal(report.capabilities.tokenWrite, 'not-executed');
    assert.equal(report.capabilities.lockNullCreation, 'unsupported');
    assert.equal(report.outcome, 'unsupported');
    assert.equal(report.cleanup.removed, true);
    for (let index = 0; index < mock.requests.length; index++) {
        if (mock.requests[index].method === 'LOCK') assert.equal(mock.requests.slice(index + 1).find(request => request.method !== 'LOCK').method, 'GET');
    }
});

for (const [capability, settings] of [
    ['secondClientExcluded', { secondSucceeds: true }],
    ['unqualifiedWriteRejected', { ignoreUnqualified: true }],
    ['invalidTokenWriteRejected', { ignoreWrongToken: true }],
    ['oldTokenRejected', { acceptOldToken: true }],
    ['finiteExpiry', { ignoreExpiry: true }]
]) test(`服务错误行为被检测：${capability}`, async () => {
    const report = await run(server(settings));
    assert.equal(report.capabilities[capability], 'unsupported');
    assert.equal(report.outcome, 'unsupported');
});

for (const timeout of ['Infinite', 'Second-3600']) test(`接受TTL为${timeout}时不使用请求TTL假装过期`, async () => {
    const mock = server({ timeout });
    const report = await run(mock);
    assert.equal(report.capabilities.finiteExpiry, 'not-executed');
    assert.equal(report.capabilities.expiredTokenRejected, 'not-executed');
    assert.equal(report.capabilities.reacquireMerge, 'passed');
    assert.equal(report.capabilities.serialCollaborationMerge, 'passed');
    assert.deepEqual(mock.sleeps, []);
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.cleanup.removed, true);
});

test('缺少实际授予TTL时不把请求期限当锁有效期，不进入锁内写入', async () => {
    const mock = server({ timeout: '' });
    const report = await run(mock);
    assert.equal(report.capabilities.secondClientExcluded, 'inconclusive');
    assert.equal(report.capabilities.tokenWrite, 'not-executed');
    assert.equal(report.capabilities.finiteExpiry, 'not-executed');
    assert.equal(mock.appliedWrites.filter(write => JSON.parse(write.body).revision === 'token-write').length, 0);
    assert.ok(report.checks.some(check => check.reason === 'accepted-timeout-unavailable'));
});

for (const [delayAfter, capability] of [
    [{ method: 'LOCK', at: 1, ms: 1500 }, 'secondClientExcluded'],
    [{ method: 'PUT', at: 2, ms: 1500 }, 'unqualifiedWriteRejected'],
    [{ method: 'PUT', at: 4, ms: 1500 }, 'tokenWrite'],
    [{ method: 'GET', at: 7, ms: 1500 }, 'refresh']
]) test(`实际授予期限耗尽时${capability}记未确认并停止后续锁内写入`, async () => {
    const mock = server({ delayAfter });
    const report = await run(mock);
    assert.equal(report.capabilities[capability], 'inconclusive');
    assert.ok(report.checks.some(check => check.reason === 'accepted-lock-lifetime-exhausted'));
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.cleanup.removed, true);
});

for (const [method, at, capability] of [['LOCK', 1, 'exclusiveLock'], ['PUT', 4, 'tokenWrite'], ['UNLOCK', 2, 'unlock']]) {
    test(`${method}已成功但响应丢失，先核对服务端状态再继续`, async () => {
        const mock = server({ fault: { method, at, applied: true } });
        const report = await run(mock);
        assert.equal(report.capabilities[capability], 'passed');
        assert.equal(report.cleanup.removed, true);
        if (method === 'PUT') assert.equal(mock.appliedWrites.filter(write => JSON.parse(write.body).revision === 'token-write').length, 1);
        if (method === 'LOCK') assert.ok(report.checks.some(check => check.name === 'lost-lock-response-recovered-by-owner'));
        if (method === 'UNLOCK') assert.ok(report.checks.some(check => check.name === 'correct-unlock' && check.recoveredByDiscovery));
    });
    test(`${method}请求未到达，不把状态不明当成功也不盲写`, async () => {
        const mock = server({ fault: { method, at, applied: false } });
        const report = await run(mock);
        assert.equal(report.capabilities[capability], 'inconclusive');
        assert.equal(report.cleanup.removed, true);
        if (method === 'PUT') assert.equal(mock.appliedWrites.filter(write => JSON.parse(write.body).revision === 'token-write').length, 0);
    });
}

test('初始准备PUT响应丢失后按probe正文确认，不重复创建', async () => {
    const mock = server({ fault: { method: 'PUT', at: 1, applied: true } });
    const report = await run(mock);
    assert.equal(report.capabilities.exclusiveLock, 'passed');
    assert.equal(mock.appliedWrites.filter(write => JSON.parse(write.body).revision === 'initial').length, 1);
    assert.equal(report.cleanup.removed, true);
});

test('随机路径已有非本次正文，不写入也不删除该资源', async () => {
    const mock = server({ preexisting: true });
    const report = await run(mock);
    assert.notEqual(report.outcome, 'passed');
    assert.equal(mock.requests.filter(request => ['PUT', 'LOCK', 'UNLOCK', 'DELETE'].includes(request.method)).length, 0);
    assert.equal(report.cleanup.removed, false);
});

test('403只表示权限不足，不能据此判定LOCK不支持', async () => {
    const report = await run(server({ deniedStatus: 403 }));
    assert.equal(report.capabilities.exclusiveLock, 'inconclusive');
    assert.equal(report.capabilities.lockNullCreation, 'inconclusive');
    assert.equal(report.capabilities.responseRecovery, 'not-executed');
    assert.equal(report.outcome, 'inconclusive');
});

test('LOCK501明确不支持，不运行令牌写入或故障注入', async () => {
    const report = await run(server({ deniedStatus: 501 }));
    assert.equal(report.capabilities.exclusiveLock, 'unsupported');
    assert.equal(report.capabilities.responseRecovery, 'not-executed');
});

test('第二客户端LOCK未发送时，不把第一客户端已有token误认作新操作成功', async () => {
    const mock = server({ fault: { method: 'LOCK', at: 2, applied: false } });
    const report = await run(mock);
    assert.equal(report.capabilities.secondClientExcluded, 'inconclusive');
    assert.equal(report.checks.some(check => check.name === 'lost-lock-response-recovered-by-owner'), false);
    assert.equal(report.cleanup.removed, true);
});

test('返回token但XML是共享锁时不能认定独占能力通过', async () => {
    const report = await run(server({ corruptScope: true }));
    assert.equal(report.capabilities.exclusiveLock, 'unsupported');
    assert.notEqual(report.capabilities.lockNullCreation, 'passed');
});

for (const secondSucceeds of [false, true]) test(`owner缺失且Depth为infinity仍诊断互斥行为，第二客户端${secondSucceeds ? '双成功' : '被拒绝'}不使整条路径通过`, async () => {
    const mock = server({ incompleteMetadata: true, secondSucceeds, invalidDiscovery: 'missing-property' });
    const report = await run(mock);
    assert.equal(report.capabilities.lockMetadata, 'unsupported');
    assert.equal(report.capabilities.secondClientExcluded, secondSucceeds ? 'unsupported' : 'passed');
    assert.notEqual(report.outcome, 'passed');
    const metadata = report.checks.find(check => check.name === 'lock-metadata');
    assert.equal(metadata.depth, 'infinity');
    assert.equal(metadata.ownerMatches, false);
    if (!secondSucceeds) {
        assert.equal(report.capabilities.tokenWrite, 'passed');
        assert.equal(report.cleanup.removed, true);
        assert.equal(mock.files.size, 0);
    }
    const creation = report.checks.find(check => check.name === 'first-creation-single-exclusive-owner');
    assert.equal(creation.winnerCount, secondSucceeds ? 2 : 1);
    assert.equal(creation.finalGetStatus, 200);
    assert.equal(creation.finalBodyEmpty, true);
    assert.equal(creation.clientAStatus, 201);
    assert.equal(creation.clientBStatus, secondSucceeds ? 200 : 423);
});

test('不合规owner与缺失discovery不能恢复真实丢失LOCK响应', async () => {
    const mock = server({ incompleteMetadata: true, invalidDiscovery: 'missing-property', fault: { method: 'LOCK', at: 1, applied: true } });
    const report = await run(mock);
    assert.equal(report.capabilities.exclusiveLock, 'inconclusive');
    assert.equal(report.checks.some(check => check.name === 'lost-lock-response-recovered-by-owner'), false);
    assert.equal(report.cleanup.resources[0].removed, false);
});

test('首次创建竞争异常留下本次空资源时，凭确认的独立owner清理而不残留', async () => {
    const mock = server({ secondSucceeds: true });
    const report = await run(mock);
    assert.equal(report.capabilities.lockNullCreation, 'unsupported');
    assert.equal(report.cleanup.removed, true);
    assert.equal(mock.files.size, 0);
});

test('LOCK响应丢失且无法查询归属时报告残留，不盲目删除', async () => {
    const mock = server({ discoveryUnavailable: true, fault: { method: 'LOCK', at: 1, applied: true } });
    const report = await run(mock);
    assert.equal(report.capabilities.exclusiveLock, 'inconclusive');
    assert.equal(report.cleanup.removed, false);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE' && new URL(request.url).pathname === report.cleanup.resources[0].path).length, 0);
});

for (const invalidDiscovery of ['missing-property', '404-propstat']) test(`PROPFIND ${invalidDiscovery}不能确认丢失UNLOCK已完成`, async () => {
    const mock = server({ invalidDiscovery, fault: { method: 'UNLOCK', at: 2, applied: true } });
    const report = await run(mock);
    assert.equal(report.capabilities.unlock, 'inconclusive');
    assert.equal(report.capabilities.oldTokenRejected, 'not-executed');
    assert.equal(report.cleanup.removed, false);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE' && new URL(request.url).pathname === report.cleanup.resources[0].path).length, 0);
});

test('非法端点或目录在任何请求前拒绝', async () => {
    for (const invalid of [{ endpoint: 'http://example.test/dav/' }, { endpoint: 'https://user:secret@example.test/dav/' },
        { directory: '../codex-webdav-preflight' }, { directory: 'todo_data.json' }, { maxExpiryWaitMs: 60001 }]) {
        let called = false;
        await assert.rejects(verifyExclusiveLock({ ...options, ...invalid, fetchImpl: async () => { called = true; } }));
        assert.equal(called, false);
    }
});
