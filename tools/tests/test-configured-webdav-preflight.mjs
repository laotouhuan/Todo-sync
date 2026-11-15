import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runConfiguredPreflight } from '../run-configured-webdav-preflight.mjs';

const secret = 'synthetic-password-never-print';
const user = 'synthetic-webdav-user';
const localUsername = 'synthetic-local-user';

function fixture(t, overrides = {}, encrypted = false) {
    const appDirectory = mkdtempSync(join(tmpdir(), 'todo-configured-preflight-'));
    t.after(() => {
        assert.equal(dirname(resolve(appDirectory)), resolve(tmpdir()));
        assert.ok(basename(appDirectory).startsWith('todo-configured-preflight-'));
        rmSync(appDirectory, { recursive: true, force: true });
    });
    let password = secret;
    if (encrypted) {
        const key = createHash('sha256').update('todo-sync-local-credential-protection-v1')
            .update(appDirectory).update(localUsername).digest();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const content = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
        password = 'ENC:' + Buffer.concat([iv, content, cipher.getAuthTag()]).toString('base64');
    }
    const config = { sync_mode: 'webdav', webdav_url: 'https://example.test/dav/',
        webdav_username: user, webdav_password: password,
        webdav_filepath: 'private owner/中文目录/todo_data.json', ...overrides };
    const configPath = join(appDirectory, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    return { appDirectory, configPath, localUsername };
}

function collectionServer({ failCreate = 0, listing = 'empty', failNetwork = false,
    loseCreateResponse = false, retainAfterDelete = false } = {}) {
    const requests = [];
    const directories = new Set();
    let creates = 0;
    const fetchImpl = async (href, request) => {
        const url = new URL(href);
        requests.push({ href, ...request });
        assert.equal(request.redirect, 'error');
        assert.equal(url.origin, 'https://example.test');
        assert.match(url.pathname, /\/todo-sync-probe-[0-9a-f-]+\//);
        assert.ok(!url.pathname.endsWith('/todo_data.json'));
        if (failNetwork) throw new Error(`${secret} ${user} https://private.invalid/failed`);
        if (request.method === 'MKCOL') {
            if (++creates === failCreate) return new Response(null, { status: 403 });
            directories.add(href);
            if (loseCreateResponse) throw new Error('synthetic lost creation response');
            return new Response(null, { status: 201 });
        }
        if (request.method === 'PROPFIND') {
            if (!directories.has(href)) return new Response(null, { status: 404 });
            const response = value => `<d:response><d:href>${value}</d:href></d:response>`;
            const own = listing === 'foreign-origin' ? `https://other.test${url.pathname}` : url.pathname;
            const children = [...directories].filter(path => path !== href && path.startsWith(href));
            let entries = response(own) + children.map(child => response(new URL(child).pathname)).join('');
            if (listing === 'nonempty') entries += response(url.pathname + 'unrelated.json');
            if (listing === 'malformed-child') entries += '<d:response><d:propstat/></d:response>';
            return new Response(`<d:multistatus xmlns:d="DAV:">${entries}</d:multistatus>`, { status: 207 });
        }
        if (request.method === 'DELETE') {
            assert.ok(directories.has(href));
            assert.ok(![...directories].some(child => child !== href && child.startsWith(href)));
            if (!retainAfterDelete) directories.delete(href);
            return new Response(null, { status: 204 });
        }
        throw new Error('Unexpected collection request');
    };
    return { fetchImpl, requests, directories };
}

function successfulProbe(capture = []) {
    return async options => {
        capture.push(options);
        const targetPath = new URL(`${options.directory}/probe-synthetic.json`, options.endpoint).pathname;
        return { testedAt: '2026-11-05T00:00:00Z', service: new URL(options.endpoint).origin,
            targetPath, outcome: 'passed', checks: [], cleanup: { removed: true } };
    };
}

test('加密配置只在内存解密，传输限定同源随机目录，报告不包含凭据或正式路径', async t => {
    const settings = fixture(t, {}, true);
    const before = readFileSync(settings.configPath);
    const mock = collectionServer();
    const captured = [];
    const reportPath = join(settings.appDirectory, 'report.json');
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl,
        verify: successfulProbe(captured), reportPath });
    assert.equal(report.outcome, 'passed');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].password, secret);
    assert.equal(captured[0].username, user);
    assert.equal(captured[0].fetchImpl, mock.fetchImpl);
    assert.equal(captured[0].endpoint, 'https://example.test/dav/private%20owner/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/');
    assert.match(captured[0].directory, /^todo-sync-probe-[0-9a-f-]+\/codex-webdav-preflight$/);
    assert.deepEqual(mock.requests.map(request => request.method), ['MKCOL', 'MKCOL', 'PROPFIND', 'DELETE', 'PROPFIND', 'PROPFIND', 'DELETE', 'PROPFIND']);
    assert.ok(mock.requests.every(request => request.headers.Authorization === `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`));
    assert.equal(mock.directories.size, 0);
    assert.ok(report.collectionCleanup.every(item => item.removed));
    assert.ok(report.collectionCleanup.every(item => item.verificationStatus === 404));
    assert.deepEqual(readFileSync(settings.configPath), before);
    const output = readFileSync(reportPath, 'utf8');
    assert.deepEqual(JSON.parse(output), report);
    for (const privateValue of [secret, user, localUsername, 'private owner', 'private%20owner', 'Authorization', settings.appDirectory]) {
        assert.ok(!output.includes(privateValue), privateValue);
    }
});

