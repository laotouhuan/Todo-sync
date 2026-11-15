import { encode, decode, hash } from './codec.mjs';
import { validateJoin } from './envelope.mjs';
import { NOTE_PROFILE, captureProfile } from './operation-profile.mjs';

const copy = value => structuredClone(value);
const digestPattern = /^[0-9a-f]{64}$/;
const datasetPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validatePin(pin) {
    if (!pin || Object.keys(pin).length !== 5 || pin.protocol !== 'todo-record-sync/1' || typeof pin.dataset_id !== 'string' || !datasetPattern.test(pin.dataset_id) ||
        typeof pin.descriptor_sha256 !== 'string' || !digestPattern.test(pin.descriptor_sha256) || typeof pin.baseline_sha256 !== 'string' || !digestPattern.test(pin.baseline_sha256) ||
        pin.namespace !== `record-sync/${pin.dataset_id}/`) throw new Error('INVALID_INITIALIZATION_PIN');
    return decode(encode(pin));
}

function fixedArtifact(artifact, prefix, expectedHash) {
    if (!artifact || !Buffer.isBuffer(artifact.bytes) || artifact.name !== `${prefix}.${expectedHash}.json` ||
        artifact.sha256 !== expectedHash || hash(artifact.bytes) !== expectedHash) throw new Error('INVALID_INITIALIZATION_ARTIFACT');
    const value = decode(artifact.bytes);
    if (Object.hasOwn(artifact, 'value') && !encode(artifact.value).equals(artifact.bytes)) throw new Error('INVALID_INITIALIZATION_ARTIFACT');
    return { name: artifact.name, sha256: expectedHash, bytes_base64: Buffer.from(encode(value)).toString('base64') };
}

function freezeDataset(dataset, profile) {
    const pin = validatePin(dataset?.pin);
    const baseline = fixedArtifact(dataset.baseline, 'baseline', pin.baseline_sha256);
    const descriptor = fixedArtifact(dataset.descriptor, 'dataset', pin.descriptor_sha256);
    validateJoin(pin, Buffer.from(descriptor.bytes_base64, 'base64'), Buffer.from(baseline.bytes_base64, 'base64'), profile);
    return { pin, baseline, descriptor };
}

function storedDataset(fixed, profile) {
    if (!fixed || !fixed.baseline || !fixed.descriptor) throw new Error('INVALID_INITIALIZATION_STATE');
    const artifact = value => {
        if (typeof value.bytes_base64 !== 'string' || Buffer.from(value.bytes_base64, 'base64').toString('base64') !== value.bytes_base64) {
            throw new Error('INVALID_INITIALIZATION_STATE');
        }
        return { name: value.name, sha256: value.sha256, bytes: Buffer.from(value.bytes_base64, 'base64') };
    };
    return freezeDataset({ pin: fixed.pin, baseline: artifact(fixed.baseline), descriptor: artifact(fixed.descriptor) }, profile);
}

function validateState(state, profile) {
    if (!state || state.kind !== 'record-sync-initialization-lab/1' ||
        ['baseline_verified', 'descriptor_publish_attempted', 'descriptor_verified', 'invite_exposed', 'cancelled'].some(key => typeof state[key] !== 'boolean') ||
        state.descriptor_publish_attempted && !state.baseline_verified ||
        state.descriptor_verified && !state.descriptor_publish_attempted ||
        state.invite_exposed && !state.descriptor_verified ||
        state.cancelled && (state.descriptor_publish_attempted || state.invite_exposed)) throw new Error('INVALID_INITIALIZATION_STATE');
    return { ...copy(state), fixed: storedDataset(state.fixed, profile) };
}

