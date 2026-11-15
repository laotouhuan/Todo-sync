import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, realpath, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encode, decode, hash } from './codec.mjs';

const FORMAT = 'record-sync-file-store/1';
const LEASE = 'record-sync-file-store-lease/1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = code => { throw new Error(code); };
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function processAbsent(pid) {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
}
async function readLease(directory) {
    const value = decode(await readFile(join(directory, 'store.lease.json')));
    if (!exact(value, ['format', 'pid', 'token']) || value.format !== LEASE || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        typeof value.token !== 'string' || !UUID.test(value.token)) fail('STORE_LEASE_INVALID');
    return value;
}

/**
 * wx lease只约束遵守规则的单个活动store，不是操作系统flock，也不提供跨设备互斥。
 * 不自动偷取死进程lease；接管必须由唯一协调器确认原worker退出并核对本次token。
 */
export async function recoverStaleLease(directory, { expectedPid, expectedToken }) {
    const root = await realpath(resolve(directory));
    const lease = await readLease(root);
    if (lease.pid !== expectedPid || lease.token !== expectedToken) fail('STORE_LEASE_OWNER_MISMATCH');
    if (!processAbsent(lease.pid)) fail('STORE_LEASE_ACTIVE_OR_UNKNOWN');
    const confirmed = await readLease(root);
    if (confirmed.pid !== expectedPid || confirmed.token !== expectedToken || !processAbsent(expectedPid)) fail('STORE_LEASE_RECOVERY_UNCONFIRMED');
    await unlink(join(root, 'store.lease.json'));
    return { recovered: true };
}

export class FileStore {
    constructor(directory, { onStage = async () => {}, renameImpl = rename } = {}) {
        this.directory = resolve(directory);
        this.onStage = onStage;
        this.renameImpl = renameImpl;
        this.queue = Promise.resolve();
        this.handle = null;
        this.lease = null;
        this.identity = null;
        this.newIdentity = false;
        this.lastRevision = 0;
        this.closing = false;
        this.closed = false;
        this.closePromise = null;
    }
    enqueue(operation) {
        if (this.closed || this.closing) return Promise.reject(new Error('STORE_CLOSED'));
        const result = this.queue.then(operation);
        this.queue = result.catch(() => {});
        return result;
    }
    async prepare() {
        if (this.identity) return;
        await mkdir(this.directory, { recursive: true });
        this.directory = await realpath(this.directory);
        const leasePath = join(this.directory, 'store.lease.json');
        if (!this.handle) {
            let handle;
            try { handle = await open(leasePath, 'wx'); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const lease = await readLease(this.directory);
                fail(processAbsent(lease.pid) ? 'STORE_LEASE_STALE_REQUIRES_RECOVERY' : 'STORE_LEASE_ACTIVE_OR_UNKNOWN');
            }
            const lease = { format: LEASE, pid: process.pid, token: randomUUID() };
            try { await handle.writeFile(encode(lease)); await handle.sync(); }
            catch (error) { await handle.close().catch(() => {}); await unlink(leasePath).catch(() => {}); throw error; }
            this.handle = handle;
            this.lease = lease;
        }
        const identityPath = join(this.directory, 'store.identity.json');
        let identity;
        try { identity = decode(await readFile(identityPath)); }
        catch (error) {
            if (error.code !== 'ENOENT') fail('STORE_IDENTITY_INVALID');
            if (await exists(join(this.directory, 'state.json'))) fail('STORE_IDENTITY_MISSING');
            identity = { format: FORMAT, id: randomUUID() };
            const marker = await open(identityPath, 'wx');
            try { await marker.writeFile(encode(identity)); await marker.sync(); }
            finally { await marker.close(); }
            this.newIdentity = true;
        }
        if (!exact(identity, ['format', 'id']) || identity.format !== FORMAT || typeof identity.id !== 'string' || !UUID.test(identity.id)) fail('STORE_IDENTITY_INVALID');
        this.identity = identity;
    }
    async current() {
        let bytes;
        try { bytes = await readFile(join(this.directory, 'state.json')); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (this.newIdentity && this.lastRevision === 0) return null;
            fail('STORE_STATE_MISSING');
        }
        let envelope;
        try { envelope = decode(bytes); } catch { fail('STORE_STATE_CORRUPT'); }
        if (!exact(envelope, ['format', 'store_id', 'revision', 'sha256', 'state']) || envelope.format !== FORMAT ||
            envelope.store_id !== this.identity.id || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1 ||
            !envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state) ||
            envelope.sha256 !== hash(encode(envelope.state))) fail('STORE_STATE_CORRUPT');
        if (envelope.revision < this.lastRevision) fail('STORE_STATE_REGRESSION');
        this.lastRevision = envelope.revision;
        return envelope;
    }
    load() {
        return this.enqueue(async () => {
            await this.prepare();
            const current = await this.current();
            return current === null ? null : structuredClone(current.state);
        });
    }
    save(state) {
        // 调用时冻结，不能在等待队列或fsync时接受调用方对同一对象的后续修改。
        const fixed = decode(encode(state));
        if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed)) return Promise.reject(new Error('STORE_STATE_INVALID'));
        return this.enqueue(async () => {
            await this.prepare();
            const previous = await this.current();
            const revision = (previous?.revision ?? 0) + 1;
            if (!Number.isSafeInteger(revision)) fail('STORE_REVISION_LIMIT');
            const payloadHash = hash(encode(fixed));
            const bytes = encode({ format: FORMAT, store_id: this.identity.id, revision, sha256: payloadHash, state: fixed });
            const temporaryName = `.state-${randomUUID()}.tmp`;
            const temporary = join(this.directory, temporaryName);
            const details = { revision, payloadHash, temporaryName,
                artifactCount: Array.isArray(fixed.artifacts) ? fixed.artifacts.length : null,
                outboxCount: Array.isArray(fixed.outbox) ? fixed.outbox.length : null };
            let handle;
            try {
                await this.onStage({ ...details, stage: 'before-write' });
                handle = await open(temporary, 'wx');
                await handle.writeFile(bytes);
                await handle.sync();
                await this.onStage({ ...details, stage: 'tmp-fsynced' });
                await handle.close(); handle = null;
                // Windows可能暂时拒绝替换；只重试同一原子rename，绝不先删除旧主文件。
                for (let attempt = 0; ; attempt++) {
                    try { await this.renameImpl(temporary, join(this.directory, 'state.json')); break; }
                    catch (error) {
                        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
                        await delay(25 * 2 ** attempt);
                    }
                }
                this.lastRevision = revision;
                await this.onStage({ ...details, stage: 'renamed' });
            } finally {
                await handle?.close().catch(() => {});
                await unlink(temporary).catch(() => {});
            }
        });
    }
    leaseInfo() { return this.lease === null ? null : { pid: this.lease.pid, token: this.lease.token }; }
    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = (async () => {
            await this.queue;
            try {
                if (this.handle) {
                    const current = await readLease(this.directory);
                    if (current.pid !== this.lease.pid || current.token !== this.lease.token) fail('STORE_LEASE_OWNER_MISMATCH');
                    await unlink(join(this.directory, 'store.lease.json'));
                }
            } finally {
                await this.handle?.close().catch(() => {});
                this.handle = null;
                this.closed = true;
            }
        })();
        return this.closePromise;
    }
}
