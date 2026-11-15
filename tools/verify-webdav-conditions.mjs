import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const successful = status => status >= 200 && status < 300;
const strongETag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const etagKind = value => value == null ? 'missing' : strongETag(value) ? 'strong' : /^W\/"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? 'weak' : 'invalid';

function targetURL(endpoint, directory, token) {
    const base = new URL(endpoint);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
        throw new Error('endpoint 必须是无凭据、查询参数和片段的 HTTPS 目录地址');
    }
    if (!base.pathname.endsWith('/')) throw new Error('endpoint 必须以 / 结尾');
    const parts = typeof directory === 'string' ? directory.split('/').filter(Boolean) : [];
    if (!directory || directory.startsWith('/') || directory.includes('\\') ||
        parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) ||
        parts.at(-1) !== 'codex-webdav-preflight') {
        throw new Error('测试目录必须是相对路径，且最后一级为 codex-webdav-preflight');
    }
    return new URL(`${parts.join('/')}/probe-${token}.json`, base);
}

/** 只操作本次随机测试文件；请求错误、正文和认证信息均不进入报告。测试目录须预先存在。 */
export async function verifyWebDavConditions({ endpoint, directory, username, password,
    fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof username !== 'string' || !username || username.includes(':') ||
        typeof password !== 'string' || !password) throw new Error('须提供有效的 WebDAV 用户名及密码');
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node 不支持 fetch');
    const token = randomUUID();
    const target = targetURL(endpoint, directory, token);
    const report = { testedAt: new Date().toISOString(), service: target.origin,
        targetPath: target.pathname, credentialType: 'strong-etag', outcome: 'inconclusive',
        checks: [], cleanup: { attempted: false, removed: false } };
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    const content = name => JSON.stringify({ probe: token, revision: name });
    let ownsFile = false;
    let attemptedCreate = false;
    async function request(method, body, conditions = {}) {
        const response = await fetchImpl(target.href, { method, redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Authorization: authorization, 'Cache-Control': 'no-cache',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...conditions },
            ...(body === undefined ? {} : { body }) });
        return { status: response.status, etag: response.headers.get('etag'),
            text: method === 'GET' && successful(response.status) ? await response.text() : '' };
    }
    function check(name, response, passed, details = {}, stopOnFailure = true) {
        report.checks.push({ name, status: response.status, passed, ...details });
        if (!passed && stopOnFailure) {
            report.outcome = successful(response.status) ? 'unsupported' : 'inconclusive';
            throw new Error('PROBE_CHECK_FAILED');
        }
    }
    async function read(name, expected, deferETagRequirement = false) {
        const response = await request('GET');
        check(name, response, response.status === 200 && response.text === expected);
        check(`${name}-etag`, response, strongETag(response.etag), {
            etagPresent: response.etag != null, etagKind: etagKind(response.etag)
        }, !deferETagRequirement);
        return response.etag;
    }
    try {
        const absent = await request('GET');
        check('random-file-is-absent', absent, absent.status === 404);
        attemptedCreate = true;
        const created = await request('PUT', content('initial'), { 'If-None-Match': '*' });
        ownsFile = successful(created.status);
        check('conditional-create', created, successful(created.status));
        const initialETag = await read('create-readback', content('initial'), true);

        const duplicate = await request('PUT', content('must-not-replace'), { 'If-None-Match': '*' });
        check('conditional-create-refuses-existing', duplicate, duplicate.status === 412);
        await read('rejected-create-preserves-body', content('initial'), true);

        // 先独立验证服务器是否执行条件；非法或缺失的返回标签不作为写入凭据。
        const unmatched = await request('PUT', content('must-not-match'), { 'If-Match': `"codex-no-match-${token}"` });
        check('unmatched-valid-etag-refused', unmatched, unmatched.status === 412);
        await read('unmatched-update-preserves-body', content('initial'), true);
        check('strong-etag-required-for-valid-update', { status: 200 }, strongETag(initialETag), {
            etagPresent: initialETag != null, etagKind: etagKind(initialETag)
        });

        const updated = await request('PUT', content('updated'), { 'If-Match': initialETag });
        check('conditional-update', updated, successful(updated.status));
        const updatedETag = await read('update-readback', content('updated'));
        check('etag-changes-with-content', { status: 200 }, initialETag !== updatedETag);
        const stale = await request('PUT', content('stale-must-not-replace'), { 'If-Match': initialETag });
        check('stale-etag-refused', stale, stale.status === 412);
        await read('stale-update-preserves-body', content('updated'));

        const [a, b] = await Promise.all([
            read('client-a-reads-baseline', content('updated')),
            read('client-b-reads-baseline', content('updated'))
        ]);
        check('clients-read-same-etag', { status: 200 }, a === b);
        const writes = await Promise.allSettled([
            request('PUT', content('client-a'), { 'If-Match': a }),
            request('PUT', content('client-b'), { 'If-Match': b })
        ]);
        if (writes.some(result => result.status !== 'fulfilled')) {
            report.checks.push({ name: 'concurrent-writes-complete', status: null, passed: false });
            throw new Error('PROBE_REQUEST_FAILED');
        }
        const responses = writes.map(result => result.value);
        const winner = responses.findIndex(response => successful(response.status));
        responses.forEach((response, index) => report.checks.push({ name: `client-${index ? 'b' : 'a'}-write`, status: response.status,
            passed: index === winner ? successful(response.status) : response.status === 412 }));
        if (responses.filter(response => successful(response.status)).length !== 1 ||
            responses.filter(response => response.status === 412).length !== 1) {
            report.outcome = responses.every(response => successful(response.status)) ? 'unsupported' : 'inconclusive';
            throw new Error('PROBE_CHECK_FAILED');
        }
        await read('concurrent-winner-readback', content(winner ? 'client-b' : 'client-a'));
        report.outcome = 'passed';
    } catch {
        // 不输出底层网络错误，以免其包含服务地址、响应正文或认证信息。
        if (!report.checks.some(item => !item.passed)) report.checks.push({ name: 'request-completed', status: null, passed: false });
    } finally {
        // 创建响应丢失时，只在读回的随机标记确属本次探测时清理。
        if (!ownsFile && attemptedCreate) {
            try {
                const current = await request('GET');
                ownsFile = successful(current.status) && JSON.parse(current.text).probe === token;
            } catch { /* 归属不确定时保留，不删除。 */ }
        }
        if (ownsFile) {
            report.cleanup.attempted = true;
            try {
                const current = await request('GET');
                const owned = successful(current.status) && JSON.parse(current.text).probe === token;
                if (owned) {
                    // 清理仅针对已核对随机标记的本次文件，不据此放宽能力验证要求。
                    report.cleanup.condition = strongETag(current.etag) ? 'strong-etag' : 'exists';
                    const removed = await request('DELETE', undefined, { 'If-Match': strongETag(current.etag) ? current.etag : '*' });
                    report.cleanup.status = removed.status;
                    if (successful(removed.status) || removed.status === 404) {
                        const absent = await request('GET');
                        report.cleanup.verificationStatus = absent.status;
                        report.cleanup.removed = absent.status === 404;
                    }
                }
            } catch { /* 清理失败保留测试文件路径供人工核对。 */ }
        }
        if (attemptedCreate && !report.cleanup.removed) report.cleanup.remainingPath = target.pathname;
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const report = await verifyWebDavConditions({ endpoint: process.env.WEBDAV_ENDPOINT,
            directory: process.env.WEBDAV_PREFLIGHT_DIRECTORY, username: process.env.WEBDAV_USERNAME,
            password: process.env.WEBDAV_PASSWORD });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        process.exitCode = report.outcome === 'passed' && report.cleanup.removed ? 0 : 1;
    } catch {
        process.stderr.write('参数无效：须设置 HTTPS 目录 WEBDAV_ENDPOINT、WEBDAV_USERNAME、WEBDAV_PASSWORD，以及以 codex-webdav-preflight 为末级的相对目录 WEBDAV_PREFLIGHT_DIRECTORY。\n');
        process.exitCode = 2;
    }
}
