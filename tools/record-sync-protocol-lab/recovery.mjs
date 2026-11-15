import { hash, validateUnicode } from './codec.mjs';
import { validateJoin, verifyRecord, inspect } from './envelope.mjs';
import { NOTE_PROFILE, captureProfile } from './operation-profile.mjs';

const FORMAT = 'record-sync-recovery-lab/1';
const NAME = /^records\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}\.json$/;
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && NAME.test(value);
const unique = values => [...new Set(values)];

// 包的总大小可以超过单个协议对象的1MiB限制；逐对象验证原字节，不套用整包encode上限。
function jsonCopy(value, ancestors = new Set()) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return validateUnicode(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value) ||
        ![null, Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))) fail('INVALID_RECOVERY_JSON');
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value') ||
            !descriptor.enumerable && !(Array.isArray(value) && key === 'length')) fail('INVALID_RECOVERY_JSON');
    }
    let result;
    if (Array.isArray(value)) {
        if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail('INVALID_RECOVERY_JSON');
        result = Array.from({ length: value.length }, (_, index) => {
            if (!Object.hasOwn(value, index)) fail('INVALID_RECOVERY_JSON');
            return jsonCopy(value[index], ancestors);
        });
    } else {
        if (Object.getPrototypeOf(value) === Array.prototype) fail('INVALID_RECOVERY_JSON');
        result = Object.create(null);
        for (const key of keys) result[validateUnicode(key)] = jsonCopy(value[key], ancestors);
    }
    ancestors.delete(value);
    return result;
}

// 比较JSON值时仍按键排序，但不限制整个恢复包的字节数。
function key(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(key).join(',') + ']';
    return '{' + Object.keys(value).sort().map(field => JSON.stringify(field) + ':' + key(value[field])).join(',') + '}';
}
const same = (a, b) => key(a) === key(b);
function bytes(base64) {
    if (typeof base64 !== 'string' || Buffer.from(base64, 'base64').toString('base64') !== base64) fail('INVALID_RECOVERY_BASE64');
    return Buffer.from(base64, 'base64');
}

function fixedDataset(dataset, profile) {
    const pin = jsonCopy(dataset?.pin);
    const capture = (artifact, kind, digest) => {
        if (!artifact || !(artifact.bytes instanceof Uint8Array) || artifact.name !== `${kind}.${digest}.json` ||
            artifact.sha256 !== undefined && artifact.sha256 !== digest) fail('INVALID_RECOVERY_DATASET');
        const raw = Buffer.from(artifact.bytes);
        if (hash(raw) !== digest) fail('INVALID_RECOVERY_DATASET');
        return { name: artifact.name, base64: raw.toString('base64') };
    };
    const baseline = capture(dataset.baseline, 'baseline', pin.baseline_sha256);
    const descriptor = capture(dataset.descriptor, 'dataset', pin.descriptor_sha256);
    const joined = validateJoin(pin, bytes(descriptor.base64), bytes(baseline.base64), profile);
    return { fixed: { pin, baseline, descriptor }, joined };
}

function unpackDataset(fixed, profile) {
    if (!object(fixed) || !object(fixed.baseline) || !object(fixed.descriptor)) fail('INVALID_RECOVERY_DATASET');
    return fixedDataset({ pin: fixed.pin, baseline: { name: fixed.baseline.name, bytes: bytes(fixed.baseline.base64) },
        descriptor: { name: fixed.descriptor.name, bytes: bytes(fixed.descriptor.base64) } }, profile);
}

function validateState(input, pin) {
    const state = jsonCopy(input);
    if (!object(state) || state.version !== 1 || !same(state.pin, pin) || !Array.isArray(state.artifacts) ||
        !Array.isArray(state.outbox) || !Array.isArray(state.retryNames) || !Array.isArray(state.faults) || !object(state.view)) fail('INVALID_RECOVERY_STATE');
    for (const item of state.artifacts) {
        if (!object(item) || !name(item.name) || typeof item.base64 !== 'string') fail('INVALID_RECOVERY_STATE');
        bytes(item.base64);
    }
    for (const item of [...state.outbox, ...state.retryNames]) if (!name(item)) fail('INVALID_RECOVERY_STATE');
    for (const fault of state.faults) {
        if (!object(fault) || typeof fault.code !== 'string' || !fault.code || fault.name !== null && typeof fault.name !== 'string') fail('INVALID_RECOVERY_FAULT');
        if (Object.hasOwn(fault, 'base64') && fault.base64 !== null) bytes(fault.base64);
    }
    const names = new Set(state.artifacts.map(item => item.name));
    if (state.outbox.some(item => !names.has(item))) fail('RECOVERY_OUTBOX_MISSING_RECORD');
    return state;
}

