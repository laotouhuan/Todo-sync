import { encode, decode, hash } from './codec.mjs';
import { NOTE_PROFILE, captureProfile } from './operation-profile.mjs';

// 默认保留合成notes；显式业务profile仍是独立实验，不是已发布协议实现。
export const PROTOCOL = 'todo-record-sync/1';
export const OPERATION_SET = 'lab-note/1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const uuid = value => typeof value === 'string' && UUID.test(value);
const sha = value => typeof value === 'string' && SHA.test(value);
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a, b) => encode(a).equals(encode(b));
function time(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
    if (+value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59 ||
        value.at(-1) !== 'Z' && (+value.slice(-5, -3) > 23 || +value.slice(-2) > 59)) return false;
    const day = value.slice(0, 10), at = Date.parse(day + 'T00:00:00Z');
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day && Number.isFinite(Date.parse(value));
}

export function validatePin(pin) {
    if (!exact(pin, ['protocol', 'dataset_id', 'descriptor_sha256', 'baseline_sha256', 'namespace']) || pin.protocol !== PROTOCOL ||
        !uuid(pin.dataset_id) || !sha(pin.descriptor_sha256) || !sha(pin.baseline_sha256) ||
        pin.namespace !== `record-sync/${pin.dataset_id}/`) fail('INVALID_DATASET_PIN');
}

export function seal(kind, value) {
    if (!['baseline', 'dataset', 'record'].includes(kind)) fail('INVALID_ARTIFACT_KIND');
    const bytes = encode(value), sha256 = hash(bytes);
    if (kind === 'record' && !uuid(value.id)) fail('INVALID_RECORD_ID');
    const name = kind === 'record' ? `records/${value.id}.${sha256}.json` : `${kind}.${sha256}.json`;
    return { name, bytes, sha256, value: decode(bytes) };
}

