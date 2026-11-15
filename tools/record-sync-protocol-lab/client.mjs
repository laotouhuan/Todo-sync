import { encode, decode, hash } from './codec.mjs';
import { validateJoin, createRecord, verifyRecord, inspect } from './envelope.mjs';
import { NOTE_PROFILE, captureProfile } from './operation-profile.mjs';

const copy = value => structuredClone(value);
const NAME = /^records\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}\.json$/;
const validName = name => typeof name === 'string' && NAME.test(name);
const fail = code => { throw new Error(code); };
const row = artifact => ({ name: artifact.name, base64: Buffer.from(artifact.bytes).toString('base64') });
const artifact = entry => ({ name: entry.name, bytes: Buffer.from(entry.base64, 'base64') });
const same = (a, b) => encode(a).equals(encode(b));

// 内存替身验证原子存储接口；不宣称实现真实磁盘或断电保障。
export class MemoryStore {
    constructor(state = null) { this.value = copy(state); }
    async load() { return copy(this.value); }
    async save(state) { this.value = copy(state); }
}

export function memoryTransport(initial = []) {
    const files = new Map(initial.map(item => [item.name, Buffer.from(item.bytes)]));
    return { files, async list() { return [...files.keys()].filter(validName); },
        async read(name) { return files.has(name) ? Buffer.from(files.get(name)) : null; },
        async write(name, bytes) { files.set(name, Buffer.from(bytes)); } };
}