test('重复运行使用不同隔离目录', async t => {
    const settings = fixture(t);
    const mock = collectionServer();
    const captured = [];
    for (let i = 0; i < 2; i++) await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe(captured) });
    assert.notEqual(captured[0].directory, captured[1].directory);
    assert.equal(mock.directories.size, 0);
});

test('多机制报告的嵌套资源路径也脱敏，越界路径不进入报告', async t => {
    const settings = fixture(t);
    const mock = collectionServer();
    const verify = async options => {
        const targetPath = new URL(options.directory + '/', options.endpoint).pathname;
        return { ...await successfulProbe()(options), targetPath, mechanisms: {
            lock: { targetPath, cleanup: { resources: [
                { path: targetPath + 'lock-file.json', removed: true },
                { remainingPath: '/private-outside-dir/file.json', removed: false }
            ] } }
        } };
    };
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify });
    assert.match(report.mechanisms.lock.targetPath, /^todo-sync-probe-[0-9a-f-]+\/codex-webdav-preflight\/$/);
    assert.ok(report.mechanisms.lock.cleanup.resources[0].path.endsWith('/lock-file.json'));
    assert.equal(report.mechanisms.lock.cleanup.resources[1].remainingPath, '[outside-isolation]');
    const output = JSON.stringify(report);
    for (const value of ['private owner', 'private%20owner', 'private-outside-dir']) assert.ok(!output.includes(value));
});

test('相对路径穿越和编码穿越被拒绝，查询参数及片段不进入报告', async t => {
    const settings = fixture(t);
    const mock = collectionServer();
    const verify = async options => {
        const root = options.directory.split('/')[0];
        return { ...await successfulProbe()(options), cleanup: { removed: true, resources: [
            { path: `${root}/../../private-owner/file.json` },
            { path: `${root}/%2e%2e/private-owner/file.json` },
            { path: `${options.directory}/file.json?secret=sensitive-query#sensitive-fragment` }
        ] } };
    };
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify });
    assert.equal(report.cleanup.resources[0].path, '[outside-isolation]');
    assert.equal(report.cleanup.resources[1].path, '[outside-isolation]');
    assert.ok(report.cleanup.resources[2].path.endsWith('/file.json'));
    const output = JSON.stringify(report);
    for (const value of ['private-owner', 'sensitive-query', 'sensitive-fragment', '?', '#']) assert.ok(!output.includes(value));
});

