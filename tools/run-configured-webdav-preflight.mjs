import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyWebDavConditions } from './verify-webdav-conditions.mjs';
import { verifyWebDavExtended } from './verify-webdav-extended.mjs';

// 多机制报告中的资源路径同样脱敏，不保留正式待办所在父目录。
function redactProbePaths(value, base, parent, isolated, key = '') {
    if (Array.isArray(value)) return value.map(item => redactProbePaths(item, base, parent, isolated, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([name, item]) => [name, redactProbePaths(item, base, parent, isolated, name)]));
    if (typeof value !== 'string' || !/paths?$/i.test(key)) return value;
    try {
        const url = new URL(value, parent);
        if (url.origin === base.origin && url.pathname.startsWith(isolated.pathname)) return url.pathname.slice(parent.pathname.length);
    } catch { /* 不能证明属于本次隔离目录的路径不进入报告。 */ }
    return '[outside-isolation]';
}

// 凭据仅在内存解密；测试目录与正式数据文件隔离，不改写应用配置。
async function runConfigured({ appDirectory = join(process.env.APPDATA, 'com.todo.desktop'),
    localUsername = process.env.USERNAME, fetchImpl = globalThis.fetch,
    verify, extended = false, reportPath } = {}) {
    const verification = verify || (extended ? verifyWebDavExtended : verifyWebDavConditions);
    const config = JSON.parse(readFileSync(join(appDirectory, 'config.json'), 'utf8'));
    if (config.sync_mode !== 'webdav') throw new Error('INVALID_CONFIGURATION');
    let password = config.webdav_password;
    if (password?.startsWith('ENC:')) {
        const key = createHash('sha256').update('todo-sync-local-credential-protection-v1')
            .update(appDirectory).update(localUsername).digest();
        const packed = Buffer.from(password.slice(4), 'base64');
        if (packed.length < 28) throw new Error('INVALID_CIPHERTEXT');
        const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12), { authTagLength: 16 });
        decipher.setAuthTag(packed.subarray(-16));
        password = Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString('utf8');
    }
    if (typeof password !== 'string' || !password || typeof config.webdav_username !== 'string' ||
        !config.webdav_username || config.webdav_username.includes(':')) throw new Error('INVALID_CREDENTIALS');
    if (typeof fetchImpl !== 'function' || typeof verification !== 'function') throw new Error('INVALID_TRANSPORT');
    const base = new URL(config.webdav_url);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('INVALID_ENDPOINT');
    base.pathname = base.pathname.replace(/\/?$/, '/');
    const parts = (config.webdav_filepath || '我的坚果云/to-do/todo_data.json').split('/');
    parts.pop();
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('INVALID_PARENT');
    const parent = new URL(parts.length ? parts.map(encodeURIComponent).join('/') + '/' : '', base);
    const randomName = `todo-sync-probe-${randomUUID()}`;
    const isolated = new URL(randomName + '/', parent);
    const directory = new URL('codex-webdav-preflight/', isolated);
    if ([parent, isolated, directory].some(url => url.origin !== base.origin) ||
        !isolated.pathname.startsWith(parent.pathname) || !directory.pathname.startsWith(isolated.pathname)) {
        throw new Error('INVALID_ISOLATION');
    }
    const authorization = `Basic ${Buffer.from(`${config.webdav_username}:${password}`).toString('base64')}`;
    const attemptedCollections = [];
    const setup = [];
    const cleanup = [];
    // 请求前独占创建报告文件；同名报告已存在时不发网络请求，也不覆盖既有证据。
    const reportFile = reportPath ? openSync(resolve(reportPath), 'wx') : undefined;
    let report;
    async function request(url, method, body, headers = {}) {
        return fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { Authorization: authorization, Depth: '1', ...(body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}), ...headers }, body });
    }
    try {
        for (const url of [isolated, directory]) {
            const attempt = { url, created: false };
            attemptedCollections.push(attempt);
            const response = await request(url, 'MKCOL');
            setup.push({ operation: 'create-isolated-collection', status: response.status });
            attempt.created = response.status === 201;
            await response.body?.cancel();
            if (response.status !== 201) throw new Error('COLLECTION_NOT_CREATED');
        }
        report = await verification({ endpoint: parent.href,
            directory: `${randomName}/codex-webdav-preflight`, username: config.webdav_username, password, fetchImpl });
        // 报告只保留本次随机目录，不记录用户的正式数据所在路径。
        report = redactProbePaths(report, base, parent, isolated);
    } catch {
        report = { testedAt: new Date().toISOString(), service: base.origin, outcome: 'inconclusive', checks: [], cleanup: { removed: false } };
    } finally {
        // WebDAV 的集合 DELETE 可递归删除；先列出目录，只有确认为空的本次目录才删除。
        for (const attempt of [...attemptedCollections].reverse()) {
            const { url } = attempt;
            let removed = false;
            let status = null;
            let verificationStatus = null;
            try {
                const listing = await request(url, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>');
                const xml = await listing.text();
                const hrefs = [...xml.matchAll(/<(?:[\w.-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?href>/gi)].map(match => match[1]);
                const responses = [...xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>/gi)];
                const closedResponses = [...xml.matchAll(/<\/(?:[\w.-]+:)?response\s*>/gi)];
                const self = value => {
                    const candidate = new URL(value, url);
                    return candidate.origin === url.origin && !candidate.search && !candidate.hash &&
                        decodeURIComponent(candidate.pathname).replace(/\/$/, '') === decodeURIComponent(url.pathname).replace(/\/$/, '');
                };
                if (listing.status === 404) {
                    removed = true;
                    verificationStatus = 404;
                } else if (attempt.created && listing.status === 207 && !/<!DOCTYPE|<!ENTITY/i.test(xml) &&
                    responses.length === 1 && closedResponses.length === 1 && hrefs.length === 1 && self(hrefs[0])) {
                    const response = await request(url, 'DELETE');
                    status = response.status;
                    await response.body?.cancel();
                    const verification = await request(url, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', { Depth: '0' });
                    verificationStatus = verification.status;
                    await verification.body?.cancel();
                    removed = (status >= 200 && status < 300 || status === 404) && verificationStatus === 404;
                }
            } catch { /* 不输出底层错误；无法确认目录为空时保留。 */ }
            const path = url === directory ? `${randomName}/codex-webdav-preflight/` : `${randomName}/`;
            cleanup.push({ path, created: attempt.created, removed, status, verificationStatus,
                ...(!removed ? { remainingPath: path, reason: attempt.created ? 'cleanup-not-confirmed' : 'creation-not-confirmed' } : {}) });
        }
    }
    report.setup = setup;
    report.collectionCleanup = cleanup;
    const output = JSON.stringify(report, null, 2) + '\n';
    if (reportFile !== undefined) {
        try { writeFileSync(reportFile, output); }
        finally { closeSync(reportFile); }
    }
    return report;
}

export async function runConfiguredPreflight(options) {
    try { return await runConfigured(options); }
    catch { throw new Error('PREFLIGHT_CONFIGURATION_OR_REPORT_UNAVAILABLE'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv[2] !== '--execute') {
        console.log('用法：node tools/run-configured-webdav-preflight.mjs --execute [--extended] [报告JSON路径]');
    } else {
        try {
            const extended = process.argv[3] === '--extended';
            const report = await runConfiguredPreflight({ extended, reportPath: process.argv[extended ? 4 : 3] });
            console.log(JSON.stringify(report, null, 2) + '\n');
            process.exitCode = report.outcome === 'passed' && report.cleanup.removed && report.collectionCleanup.every(item => item.removed) ? 0 : 1;
        } catch {
            console.error('验证未完成：配置、凭据、网络连接或报告文件不可用。未输出凭据或底层错误正文。');
            process.exitCode = 1;
        }
    }
}
