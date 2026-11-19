import { directoryNames } from './recordDavListing.js';
import { RecordTransportIntegrityError } from './recordSync.js';

const integrityCodes = new Set([
    'INVALID_DATASET_PIN', 'RECORD_DAV_INVALID_TARGET', 'RECORD_DAV_TARGET_MISMATCH',
    'RECORD_DAV_INVALID_REQUEST', 'RECORD_DAV_INVALID_LIST', 'RECORD_DAV_INVALID_RECORD',
    'RECORD_DAV_SIZE_LIMIT', 'RECORD_DAV_CREATE_UNVERIFIED'
]);

export function createRecordWebDavTransport(invoke, input, initialization = null) {
    const binding = structuredClone(input);
    const collection = new URL(binding.endpoint);
    const suffix = [...binding.directory, 'record-sync', binding.pin.dataset_id, 'records'].map(encodeURIComponent).join('/');
    collection.pathname = collection.pathname.replace(/\/$/, '') + '/' + suffix + '/';
    const capabilities = new URL('../capabilities/', collection);
    const focus = new URL(`weekly-plan-focus-v1.${binding.pin.descriptor_sha256}/`, capabilities);
    let joined = false;
    async function request(action, name = null, content = null) {
        try {
            return await invoke('request_record_webdav', { binding, action, name, content });
        } catch (error) {
            const code = error?.message ?? String(error);
            if (integrityCodes.has(code)) throw new RecordTransportIntegrityError(code);
            throw error;
        }
    }
    async function readCollection(action, url) {
        const xml = await request(action);
        if (xml === null) return false;
        directoryNames(xml, url, true);
        return true;
    }
    async function createCollection(action, read, url) {
        if (await readCollection(read, url)) return;
        try {
            await request(action);
        } catch (error) {
            if (await readCollection(read, url)) return;
            throw error;
        }
        if (!await readCollection(read, url)) throw new Error('RECORD_DAV_CREATE_UNVERIFIED');
    }
    return {
        namespace: binding.pin.namespace,
        async list() {
            if (initialization && !joined) {
                try {
                    await invoke('initialize_planning_webdav', { binding, descriptor: initialization.descriptor, baseline: initialization.baseline });
                } catch (error) {
                    const code = error?.message ?? String(error);
                    if (integrityCodes.has(code)) throw new RecordTransportIntegrityError(code);
                    throw error;
                }
                joined = true;
            }
            const xml = await request('list');
            try {
                return directoryNames(xml, collection);
            } catch (error) {
                throw new RecordTransportIntegrityError(error.message);
            }
        },
        async readFocus() {
            return await readCollection('read_capabilities', capabilities) && await readCollection('read_focus', focus);
        },
        async enableFocus() {
            await createCollection('create_capabilities', 'read_capabilities', capabilities);
            await createCollection('create_focus', 'read_focus', focus);
        },
        read: name => request('read', name),
        write: (name, content) => request(initialization ? 'write_planning' : 'write', name, content)
    };
}