/** 每个store仅一个活动client；实例重开前交还旧实例，不验证多进程共享本地store。 */
export async function openRecordLab({ dataset, store, transport, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    const pin = copy(dataset.pin);
    const joined = validateJoin(pin, dataset.descriptor.bytes, dataset.baseline.bytes, profile);
    function validateStored(candidate) {
        if (!candidate || candidate.version !== 1 || !same(candidate.pin, pin) || !Array.isArray(candidate.artifacts) || !Array.isArray(candidate.outbox) ||
            !Array.isArray(candidate.retryNames) || !Array.isArray(candidate.faults) || !candidate.view || typeof candidate.view !== 'object') fail('LOCAL_STATE_INVALID');
        for (const name of [...candidate.outbox, ...candidate.retryNames]) if (!validName(name)) fail('LOCAL_STATE_INVALID');
        const names = new Set();
        for (const entry of candidate.artifacts) {
            if (!entry || typeof entry.base64 !== 'string' || !validName(entry.name) || names.has(entry.name) ||
                Buffer.from(entry.base64, 'base64').toString('base64') !== entry.base64) fail('LOCAL_STATE_INVALID');
            names.add(entry.name);
        }
        if (candidate.outbox.some(name => !names.has(name))) fail('LOCAL_OUTBOX_MISSING_RECORD');
    }
    let state = await store.load();
    if (state !== null) validateStored(state);
    else {
        state = { version: 1, pin, artifacts: [], outbox: [], retryNames: [], faults: [], view: copy(joined.baseline.data) };
        await store.save(copy(state));
    }
    let queue = Promise.resolve();
    function enqueue(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    function evaluate(next) {
        const result = inspect(pin, next.artifacts.map(artifact), profile);
        if (!result.complete || next.faults.length) return { result, blocked: true, reason: next.faults.length ? 'FAULT' : 'MISSING_DEPENDENCIES' };
        const data = profile.project(copy(joined.baseline.data), result.ordered);
        return { result, blocked: false, data };
    }
    async function install(next) {
        try {
            const evaluated = evaluate(next);
            if (!evaluated.blocked) next.view = evaluated.data;
            next.blocked = evaluated.blocked;
            next.reason = evaluated.reason ?? null;
            next.retryNames = [...new Set([...next.retryNames, ...evaluated.result.missing.map(parent => `records/${parent.id}.${parent.sha256}.json`)])];
        } catch (error) {
            next.blocked = true; next.reason = 'FAULT';
            const code = error.message;
            if (!next.faults.some(fault => fault.code === code && fault.name === null)) next.faults.push({ name: null, code });
        }
        await store.save(copy(next));
        state = next;
    }
    // 重开从记录重验，故障时只保留此前暂时视图，不将缓存认证为权威。
    await install(copy(state));
    async function reload() {
        const latest = await store.load();
        validateStored(latest);
        if (state.artifacts.some(old => !latest.artifacts.some(item => item.name === old.name && item.base64 === old.base64)) ||
            state.faults.some(old => !latest.faults.some(item => same(old, item)))) fail('LOCAL_STATE_REGRESSION');
        // save可能已生效却丢失确认；下一动作先重读，不能用旧内存覆盖已durable记录。
        await install(copy(latest));
    }
    async function fault(name, bytes, code) {
        const next = copy(state);
        const evidence = bytes == null ? null : Buffer.from(bytes).toString('base64');
        if (!next.faults.some(item => item.name === name && item.code === code && item.base64 === evidence)) next.faults.push({ name, code, base64: evidence });
        await install(next);
    }
    async function receive(name, bytes) {
        if (!validName(name)) { await fault(name, bytes, 'INVALID_RECORD_PATH'); return; }
        try { verifyRecord(pin, name, bytes, profile); }
        catch (error) { await fault(name, bytes, error.message); return; }
        const existing = state.artifacts.find(entry => entry.name === name);
        if (existing && existing.base64 !== Buffer.from(bytes).toString('base64')) { await fault(name, bytes, 'REMOTE_CONTENT_CHANGED'); return; }
        const next = copy(state);
        if (!existing) next.artifacts.push(row({ name, bytes }));
        next.retryNames = next.retryNames.filter(item => item !== name);
        await install(next);
    }
    return {
        state: () => copy(state),
        async commit(intent) {
            const frozen = copy(intent);
            return enqueue(async () => {
                await reload();
                if (!frozen || Object.keys(frozen).length !== 4 || !['id', 'actorId', 'createdAt', 'operations'].every(key => Object.hasOwn(frozen, key))) fail('INVALID_COMMIT_INTENT');
                const previous = state.artifacts.map(artifact).find(item => decode(item.bytes).id === frozen.id);
                if (previous) {
                    const value = verifyRecord(pin, previous.name, previous.bytes, profile);
                    if (value.actor_id !== frozen.actorId || value.created_at !== frozen.createdAt || !same(value.operations, frozen.operations)) fail('RECORD_ID_CONTENT_CONFLICT');
                    return row(previous);
                }
                if (state.blocked) fail('DATASET_WRITE_BLOCKED');
                const inspected = inspect(pin, state.artifacts.map(artifact), profile);
                const parents = inspected.heads.map(head => artifact(state.artifacts.find(entry => entry.name === `records/${head.id}.${head.sha256}.json`)));
                const record = createRecord({ pin, id: frozen.id, actorId: frozen.actorId, createdAt: frozen.createdAt, operations: frozen.operations, parents, profile });
                const next = copy(state);
                next.artifacts.push(row(record)); next.outbox.push(record.name);
                // 本地意图先完整预演；业务错误不得持久化成无法撤销的有毒记录。
                const preview = evaluate(next);
                if (preview.blocked) fail('DATASET_WRITE_BLOCKED');
                await install(next);
                return row(record);
            });
        },
        sync() { return enqueue(async () => {
            await reload();
            const report = { listFailure: false, readFailures: [], writeFailures: [], listingCompleteness: 'unknown' };
            let listed;
            try { listed = await transport.list(); }
            catch { report.listFailure = true; listed = []; }
            if (!Array.isArray(listed) || listed.some(name => !validName(name))) {
                await fault(null, null, 'INVALID_DIRECTORY_LIST'); listed = [];
            }
            await install({ ...copy(state), retryNames: [...new Set([...state.retryNames, ...listed])] });
            const attempted = new Set();
            for (let count = 0; count < 256; count++) {
                const name = state.retryNames.find(item => !attempted.has(item));
                if (!name) break;
                attempted.add(name);
                // 先持久化轮转，再发请求；失败前缀和重复列举都不能饿死批次之外的文件。
                await install({ ...copy(state), retryNames: [...state.retryNames.filter(item => item !== name), name] });
                let bytes;
                try { bytes = await transport.read(name); }
                catch { report.readFailures.push(name); continue; }
                if (bytes === null) { report.readFailures.push(name); continue; }
                await receive(name, bytes);
            }
            if (!state.blocked) for (const name of [...state.outbox]) {
                const local = artifact(state.artifacts.find(entry => entry.name === name));
                let remote;
                try {
                    remote = await transport.read(name);
                    if (remote === null) { await transport.write(name, Buffer.from(local.bytes)); remote = await transport.read(name); }
                } catch { report.writeFailures.push(name); continue; }
                if (remote === null) { report.writeFailures.push(name); continue; }
                if (hash(remote) !== hash(local.bytes) || !Buffer.from(remote).equals(local.bytes)) { await fault(name, remote, 'UPLOAD_CONTENT_MISMATCH'); break; }
                await install({ ...copy(state), outbox: state.outbox.filter(item => item !== name) });
            }
            return { ...report, blocked: state.blocked, outbox: [...state.outbox], retryNames: [...state.retryNames], reason: state.reason };
        }); }
    };
}