export function createDataset({ datasetId, createdAt, data, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    if (!uuid(datasetId) || !time(createdAt) || !object(data)) fail('INVALID_DATASET_INPUT');
    profile.validateBaseline(data);
    const baseline = seal('baseline', { protocol: PROTOCOL, dataset_id: datasetId, data });
    const descriptor = seal('dataset', { protocol: PROTOCOL, dataset_id: datasetId, baseline_sha256: baseline.sha256,
        data_schema_version: 1, operation_set: profile.id, created_at: createdAt });
    const pin = { protocol: PROTOCOL, dataset_id: datasetId, descriptor_sha256: descriptor.sha256,
        baseline_sha256: baseline.sha256, namespace: `record-sync/${datasetId}/` };
    return { baseline, descriptor, pin };
}

export function validateJoin(pin, descriptorBytes, baselineBytes, profile = NOTE_PROFILE) {
    profile = captureProfile(profile);
    validatePin(pin);
    if (hash(descriptorBytes) !== pin.descriptor_sha256 || hash(baselineBytes) !== pin.baseline_sha256) fail('DATASET_HASH_MISMATCH');
    const descriptor = decode(descriptorBytes), baseline = decode(baselineBytes);
    if (!exact(descriptor, ['protocol', 'dataset_id', 'baseline_sha256', 'data_schema_version', 'operation_set', 'created_at']) ||
        descriptor.protocol !== PROTOCOL || descriptor.dataset_id !== pin.dataset_id || descriptor.baseline_sha256 !== pin.baseline_sha256 ||
        descriptor.data_schema_version !== 1 || descriptor.operation_set !== profile.id || !time(descriptor.created_at) ||
        !exact(baseline, ['protocol', 'dataset_id', 'data']) || baseline.protocol !== PROTOCOL || baseline.dataset_id !== pin.dataset_id || !object(baseline.data)) fail('INVALID_DATASET_BINDING');
    profile.validateBaseline(baseline.data);
    return { descriptor, baseline };
}

export function verifyRecord(pin, name, bytes, profile = NOTE_PROFILE) {
    profile = captureProfile(profile);
    validatePin(pin);
    const match = typeof name === 'string' && /^records\/([0-9a-f-]+)\.([0-9a-f]{64})\.json$/.exec(name);
    if (!match || !uuid(match[1]) || hash(bytes) !== match[2]) fail('RECORD_FILENAME_HASH_MISMATCH');
    const record = decode(bytes);
    if (!exact(record, ['protocol', 'dataset_id', 'descriptor_sha256', 'id', 'actor_id', 'parents', 'lamport', 'created_at', 'operations']) ||
        record.protocol !== PROTOCOL || record.dataset_id !== pin.dataset_id || record.descriptor_sha256 !== pin.descriptor_sha256 || record.id !== match[1] ||
        !uuid(record.actor_id) || !time(record.created_at) || !Number.isSafeInteger(record.lamport) || record.lamport < 1 ||
        !Array.isArray(record.parents) || !Array.isArray(record.operations) || !record.operations.length) fail('INVALID_RECORD_ENVELOPE');
    const ids = new Set();
    for (const parent of record.parents) {
        if (!exact(parent, ['id', 'sha256']) || !uuid(parent.id) || !sha(parent.sha256) || parent.id === record.id || ids.has(parent.id)) fail('INVALID_PARENT_REFERENCE');
        ids.add(parent.id);
    }
    if (!equal(record.parents, [...record.parents].sort((a, b) => compare(a.id, b.id) || compare(a.sha256, b.sha256)))) fail('UNSORTED_PARENT_REFERENCES');
    for (const operation of record.operations) profile.validateOperation(operation);
    return record;
}

export function createRecord({ pin, actorId, id, createdAt, parents = [], operations, profile = NOTE_PROFILE }) {
    profile = captureProfile(profile);
    validatePin(pin);
    if (!Array.isArray(parents)) fail('INVALID_PARENT_REFERENCE');
    const references = parents.map(parent => {
        const record = verifyRecord(pin, parent.name, parent.bytes, profile);
        return { record, sha256: hash(parent.bytes) };
    });
    const result = seal('record', { protocol: PROTOCOL, dataset_id: pin.dataset_id, descriptor_sha256: pin.descriptor_sha256,
        id, actor_id: actorId, created_at: createdAt, parents: references.map(parent => ({ id: parent.record.id, sha256: parent.sha256 })).sort((a, b) => compare(a.id, b.id)),
        lamport: references.reduce((maximum, parent) => Math.max(maximum, parent.record.lamport), 0) + 1, operations });
    verifyRecord(pin, result.name, result.bytes, profile);
    return result;
}

/** 从完整集合重算拓扑闭包；缺父保留，依赖不齐时不发布新投影。 */
export function inspect(pin, artifacts, profile = NOTE_PROFILE) {
    profile = captureProfile(profile);
    const byId = new Map(), records = [], missing = new Map();
    for (const artifact of artifacts) {
        const record = verifyRecord(pin, artifact.name, artifact.bytes, profile), sha256 = hash(artifact.bytes);
        if (byId.has(record.id)) {
            if (byId.get(record.id).sha256 !== sha256) fail('RECORD_ID_CONTENT_CONFLICT');
            continue;
        }
        const entry = { record, sha256 };
        byId.set(record.id, entry); records.push(entry);
    }
    // 迭代拓扑处理避免深链在逆序发现时耗尽调用栈。
    const indegree = new Map(), children = new Map(), ready = new Map(), ownMissing = new Set();
    for (const entry of records) {
        let degree = 0;
        for (const parent of entry.record.parents) {
            const found = byId.get(parent.id);
            if (found && found.sha256 !== parent.sha256) fail('PARENT_HASH_CONFLICT');
            if (!found) { missing.set(parent.id + '.' + parent.sha256, { ...parent }); ownMissing.add(entry.record.id); }
            else {
                degree++;
                if (!children.has(parent.id)) children.set(parent.id, []);
                children.get(parent.id).push(entry);
            }
        }
        indegree.set(entry.record.id, degree);
    }
    const queue = records.filter(entry => indegree.get(entry.record.id) === 0);
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const entry = queue[cursor], { record } = entry;
        const complete = !ownMissing.has(record.id) && record.parents.every(parent => ready.get(parent.id));
        let maximum = 0;
        for (const parent of record.parents) maximum = Math.max(maximum, byId.get(parent.id)?.record.lamport ?? 0);
        if (complete && record.lamport !== maximum + 1) fail('INVALID_LAMPORT');
        ready.set(record.id, complete);
        for (const child of children.get(record.id) ?? []) {
            const degree = indegree.get(child.record.id) - 1;
            indegree.set(child.record.id, degree);
            if (degree === 0) queue.push(child);
        }
    }
    if (queue.length !== records.length) fail('RECORD_DEPENDENCY_CYCLE');
    const ordered = records.filter(entry => ready.get(entry.record.id)).sort((a, b) => a.record.lamport - b.record.lamport ||
        compare(a.record.actor_id, b.record.actor_id) || compare(a.record.id, b.record.id));
    const parentIds = new Set(ordered.flatMap(entry => entry.record.parents.map(parent => parent.id)));
    return { complete: missing.size === 0, missing: [...missing.values()].sort((a, b) => compare(a.id, b.id) || compare(a.sha256, b.sha256)),
        ordered: ordered.map(entry => entry.record), heads: ordered.filter(entry => !parentIds.has(entry.record.id))
            .map(entry => ({ id: entry.record.id, sha256: entry.sha256 })).sort((a, b) => compare(a.id, b.id)) };
}
