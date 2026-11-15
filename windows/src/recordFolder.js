import { RecordTransportIntegrityError } from './recordSync.js';

const integrityErrors = new Set([
    'INVALID_DATASET_PIN', 'RECORD_INVALID_REMOTE_NAME', 'RECORD_FOLDER_INVALID_ROOT',
    'RECORD_FOLDER_TARGET_MISMATCH', 'RECORD_FOLDER_UNSAFE_ENTRY', 'RECORD_FOLDER_UNRESOLVED_ENTRY',
    'RECORD_FOLDER_INVALID_RECORD', 'RECORD_FOLDER_SIZE_LIMIT', 'RECORD_FOLDER_CONTENT_CONFLICT'
]);

export function createRecordFolderTransport(invoke, root, pin) {
    const binding = structuredClone({ root, pin });
    let aliases = new Map();
    async function call(command, args = {}) {
        try {
            return await invoke(command, { binding, ...args });
        } catch (error) {
            const code = error?.message ?? String(error);
            if (integrityErrors.has(code)) throw new RecordTransportIntegrityError(code);
            throw error;
        }
    }
    return {
        namespace: binding.pin.namespace,
        async list() {
            const listing = await call('list_record_folder');
            aliases = new Map(listing.aliases.map(artifact => [artifact.name, artifact.content]));
            return listing.names;
        },
        async read(name) {
            const canonical = await call('read_record_folder', { name });
            return canonical ?? aliases.get(name) ?? null;
        },
        write: (name, content) => call('write_record_folder', { name, content })
    };
}