test('集合创建成功但响应丢失时报告未知归属路径，不强制删除', async t => {
    const settings = fixture(t);
    const mock = collectionServer({ loseCreateResponse: true });
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe() });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(mock.directories.size, 1);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
    assert.equal(report.collectionCleanup.length, 1);
    assert.equal(report.collectionCleanup[0].created, false);
    assert.equal(report.collectionCleanup[0].removed, false);
    assert.equal(report.collectionCleanup[0].reason, 'creation-not-confirmed');
    assert.match(report.collectionCleanup[0].remainingPath, /^todo-sync-probe-[0-9a-f-]+\/$/);
});

test('集合DELETE返回成功但目录仍存在时不得报告清理成功', async t => {
    const settings = fixture(t);
    const mock = collectionServer({ retainAfterDelete: true });
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe() });
    assert.equal(report.collectionCleanup[0].status, 204);
    assert.equal(report.collectionCleanup[0].verificationStatus, 207);
    assert.equal(report.collectionCleanup[0].removed, false);
    assert.ok(report.collectionCleanup.every(item => !item.removed));
    assert.equal(mock.directories.size, 2);
});

for (const failCreate of [1, 2]) test(`第${failCreate}次MKCOL失败不触碰正式文件且只清理本次已创建目录`, async t => {
    const settings = fixture(t);
    const mock = collectionServer({ failCreate });
    const captured = [];
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe(captured) });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(captured.length, 0);
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, failCreate - 1);
    assert.equal(mock.directories.size, 0);
    assert.equal(report.setup.at(-1).status, 403);
});

for (const listing of ['nonempty', 'malformed-child', 'foreign-origin']) test(`${listing}列表不能证明目录为空，不发送递归DELETE`, async t => {
    const settings = fixture(t);
    const mock = collectionServer({ listing });
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe() });
    assert.equal(mock.requests.filter(request => request.method === 'DELETE').length, 0);
    assert.equal(mock.directories.size, 2);
    assert.ok(report.collectionCleanup.every(item => !item.removed));
});

test('网络错误不泄露认证信息或底层错误正文', async t => {
    const settings = fixture(t);
    const mock = collectionServer({ failNetwork: true });
    const report = await runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe() });
    assert.equal(report.outcome, 'inconclusive');
    const output = JSON.stringify(report);
    for (const value of [secret, user, 'private.invalid', 'Authorization']) assert.ok(!output.includes(value));
    assert.equal(report.collectionCleanup.length, 1);
    assert.equal(report.collectionCleanup[0].removed, false);
    assert.equal(report.collectionCleanup[0].reason, 'creation-not-confirmed');
});

test('既有报告不覆盖，失败发生在任何网络请求之前', async t => {
    const settings = fixture(t);
    const reportPath = join(settings.appDirectory, 'report.json');
    writeFileSync(reportPath, 'existing-evidence');
    const mock = collectionServer();
    await assert.rejects(runConfiguredPreflight({ ...settings, reportPath, fetchImpl: mock.fetchImpl, verify: successfulProbe() }),
        { message: 'PREFLIGHT_CONFIGURATION_OR_REPORT_UNAVAILABLE' });
    assert.equal(readFileSync(reportPath, 'utf8'), 'existing-evidence');
    assert.equal(mock.requests.length, 0);
});

for (const overrides of [
    { webdav_url: 'http://example.test/dav/' },
    { webdav_url: `https://${user}:${secret}@example.test/dav/` },
    { webdav_url: `https://example.test/dav/?secret=${secret}` },
    { webdav_url: `https://example.test/dav/#${secret}` },
    { webdav_filepath: '../todo_data.json' },
    { webdav_filepath: '/todo_data.json' },
    { webdav_filepath: 'private\\folder/todo_data.json' },
    { sync_mode: 'local' },
    { webdav_username: 'invalid:user' },
    { webdav_password: 'ENC:not-valid-ciphertext' }
]) test(`配置不符合隔离要求时不联网：${Object.keys(overrides)[0]} ${JSON.stringify(overrides).length}`, async t => {
    const settings = fixture(t, overrides);
    const mock = collectionServer();
    await assert.rejects(runConfiguredPreflight({ ...settings, fetchImpl: mock.fetchImpl, verify: successfulProbe() }),
        { message: 'PREFLIGHT_CONFIGURATION_OR_REPORT_UNAVAILABLE' });
    assert.equal(mock.requests.length, 0);
});
