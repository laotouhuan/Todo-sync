import { directoryNames } from '../../windows/src/recordDavListing.js';
import { decode, hash } from './codec.mjs';

const HASH = '[0-9a-f]{64}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RECORD = new RegExp(`^records/${UUID}\\.${HASH}\\.json$`);
const ARTIFACT = new RegExp(`^(?:baseline\\.${HASH}\\.json|dataset\\.${HASH}\\.json|records/${UUID}\\.${HASH}\\.json)$`);
const fail = code => { throw new Error(code); };
const success = status => status >= 200 && status < 300;

/** 只访问预建隔离目录；字节的规范编码及封装验证由独立实验 client 执行。 */
export function createWebDavTransport({ endpoint, directory, username, password, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    let collection;
    try {
        const base = new URL(endpoint), parts = directory.split('/');
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') ||
            parts.at(-1) !== 'codex-webdav-preflight' || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) ||
            typeof username !== 'string' || !username || username.includes(':') || typeof password !== 'string' || !password || typeof fetchImpl !== 'function') fail('INVALID_CONFIGURATION');
        collection = new URL(parts.join('/') + '/', base);
    } catch { fail('INVALID_TRANSPORT_CONFIGURATION'); }
    const recordsURL = new URL('records/', collection);
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    const tracked = new Map(), requests = [];
    let recordsAttempted = false, recordsOwned = false;
    function target(name) {
        if (typeof name !== 'string' || !ARTIFACT.test(name)) fail('INVALID_ARTIFACT_PATH');
        return new URL(name, collection);
    }
    async function request(url, method, body, headers = {}) {
        try {
            const response = await fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { Authorization: authorization, 'Cache-Control': 'no-cache', ...headers,
                    ...(body === undefined ? {} : { 'Content-Type': method === 'PROPFIND' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8' }) },
                ...(body === undefined ? {} : { body }) });
            requests.push({ method, status: response.status });
            return response;
        } catch { requests.push({ method, status: null }); fail('WEBDAV_REQUEST_UNCONFIRMED'); }
    }
    async function bytes(response) {
        try { return Buffer.from(await response.arrayBuffer()); }
        catch { fail('WEBDAV_BODY_UNCONFIRMED'); }
    }
    async function discard(response) { try { await response.body?.cancel(); } catch { /* 状态证据仍保留。 */ } }
    const propfind = (url, depth) => request(url, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', { Depth: depth });
    async function listing() {
        const response = await propfind(recordsURL, '1');
        if (response.status !== 207) { await discard(response); fail(`WEBDAV_LIST_HTTP_${response.status}`); }
        let xml;
        try { xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await bytes(response)); }
        catch { fail('INVALID_DIRECTORY_UTF8'); }
        return directoryNames(xml, recordsURL);
    }
    async function read(name) {
        const response = await request(target(name), 'GET');
        if (response.status === 404) { await discard(response); return null; }
        if (response.status !== 200) { await discard(response); fail(`WEBDAV_READ_HTTP_${response.status}`); }
        return bytes(response);
    }
    return {
        get tracked() { return new Map([...tracked].map(([name, value]) => [name, Buffer.from(value)])); },
        get requests() { return requests.map(value => ({ ...value })); },
        async ensureRecords() {
            if (recordsOwned) return;
            if (recordsAttempted) fail('RECORDS_COLLECTION_OWNERSHIP_UNCONFIRMED');
            recordsAttempted = true;
            const response = await request(recordsURL, 'MKCOL');
            recordsOwned = response.status === 201;
            await discard(response);
            if (!recordsOwned) fail(`WEBDAV_COLLECTION_HTTP_${response.status}`);
        },
        list: listing,
        read,
        async write(name, value, { conditionalCreate = false } = {}) {
            target(name);
            if (!(value instanceof Uint8Array)) fail('EXPECTED_ARTIFACT_BYTES');
            const fixed = Buffer.from(value), previous = tracked.get(name);
            if (previous && !previous.equals(fixed)) fail('ARTIFACT_CONTENT_CONFLICT');
            if (conditionalCreate && (!RECORD.test(name) || name !== `records/${decode(fixed).id}.${hash(fixed)}.json`)) {
                fail('RECORD_FILENAME_HASH_MISMATCH');
            }
            // 在发送前保留固定字节，响应丢失也能按本次内容核对和拆除隔离资源。
            tracked.set(name, fixed);
            const response = await request(target(name), 'PUT', Buffer.from(fixed),
                conditionalCreate ? { 'If-None-Match': '*' } : {});
            await discard(response);
            if (!success(response.status) && !(conditionalCreate && response.status === 412)) fail(`WEBDAV_WRITE_HTTP_${response.status}`);
            return response.status;
        },
        async cleanup() {
            const resources = [];
            for (const [name, expected] of tracked) {
                const url = target(name), item = { path: url.pathname, removed: false };
                try {
                    const current = await read(name);
                    if (current === null) { item.removed = true; item.verificationStatus = 404; }
                    else if (!current.equals(expected)) item.reason = 'fixed-content-not-confirmed';
                    else {
                        const removed = await request(url, 'DELETE', undefined, { 'If-Match': '*' });
                        item.status = removed.status; await discard(removed);
                        const verification = await request(url, 'GET');
                        item.verificationStatus = verification.status; await discard(verification);
                        item.removed = (success(removed.status) || removed.status === 404) && verification.status === 404;
                    }
                } catch { item.reason = 'cleanup-not-confirmed'; }
                if (!item.removed) item.remainingPath = item.path;
                resources.push(item);
            }
            if (recordsAttempted) {
                const item = { path: recordsURL.pathname, removed: false, created: recordsOwned };
                try {
                    const initial = await propfind(recordsURL, '0');
                    const status = initial.status; await discard(initial);
                    if (status === 404) { item.removed = true; item.verificationStatus = 404; }
                    else if (recordsOwned && resources.every(item => item.removed) && (await listing()).length === 0) {
                        const removed = await request(recordsURL, 'DELETE');
                        item.status = removed.status; await discard(removed);
                        const verification = await propfind(recordsURL, '0');
                        item.verificationStatus = verification.status; await discard(verification);
                        item.removed = (success(removed.status) || removed.status === 404) && verification.status === 404;
                    }
                } catch { item.reason = 'collection-cleanup-not-confirmed'; }
                if (!item.removed) { item.remainingPath = item.path; item.reason ||= recordsOwned ? 'collection-not-confirmed-empty-or-removed' : 'collection-ownership-unconfirmed'; }
                resources.push(item);
            }
            return { removed: resources.every(item => item.removed), resources };
        }
    };
}