/** 单个发起端独占一个本地store；这里只模拟状态事务，不操作文件或真实网络。 */
export async function openInitialization({ dataset, store, transport, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    // 在第一次await之前复制全部固定字节，调用者随后修改输入不能改变迁移意图。
    const requested = dataset === undefined ? null : freezeDataset(dataset, profile);
    let state = await store.load();
    if (state === null) {
        if (requested === null) throw new Error('INITIALIZATION_DATASET_REQUIRED');
        const initial = { kind: 'record-sync-initialization-lab/1', fixed: requested, baseline_verified: false,
            descriptor_publish_attempted: false, descriptor_verified: false, invite_exposed: false, cancelled: false };
        await store.save(copy(initial));
        state = initial;
    } else state = validateState(state, profile);
    if (requested !== null && !encode(requested).equals(encode(state.fixed))) throw new Error('INITIALIZATION_INTENT_MISMATCH');
    const identity = encode(state.fixed);
    let queue = Promise.resolve();
    function enqueue(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    async function reload() {
        const latest = validateState(await store.load(), profile);
        if (!encode(latest.fixed).equals(identity)) throw new Error('INITIALIZATION_INTENT_MISMATCH');
        if (['baseline_verified', 'descriptor_publish_attempted', 'descriptor_verified', 'invite_exposed', 'cancelled']
            .some(key => state[key] && !latest[key])) throw new Error('INITIALIZATION_STATE_REGRESSION');
        state = latest;
    }
    async function persist(fields) {
        const next = validateState({ ...copy(state), ...fields }, profile);
        await store.save(copy(next));
        state = next;
    }
    function requireOpen() { if (state.cancelled) throw new Error('INITIALIZATION_CANCELLED'); }
    async function read(name) {
        let bytes;
        try { bytes = await transport.read(name); }
        catch { throw new Error('INITIALIZATION_READ_UNCONFIRMED'); }
        if (bytes !== null && !Buffer.isBuffer(bytes)) throw new Error('INVALID_INITIALIZATION_RESPONSE');
        return bytes === null ? null : Buffer.from(bytes);
    }
    async function ensure(artifact) {
        const expected = Buffer.from(artifact.bytes_base64, 'base64');
        const previous = await read(artifact.name);
        if (previous !== null) {
            if (!previous.equals(expected)) throw new Error('INITIALIZATION_REMOTE_CONFLICT');
            return;
        }
        try { await transport.write(artifact.name, Buffer.from(expected)); }
        catch { throw new Error('INITIALIZATION_WRITE_UNCONFIRMED'); }
        const confirmed = await read(artifact.name);
        if (confirmed === null) throw new Error('INITIALIZATION_NOT_VISIBLE');
        if (!confirmed.equals(expected)) throw new Error('INITIALIZATION_REMOTE_CONFLICT');
    }
    return {
        publish: () => enqueue(async () => {
            await reload();
            requireOpen();
            await ensure(state.fixed.baseline);
            if (!state.baseline_verified) await persist({ baseline_verified: true });
            // 这次尝试标志在任何descriptor请求之前落盘；结果未知或404都不能清除它。
            if (!state.descriptor_publish_attempted) await persist({ descriptor_publish_attempted: true });
            await ensure(state.fixed.descriptor);
            if (!state.descriptor_verified) await persist({ descriptor_verified: true });
            return { status: 'descriptor-verified', canExposeInvite: true };
        }),
        exposeInvite: () => enqueue(async () => {
            await reload();
            requireOpen();
            if (!state.descriptor_verified) throw new Error('INITIALIZATION_NOT_PUBLISHED');
            // 不从publish返回邀请；只有暴露证据落盘成功后此方法才返回pin。
            if (!state.invite_exposed) await persist({ invite_exposed: true });
            return copy(state.fixed.pin);
        }),
        cancel: options => {
            const quiescent = options?.quiescent === true;
            return enqueue(async () => {
                await reload();
                if (!quiescent || state.descriptor_publish_attempted || state.invite_exposed) throw new Error('INITIALIZATION_UNSAFE_CANCEL');
                if (!state.cancelled) await persist({ cancelled: true });
                return { status: 'cancelled', remoteCleanupPerformed: false };
            });
        },
        state: () => copy(state)
    };
}

/** 加入只读取明确pin的两个对象，不枚举目录、不寻找最新descriptor，也不发布任何文件。 */
export async function readPinnedDataset({ pin, transport, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    const fixed = validatePin(pin);
    let descriptorBytes, baselineBytes;
    try {
        descriptorBytes = await transport.read(`dataset.${fixed.descriptor_sha256}.json`);
        baselineBytes = await transport.read(`baseline.${fixed.baseline_sha256}.json`);
    } catch { throw new Error('INITIALIZATION_READ_UNCONFIRMED'); }
    if (!Buffer.isBuffer(descriptorBytes) || !Buffer.isBuffer(baselineBytes)) throw new Error('INITIALIZATION_JOIN_UNCONFIRMED');
    return validateJoin(fixed, Buffer.from(descriptorBytes), Buffer.from(baselineBytes), profile);
}
