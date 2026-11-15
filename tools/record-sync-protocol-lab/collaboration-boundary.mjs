import { encode } from './codec.mjs';
import { openRecordLab } from './client.mjs';
import { validatePin, verifyRecord } from './envelope.mjs';
import { captureProfile } from './operation-profile.mjs';

const fail = code => { throw new Error(code); };
const same = (a, b) => encode(a).equals(encode(b));
const nonempty = value => typeof value === 'string' && value.length > 0;

function captureBinding(binding) {
    if (!binding || Object.keys(binding).length !== 4 || !nonempty(binding.sourceId) ||
        !nonempty(binding.targetKey) || !Number.isSafeInteger(binding.generation) || binding.generation < 0) {
        fail('INVALID_COLLABORATION_BINDING');
    }
    validatePin(binding.pin);
    return structuredClone(binding);
}

// 只约束本机合规入口。targetKey 是本机目标标识，由调用者绑定到固定传输实例。
export async function openCollaborationBoundaryLab({ dataset, binding, getCurrentBinding, getCurrentAccess, store, transport,
    profile, access, createType, validateCreateOperation }) {
    const captured = captureBinding(binding);
    profile = captureProfile(profile);
    if (!same(captured.pin, dataset.pin)) fail('COLLABORATION_DATASET_BINDING_MISMATCH');
    if (!['view', 'append'].includes(access) || typeof getCurrentBinding !== 'function' || typeof getCurrentAccess !== 'function' ||
        (access === 'append' && (!nonempty(createType) || typeof validateCreateOperation !== 'function'))) {
        fail('INVALID_COLLABORATION_ACCESS');
    }
    const list = transport.list.bind(transport), read = transport.read.bind(transport), write = transport.write.bind(transport);

    function requireCurrent() {
        const current = getCurrentBinding();
        if (!current || !same(captured, current)) fail('COLLABORATION_TARGET_CHANGED');
    }

    function requireAppend(operations) {
        if (access !== 'append' || getCurrentAccess() !== 'append') fail('COLLABORATION_VIEW_ONLY');
        if (!Array.isArray(operations) || operations.length !== 1 || operations[0]?.type !== createType) {
            fail('COLLABORATION_REQUIRES_ONE_CREATE');
        }
        validateCreateOperation(structuredClone(operations[0]));
    }

    const guardedStore = {
        async load() {
            requireCurrent();
            const stored = await store.load();
            requireCurrent();
            if (stored === null) return null;
            if (!stored.binding || !same(stored.binding, captured)) fail('COLLABORATION_STORE_BINDING_MISMATCH');
            return stored.state;
        },
        save(state) {
            return store.save({ binding: structuredClone(captured), state });
        }
    };
    const guardedTransport = {
        async list() {
            requireCurrent();
            const names = await list();
            requireCurrent();
            return names;
        },
        async read(name) {
            requireCurrent();
            const bytes = await read(name);
            requireCurrent();
            return bytes;
        },
        write(name, bytes) {
            requireCurrent();
            if (access !== 'append') fail('COLLABORATION_VIEW_ONLY');
            const record = verifyRecord(captured.pin, name, bytes, profile);
            requireAppend(record.operations);
            return write(name, bytes);
        }
    };
    const client = await openRecordLab({ dataset, store: guardedStore, transport: guardedTransport, profile });
    requireCurrent();
    return Object.freeze({
        view() {
            requireCurrent();
            return client.state().view;
        },
        async append(draftBinding, intent) {
            requireCurrent();
            if (!same(captured, draftBinding)) fail('COLLABORATION_DRAFT_BINDING_MISMATCH');
            const fixed = structuredClone(intent);
            requireAppend(fixed?.operations);
            const result = await client.commit(fixed);
            requireCurrent();
            if (getCurrentAccess() !== 'append') fail('COLLABORATION_VIEW_ONLY');
            return result;
        },
        async sync() {
            requireCurrent();
            const result = await client.sync();
            requireCurrent();
            return result;
        }
    });
}
