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
        read: name => request('read', name),
        write: (name, content) => request(initialization ? 'write_planning' : 'write', name, content)
    };
}
