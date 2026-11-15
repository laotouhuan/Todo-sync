import { openRecordJournal, saveRecordRecovery } from './recordRecovery.js';

class RecordTransportIntegrityError extends Error {}
export { RecordTransportIntegrityError };

// 一次同步结束后才开始下一次。停止时等已发出的请求收尾。
export function startRecordSync({ sync, onResult, onError, intervalMs }) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('INVALID_RECORD_SYNC_INTERVAL');
    let stopped = false, timer, running;
    async function run() {
        try {
            onResult(await sync());
        } catch (error) {
            onError(error);
            if (error instanceof RecordTransportIntegrityError) stopped = true;
        } finally {
            if (!stopped) timer = setTimeout(() => { running = run(); }, intervalMs);
        }
    }
    running = run();
    return async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
    };
}

// 传输实例固定到一个数据集。读取不存在的对象返回 null，读取失败则抛错。
export async function syncRecordJournal(invoke, { pin, descriptor, baseline }, transport) {
    const target = structuredClone({ pin, descriptor, baseline });
    if (transport.namespace !== target.pin.namespace) throw new Error('RECORD_TRANSPORT_TARGET_MISMATCH');
    let state = await openRecordJournal(invoke, target);
    const save = changes => saveRecordRecovery(invoke, { ...target, ...changes });
    function requireWritable() {
        if (state.journal.fault) throw new RecordTransportIntegrityError(state.journal.fault.code);
    }
    requireWritable();
    const readFailures = [], uploadFailures = [];
    let listFailed = false;
    let discovered;
    try {
        discovered = await transport.list();
    } catch (error) {
        if (error instanceof RecordTransportIntegrityError) throw error;
        listFailed = true;
    }
    if (!listFailed) {
        if (!Array.isArray(discovered)) throw new Error('RECORD_INVALID_REMOTE_LIST');
        if (discovered.length) state = await save({ discovered });
    }
    const attempted = new Set();
    async function observe(name, content, confirm = false) {
        state = await save({ observation: { artifact: { name, content }, confirm } });
        requireWritable();
    }
    while (true) {
        const pending = new Set(state.journal.pending);
        const known = new Map(state.journal.records.map(item => [item.name, item.content]));
        const names = [...new Set([...(state.journal.unread ?? []), ...state.missing, ...[...known.keys()].filter(name => !pending.has(name))])].filter(name => !attempted.has(name));
        if (!names.length) break;
        for (const name of names) {
            attempted.add(name);
            let content;
            try {
                content = await transport.read(name);
            } catch (error) {
                if (error instanceof RecordTransportIntegrityError) throw error;
                readFailures.push(name);
                continue;
            }
            if (content === null) readFailures.push(name);
            else if (known.get(name) !== content) await observe(name, content);
        }
    }
    if (!listFailed && state.view !== null) {
        const artifacts = new Map(state.journal.records.map(artifact => [artifact.name, artifact]));
        for (const name of state.journal.pending) {
            const local = artifacts.get(name);
            let content;
            try {
                content = await transport.read(name);
                if (content === null) {
                    await transport.write(name, local.content);
                    content = await transport.read(name);
                }
            } catch (error) {
                if (error instanceof RecordTransportIntegrityError) throw error;
                uploadFailures.push(name);
                continue;
            }
            if (content === null) uploadFailures.push(name);
            else await observe(name, content, true);
        }
    }
    return { ...state, listFailed, readFailures, uploadFailures };
}
