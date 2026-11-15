import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, snapshotHash, createRecord, project } from './protocol.mjs';

const copy = value => structuredClone(value);

export class MemoryStore {
    constructor(initial = null) { this.state = copy(initial); }
    async load() { return copy(this.state); }
    async save(state) { this.state = copy(state); }
}

/** 状态、完整记录与待上传集合一次替换；原文件在临时写入失败时保持不变。 */
export class FileStore {
    constructor(directory) { this.directory = directory; this.path = join(directory, 'record-sync-state.json'); }
    async load() {
        try { return JSON.parse(await readFile(this.path, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw new Error('LOCAL_STATE_UNREADABLE'); }
    }
    async save(state) {
        const serialized = canonical(state);
        await mkdir(this.directory, { recursive: true });
        const temporary = join(this.directory, `.record-sync-state-${randomUUID()}.tmp`);
        let handle;
        try {
            handle = await open(temporary, 'wx');
            await handle.writeFile(serialized, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            await rename(temporary, this.path);
        } finally {
            await handle?.close().catch(() => {});
            await unlink(temporary).catch(() => {});
        }
    }
}

/** 每条记录使用唯一身份和冻结字节；多个客户端必须使用不同本地 store。 */
export async function openClient({ snapshot, store, transport }) {
    const base = copy(snapshot);
    const hash = snapshotHash(base);
    const loaded = await store.load();
    if (loaded !== null) {
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) ||
            !Array.isArray(loaded.records) || !Array.isArray(loaded.pendingIds) || !Array.isArray(loaded.downloadRetryIds) ||
            loaded.pendingIds.some(id => typeof id !== 'string' || !id) || loaded.downloadRetryIds.some(id => typeof id !== 'string' || !id)) {
            throw new Error('LOCAL_STATE_INVALID');
        }
        if (loaded.snapshot_hash !== hash || loaded.dataset_id !== base.dataset_id) throw new Error('LOCAL_SNAPSHOT_MISMATCH');
    }
    let state = { snapshot_hash: hash, dataset_id: base.dataset_id ?? null,
        records: copy(loaded?.records || []), pendingIds: [...new Set(loaded?.pendingIds || [])],
        downloadRetryIds: [...new Set(loaded?.downloadRetryIds || [])] };
    if (!Array.isArray(state.records) || state.records.some(record => !record || typeof record.id !== 'string')) throw new Error('LOCAL_STATE_INVALID');
    const restored = new Map();
    for (const record of state.records) {
        if (restored.has(record.id) && canonical(restored.get(record.id)) !== canonical(record)) throw new Error('RECORD_ID_CONTENT_CONFLICT');
        restored.set(record.id, record);
    }
    state.records = [...restored.values()];
    if (state.pendingIds.some(id => !restored.has(id))) throw new Error('LOCAL_OUTBOX_RECORD_MISSING');
    let projection = project(base, copy(state.records));
    let queue = Promise.resolve();
    function enqueue(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    async function install(next) {
        const derived = project(base, copy(next.records));
        await store.save(copy(next));
        state = next;
        projection = derived;
    }
    async function rememberRetry(id) {
        if (!state.downloadRetryIds.includes(id)) await install({ ...copy(state), downloadRetryIds: [...state.downloadRetryIds, id] });
    }
    async function acknowledge(id) {
        if (state.pendingIds.includes(id)) await install({ ...copy(state), pendingIds: state.pendingIds.filter(value => value !== id) });
    }
    function assertSame(local, remote) {
        if (!remote || remote.id !== local.id || canonical(local) !== canonical(remote)) throw new Error('RECORD_ID_CONTENT_CONFLICT');
    }
    const commit = intent => {
        const frozenIntent = copy(intent);
        return enqueue(async () => {
            const existing = state.records.find(record => record.id === frozenIntent.id);
            if (existing) {
                for (const name of ['id', 'actor_id', 'created_at', 'operations']) {
                    if (canonical(existing[name]) !== canonical(frozenIntent[name])) throw new Error('RECORD_ID_CONTENT_CONFLICT');
                }
                return copy(existing);
            }
            const record = createRecord(base, copy(state.records), frozenIntent);
            await install({ ...copy(state), records: [...state.records, copy(record)], pendingIds: [...state.pendingIds, record.id] });
            return copy(record);
        });
    };
    const sync = () => enqueue(async () => {
        const diagnostics = { readFailures: [], writeFailures: [], listFailure: null, uploadedIds: [], downloadedIds: [],
            listingCompleteness: 'unknown' };
        // 上传先核对固定UUID文件；结果不明时保留原提交，下次先读回确认。
        for (const id of [...state.pendingIds]) {
            const local = state.records.find(record => record.id === id);
            let remote;
            try { remote = await transport.read(id); }
            catch { diagnostics.readFailures.push({ id, phase: 'upload-check', reason: 'read-failed' }); continue; }
            if (remote !== null) {
                assertSame(local, remote);
                await acknowledge(id);
                diagnostics.uploadedIds.push(id);
                continue;
            }
            try { await transport.write(id, copy(local)); }
            catch { diagnostics.writeFailures.push({ id, reason: 'write-result-unknown' }); continue; }
            try { remote = await transport.read(id); }
            catch { diagnostics.readFailures.push({ id, phase: 'upload-confirmation', reason: 'read-failed' }); continue; }
            if (remote === null) { diagnostics.readFailures.push({ id, phase: 'upload-confirmation', reason: 'not-visible' }); continue; }
            assertSame(local, remote);
            await acknowledge(id);
            diagnostics.uploadedIds.push(id);
        }
        let listed = [];
        try {
            listed = await transport.list();
            if (!Array.isArray(listed) || listed.some(id => typeof id !== 'string' || !id)) throw new Error('INVALID_LIST');
        } catch { diagnostics.listFailure = 'list-unavailable'; listed = []; }
        for (const id of new Set([...state.downloadRetryIds, ...listed])) {
            let remote;
            try { remote = await transport.read(id); }
            catch {
                diagnostics.readFailures.push({ id, phase: 'download', reason: 'read-failed' });
                await rememberRetry(id);
                continue;
            }
            if (remote === null) {
                diagnostics.readFailures.push({ id, phase: 'download', reason: 'listed-record-unavailable' });
                await rememberRetry(id);
                continue;
            }
            if (remote.id !== id) throw new Error('RECORD_ID_CONTENT_CONFLICT');
            const existing = state.records.find(record => record.id === id);
            if (existing) assertSame(existing, remote);
            const next = { ...copy(state), records: existing ? copy(state.records) : [...state.records, copy(remote)],
                downloadRetryIds: state.downloadRetryIds.filter(value => value !== id) };
            if (!existing || next.downloadRetryIds.length !== state.downloadRetryIds.length) await install(next);
            if (!existing) diagnostics.downloadedIds.push(id);
        }
        return { ...diagnostics, pendingIds: [...state.pendingIds], downloadRetryIds: [...state.downloadRetryIds], projection: copy(projection) };
    });
    return { commit, sync, view: () => copy(projection), records: () => copy(state.records), pendingUploads: () => [...state.pendingIds] };
}
