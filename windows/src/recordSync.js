import { openRecordJournal, saveRecordRecovery } from './recordRecovery.js';

class RecordTransportIntegrityError extends Error {}
export { RecordTransportIntegrityError };

// 一次同步结束后才开始下一次。停止时等已发出的请求收尾。
export function startRecordSync({ sync, onResult, onError, intervalMs }) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('INVALID_RECORD_SYNC_INTERVAL');
    let stopped = false, timer, running, failures = 0;
    async function run() {
        try {
            const result = await sync();
            failures = result?.listFailed || result?.readFailures?.length || result?.uploadFailures?.length ? failures + 1 : 0;
            onResult(result);
        } catch (error) {
            onError(error);
            failures++;
            if (error instanceof RecordTransportIntegrityError) stopped = true;
        } finally {
            const delay = Math.min(intervalMs * 2 ** Math.min(failures, 10), Math.max(intervalMs, 15 * 60 * 1000));
            if (!stopped) timer = setTimeout(() => { running = run(); }, delay);
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
export async function syncRecordJournal(invoke, { pin, descriptor, baseline }, transport, { verifyKnown = true } = {}) {
    const target = structuredClone({ pin, descriptor, baseline });
    if (transport.namespace !== target.pin.namespace) throw new Error('RECORD_TRANSPORT_TARGET_MISMATCH');
    let state = await openRecordJournal(invoke, target);
    const save = changes => saveRecordRecovery(invoke, { ...target, ...changes });
    function requireWritable() {
        if (state.journal.fault) throw new RecordTransportIntegrityError(state.journal.fault.code);
    }
    requireWritable();
    const readFailures = [], uploadFailures = [];
    let transportError = '';
    let listFailed = false;
    let discovered;
    try {
        discovered = await transport.list();
    } catch (error) {
        if (error instanceof RecordTransportIntegrityError) throw error;
        listFailed = true;
        transportError = error?.message ?? String(error);
    }
    // 目录请求失败时立即收尾，避免限流期间继续读取历史或上传。
    if (listFailed) return { ...state, listFailed, readFailures, uploadFailures, transportError };
    if (!Array.isArray(discovered)) throw new Error('RECORD_INVALID_REMOTE_LIST');
    if (discovered.length) state = await save({ discovered });
    const attempted = new Set();
    // 上传新修改前必须重新核对全部历史；只读轮询可使用已验证的本机记录。
    const auditKnown = verifyKnown || state.journal.pending.length > 0;
    async function observe(name, content, confirm = false) {
        state = await save({ observation: { artifact: { name, content }, confirm } });
        requireWritable();
    }
    while (true) {
        const pending = new Set(state.journal.pending);
        const known = new Map(state.journal.records.map(item => [item.name, item.content]));
        const history = auditKnown ? [...known.keys()].filter(name => !pending.has(name)) : [];
        const names = [...new Set([...(state.journal.unread ?? []), ...state.missing, ...history])].filter(name => !attempted.has(name));
        if (!names.length) break;
        // 只并行读取，校验与落盘仍按原顺序执行；限制并发避免压满 WebDAV。
        for (let offset = 0; offset < names.length; offset += 4) {
            const batch = names.slice(offset, offset + 4);
            batch.forEach(name => attempted.add(name));
            const results = await Promise.allSettled(batch.map(name => transport.read(name)));
            for (const [index, name] of batch.entries()) {
                const result = results[index];
                if (result.status === 'rejected') {
                    if (result.reason instanceof RecordTransportIntegrityError) throw result.reason;
                    readFailures.push(name);
                    transportError = result.reason?.message ?? String(result.reason);
                    continue;
                }
                const content = result.value;
                if (content === null) readFailures.push(name);
                else if (known.get(name) !== content) await observe(name, content);
            }
            if (transportError) return { ...state, listFailed, readFailures, uploadFailures, transportError };
        }
    }
    if (state.view !== null) {
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
                transportError = error?.message ?? String(error);
                break;
            }
            if (content === null) uploadFailures.push(name);
            else await observe(name, content, true);
        }
    }
    return { ...state, listFailed, readFailures, uploadFailures, transportError };
}
