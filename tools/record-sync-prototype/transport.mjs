import { canonical } from './protocol.mjs';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = value => structuredClone(value);

export function createMemoryTransport(initial = []) {
    const values = new Map(initial.map(record => [record.id, copy(record)]));
    return { async list() { return [...values.keys()]; }, async read(id) { return values.has(id) ? copy(values.get(id)) : null; },
        async write(id, record) { values.set(id, copy(record)); } };
}

function hrefText(text) {
    return text.replace(/&([^;]+);/g, (_match, entity) => {
        const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (Object.hasOwn(known, entity)) return known[entity];
        if (/^#(?:\d+|x[0-9a-f]+)$/i.test(entity)) {
            const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            if (value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) return String.fromCodePoint(value);
        }
        throw new Error('INVALID_DIRECTORY_LIST');
    });
}

/** 只访问预建隔离目录内UUID记录；禁止共享索引、正式数据文件和跨域重定向。 */
export function createWebDavTransport({ endpoint, directory, username, password, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    let collection;
    try {
        const base = new URL(endpoint);
        const parts = directory.split('/');
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') ||
            parts.at(-1) !== 'codex-webdav-preflight' || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) ||
            typeof username !== 'string' || !username || username.includes(':') || typeof password !== 'string' || !password || typeof fetchImpl !== 'function') throw new Error();
        collection = new URL(parts.join('/') + '/', base);
    } catch { throw new Error('INVALID_TRANSPORT_CONFIGURATION'); }
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    function target(id) {
        if (!idPattern.test(id)) throw new Error('INVALID_RECORD_ID');
        return new URL(id + '.json', collection);
    }
    async function request(url, method, body) {
        let response;
        try {
            response = await fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { Authorization: authorization, 'Cache-Control': 'no-cache', ...(method === 'PROPFIND' ? { Depth: '1' } : {}),
                    ...(body === undefined ? {} : { 'Content-Type': method === 'PROPFIND' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8' }) },
                ...(body === undefined ? {} : { body }) });
        } catch { throw new Error('WEBDAV_REQUEST_FAILED'); }
        if (!(response.status >= 200 && response.status < 300) && !(method === 'GET' && response.status === 404)) throw new Error(`WEBDAV_HTTP_${response.status}`);
        return response;
    }
    async function text(response) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()); }
        catch { throw new Error('INVALID_UTF8_RESPONSE'); }
    }
    return {
        async list() {
            const response = await request(collection, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>');
            if (response.status !== 207) throw new Error('INVALID_DIRECTORY_LIST');
            const xml = await text(response);
            if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('INVALID_DIRECTORY_LIST');
            const blocks = [...xml.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi)];
            if (!/<(?:[\w.-]+:)?multistatus\b/i.test(xml) || !/<\/(?:[\w.-]+:)?multistatus\s*>/i.test(xml) ||
                blocks.length !== [...xml.matchAll(/<(?:[\w.-]+:)?response\b/gi)].length ||
                blocks.length !== [...xml.matchAll(/<\/(?:[\w.-]+:)?response\s*>/gi)].length) throw new Error('INVALID_DIRECTORY_LIST');
            const ids = [];
            for (const block of blocks) {
                const hrefs = [...block[1].matchAll(/<(?:[\w.-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?href\s*>/gi)];
                if (hrefs.length !== 1) throw new Error('INVALID_DIRECTORY_LIST');
                let url;
                try { url = new URL(hrefText(hrefs[0][1]), collection); }
                catch { throw new Error('INVALID_DIRECTORY_LIST'); }
                if (url.origin !== collection.origin || url.username || url.password || url.search || url.hash) throw new Error('INVALID_DIRECTORY_LIST');
                let pathname;
                try { pathname = decodeURIComponent(url.pathname); }
                catch { throw new Error('INVALID_DIRECTORY_LIST'); }
                const prefix = decodeURIComponent(collection.pathname);
                if (pathname.replace(/\/$/, '') === prefix.replace(/\/$/, '')) continue;
                if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) throw new Error('INVALID_DIRECTORY_LIST');
                const name = pathname.slice(prefix.length);
                if (name.endsWith('.json') && idPattern.test(name.slice(0, -5))) ids.push(name.slice(0, -5));
            }
            return [...new Set(ids)];
        },
        async read(id) {
            const response = await request(target(id), 'GET');
            if (response.status === 404) return null;
            const bytes = await text(response);
            let record;
            try { record = JSON.parse(bytes); }
            catch { throw new Error('INVALID_RECORD_JSON'); }
            if (canonical(record) !== bytes) throw new Error('NON_CANONICAL_RECORD');
            if (!record || record.id !== id) throw new Error('RECORD_ID_CONTENT_CONFLICT');
            return record;
        },
        async write(id, record) {
            if (!record || record.id !== id) throw new Error('RECORD_ID_CONTENT_CONFLICT');
            await request(target(id), 'PUT', canonical(record));
        }
    };
}