function combine(pin, baseline, primary, incoming, profile) {
    const next = jsonCopy(primary), faults = [], knownFaults = new Set(), rows = new Map();
    const addFault = fault => {
        const fingerprint = key(fault);
        if (!knownFaults.has(fingerprint)) { knownFaults.add(fingerprint); faults.push(jsonCopy(fault)); }
    };
    for (const state of [primary, incoming].filter(Boolean)) {
        state.faults.forEach(addFault);
        for (const row of state.artifacts) {
            const previous = rows.get(row.name);
            if (previous && previous.base64 !== row.base64) {
                // 同一路径异常字节都作为证据保存；保留主状态的槽位不代表选它为胜者。
                for (const item of [previous, row]) addFault({ name: item.name, code: 'RECOVERY_PATH_CONTENT_CONFLICT', base64: item.base64 });
            } else if (!previous) rows.set(row.name, jsonCopy(row));
        }
    }
    next.artifacts = [...rows.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    next.outbox = unique([...primary.outbox, ...(incoming?.outbox ?? [])]);
    next.retryNames = unique([...primary.retryNames, ...(incoming?.retryNames ?? [])]);
    const valid = [];
    for (const row of next.artifacts) {
        const raw = bytes(row.base64);
        try { verifyRecord(pin, row.name, raw, profile); valid.push({ name: row.name, bytes: raw }); }
        catch (error) { addFault({ name: row.name, code: error.message, base64: row.base64 }); }
    }
    let inspected = null;
    try { inspected = inspect(pin, valid, profile); }
    catch (error) { addFault({ name: null, code: error.message }); }
    next.faults = faults;
    next.blocked = faults.length > 0 || !inspected?.complete;
    next.reason = faults.length ? 'FAULT' : next.blocked ? 'MISSING_DEPENDENCIES' : null;
    if (inspected) next.retryNames = unique([...next.retryNames, ...inspected.missing.map(parent => `records/${parent.id}.${parent.sha256}.json`)]);
    if (!next.blocked) {
        try { next.view = profile.project(jsonCopy(baseline.data), inspected.ordered); }
        catch (error) {
            addFault({ name: null, code: error.message });
            next.blocked = true;
            next.reason = 'FAULT';
        }
    }
    return { state: next, frontier: { completeness: 'known-only', status: next.reason ?? 'healthy-known-set', heads: inspected?.heads ?? [] } };
}

/** 完整只指打包端已知的记录与本地意图；包内view仅为诊断缓存，不证明远端齐全。 */
export function createRecovery({ dataset, state, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    const { fixed, joined } = fixedDataset(dataset, profile), current = validateState(state, fixed.pin);
    const packed = combine(fixed.pin, joined.baseline, current, undefined, profile);
    return { format: FORMAT, dataset: fixed, frontier: packed.frontier, state: packed.state };
}

/** 纯计算并集，不写store、不接真实迁移；异常时返回冻结状态及全部可用原字节证据。 */
export function restoreRecovery({ dataset, currentState = null, bundle, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    const { fixed, joined } = fixedDataset(dataset, profile), packed = jsonCopy(bundle);
    if (!object(packed) || packed.format !== FORMAT || !object(packed.frontier) || packed.frontier.completeness !== 'known-only') fail('INVALID_RECOVERY_BUNDLE');
    const source = unpackDataset(packed.dataset, profile);
    if (!same(fixed, source.fixed)) fail('RECOVERY_DATASET_MISMATCH');
    const incoming = validateState(packed.state, fixed.pin);
    const checked = combine(fixed.pin, joined.baseline, incoming, undefined, profile);
    if (!same(checked.frontier, packed.frontier)) fail('RECOVERY_FRONTIER_MISMATCH');
    const primary = currentState === null ? { ...jsonCopy(incoming), version: 1, pin: fixed.pin, artifacts: [], outbox: [], retryNames: [], faults: [], view: jsonCopy(joined.baseline.data) }
        : validateState(currentState, fixed.pin);
    return combine(fixed.pin, joined.baseline, primary, incoming, profile).state;
}
