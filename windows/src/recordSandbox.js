import { createTodo, generateUUID } from './dateUtils.js';
import { normalizeNormalTodo, todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson, sha256Hex } from './stableJsonDigest.js';
import { createRecordFolderTransport } from './recordFolder.js';
import { createRecordWebDavTransport } from './recordWebDav.js';
import { openRecordJournal, submitLocalRecord } from './recordRecovery.js';
import { CLOUD_PLANNING_OPERATION_SET, PLANNING_OPERATION_SET } from './recordReplay.js';
import { startRecordSync, syncRecordJournal } from './recordSync.js';
import { planningChange, weeklyPlanState } from './weeklyPlanning.js';

const protocol = 'todo-record-sync/1';
const planningEpoch = '1970-01-01T00:00:00Z';
// 仅在通过集合创建与文件占位验收的服务上开放启用。
const verifiedCapabilityOrigin = 'https://dav.jianguoyun.com';

// 已清除的本机评分只属于旧清单，不能覆盖云端评分或阻止加入云端。
export function retainsLocalPlanning({ journal, view }) {
    return Boolean(journal.fault || !view || view.weekly_plan_versions.length ||
        view.weekly_plan_selections.length || view.daily_ratings.some(item => !item.deleted && item.score !== null));
}

export function planningCloudTarget(config, actorId) {
    if (config?.sync_mode !== 'webdav' || !config.webdav_username || !config.webdav_password) return null;
    const url = new URL((config.webdav_url || 'https://dav.jianguoyun.com/dav/').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RECORD_DAV_INVALID_TARGET');
    const endpoint = url.href.replace(/\/+$/, '');
    const filePath = config.webdav_filepath || '我的坚果云/to-do/todo_data.json';
    const directory = filePath.split('/').slice(0, -1);
    const hash = fixedBytes(['todo-planning/1', endpoint, config.webdav_username, filePath]).hash;
    const datasetId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return { target: { datasetId, actorId, at: planningEpoch },
        webDav: { endpoint, directory, username: config.webdav_username, password: config.webdav_password } };
}

function fixedBytes(value) {
    const raw = new TextEncoder().encode(canonicalJson(value));
    const binary = [];
    for (let i = 0; i < raw.length; i += 8192) binary.push(String.fromCharCode(...raw.subarray(i, i + 8192)));
    return { hash: sha256Hex(raw), content: btoa(binary.join('')) };
}

export function makeRecordSandboxBinding(datasetId, at, operationSet = PLANNING_OPERATION_SET) {
    const data = { version: 1, last_updated: at, todos: [] };
    const baseline = fixedBytes({ protocol, dataset_id: datasetId, data });
    const descriptor = fixedBytes({ protocol, dataset_id: datasetId, baseline_sha256: baseline.hash, created_at: at,
        data_schema_version: 1, operation_set: operationSet });
    return { pin: { protocol, dataset_id: datasetId, namespace: `record-sync/${datasetId}/`,
        baseline_sha256: baseline.hash, descriptor_sha256: descriptor.hash }, descriptor: descriptor.content, baseline: baseline.content };
}

export async function openRecordSandbox(invoke, target, onState, onError, intervalMs = 5000, { localOnly = false, webDav = null } = {}) {
    const { datasetId, actorId, at } = structuredClone(target);
    const binding = makeRecordSandboxBinding(datasetId, at, webDav ? CLOUD_PLANNING_OPERATION_SET : PLANNING_OPERATION_SET);
    const initial = await openRecordJournal(invoke, binding);
    const root = localOnly || webDav ? null : await invoke('prepare_record_sandbox_folder', binding);
    const transport = webDav ? createRecordWebDavTransport(invoke, { ...webDav, pin: binding.pin }, binding) :
        root === null ? null : createRecordFolderTransport(invoke, root, binding.pin);
    const focusKey = `planning-focus:${datasetId}:${binding.pin.descriptor_sha256}`;
    const storedFocus = () => globalThis.localStorage?.getItem(focusKey);
    const storeFocus = value => globalThis.localStorage.setItem(focusKey, value);
    const canCreateCloudFocus = webDav && new URL(webDav.endpoint).origin === verifiedCapabilityOrigin;
    let focusStatus = webDav ? storedFocus() ?? 'unknown' : localOnly ? 'enabled' : 'legacy';
    function withFocus(current) {
        return { ...current, focusStatus, focusEnabled: focusStatus === 'enabled',
            canEnableFocus: Boolean(canCreateCloudFocus && (focusStatus === 'legacy' || focusStatus === 'invalid' && storedFocus() === 'invalid')) };
    }
    async function refreshFocus(current) {
        if (webDav) {
            try {
                if (await transport.readFocus()) {
                    storeFocus('enabled');
                    focusStatus = 'enabled';
                } else if (storedFocus() || current.focusHistory) {
                    focusStatus = 'invalid';
                    storeFocus('invalid');
                } else focusStatus = 'legacy';
            } catch (error) {
                const code = error?.message ?? String(error);
                if (code === 'RECORD_DAV_NETWORK' || code.startsWith('RECORD_DAV_HTTP_')) {
                    focusStatus = storedFocus() ?? 'unknown';
                } else {
                    focusStatus = 'invalid';
                    if (storedFocus()) storeFocus('invalid');
                }
            }
        }
        return withFocus(current);
    }
    let stopped = false, queue = Promise.resolve();
    const enqueue = action => {
        if (stopped) return Promise.reject(new Error('RECORD_SESSION_CLOSED'));
        const result = queue.then(action);
        queue = result.catch(() => {});
        return result;
    };
    let pendingIntent = null;
    onState(withFocus(initial));
    let activeSync = null;
    let lastHistoryCheck = -Infinity;
    const syncOnce = () => {
        if (stopped) return Promise.reject(new Error('RECORD_SESSION_CLOSED'));
        // 没有后续修改排队时，手动刷新复用后台同步，避免连续下载两遍。
        if (activeSync?.queue === queue) return activeSync.promise;
        const promise = enqueue(async () => {
            const verifyKnown = !webDav || performance.now() - lastHistoryCheck >= 30 * 60 * 1000;
            const result = await syncRecordJournal(invoke, binding, transport, { verifyKnown });
            const failed = result.listFailed || result.readFailures.length || result.uploadFailures.length;
            if (verifyKnown && !failed) lastHistoryCheck = performance.now();
            const current = await openRecordJournal(invoke, binding);
            return { ...result, ...(failed ? withFocus(current) : await refreshFocus(current)) };
        });
        const operation = { promise, queue };
        activeSync = operation;
        const clear = () => { if (activeSync === operation) activeSync = null; };
        void promise.then(clear, clear);
        return promise;
    };
    const sync = transport ? startRecordSync({
        intervalMs, onError, onResult: onState,
        sync: syncOnce
    }) : async () => {};
    async function submit() {
        try {
            const saved = await submitLocalRecord(invoke, binding, pendingIntent);
            pendingIntent = null;
            onState(withFocus(saved));
        } catch (error) {
            const code = error?.message ?? String(error);
            if (['RECORD_WRITE_STALE', 'RECORD_DATASET_FROZEN'].includes(code) || code.startsWith('INVALID_')) pendingIntent = null;
            throw error;
        }
    }
    async function write(action, observedRevision, guardedRating) {
        const latest = await openRecordJournal(invoke, binding);
        if (!latest.view || !guardedRating && latest.revision !== observedRevision) throw new Error('RECORD_WRITE_STALE');
        if (webDav && ['save', 'delete'].includes(action.kind) && focusStatus !== 'enabled' &&
            (focusStatus !== 'legacy' || latest.focusHistory || Object.hasOwn(action, 'focus'))) {
            throw new Error('本周重点启用状态待核对，请重试同步');
        }
        const id = generateUUID();
        const current = action.todoId && latest.view.todos.find(todo => todo.id === action.todoId && todo.task_type === 'normal' && !todo.deleted);
        const rating = action.kind === 'rate' && latest.view.daily_ratings.find(item => item.date === action.date);
        if (guardedRating && canonicalJson(rating ?? null) !== canonicalJson(action.expectedRating)) {
            onState(withFocus(latest));
            throw new Error('当日评分已更新，请核对后再保存');
        }
        const previousClock = current?.updated_at ?? rating?.updated_at;
        const stamp = new Date(Math.max(Date.now(), previousClock ? todoTimestampMillis(previousClock) + 1 : 0)).toISOString();
        let operation;
        if (action.kind === 'add') {
            const content = action.content.trim();
            if (!content) throw new Error('INVALID_TASK_NAME');
            operation = { type: 'todo.normal.put', todo: createTodo(content, null, [], { id: generateUUID(), at: stamp }) };
        } else if (action.kind === 'rename' || action.kind === 'remove') {
            if (!current) throw new Error('RECORD_TODO_NOT_FOUND');
            const deleted = action.kind === 'remove', content = deleted ? current.content : action.content.trim();
            if (!content) throw new Error('INVALID_TASK_NAME');
            operation = { type: deleted ? 'todo.normal.delete' : 'todo.normal.put',
                todo: normalizeNormalTodo({ ...current, content, deleted, updated_at: stamp }) };
        } else {
            const details = action.kind === 'save' && focusStatus === 'enabled' && !Object.hasOwn(action, 'focus')
                ? { ...action, focus: weeklyPlanState(latest.view, action.week).current?.focus ?? '' } : action;
            operation = planningChange(latest.view, details, { id, at: stamp });
        }
        if (!operation) return;
        pendingIntent = { id, actor_id: actorId, created_at: stamp, observed_sha256: latest.revision, operations: [operation] };
        await submit();
    }
    return {
        binding,
        // 手动刷新沿用当前会话和队列，不关闭会话或丢弃尚未保存的草稿。
        sync: async () => {
            try {
                const next = transport ? await syncOnce() : await enqueue(async () => withFocus(await openRecordJournal(invoke, binding)));
                onState(next);
                return next;
            } catch (error) {
                onError(error);
                throw error;
            }
        },
        enableFocus: (isCurrent = () => true) => enqueue(async () => {
            if (!isCurrent()) throw new Error('个人清单已切换，请重试');
            if (pendingIntent) throw new Error('RECORD_RETRY_PENDING');
            if (focusStatus !== 'enabled') {
                if (!canCreateCloudFocus) throw new Error('当前云端尚未通过本周重点启用验收');
                const result = await syncRecordJournal(invoke, binding, transport);
                if (result.listFailed || result.readFailures?.length || result.uploadFailures?.length) throw new Error('请先完成计划同步');
                const current = await openRecordJournal(invoke, binding);
                if (!current.view || current.journal.fault || current.journal.pending.length || current.journal.unread?.length) {
                    throw new Error('请先完成计划同步并核对数据完整性');
                }
                if (!isCurrent()) throw new Error('个人清单已切换，请重试');
                await transport.enableFocus();
                storeFocus('enabled');
                focusStatus = 'enabled';
            }
            const next = withFocus(await openRecordJournal(invoke, binding));
            onState(next);
            return next;
        }),
        change: (action, observedRevision) => enqueue(async () => {
            if (pendingIntent) throw new Error('RECORD_RETRY_PENDING');
            const guardedRating = action.kind === 'rate' && Object.hasOwn(action, 'expectedRating');
            try {
                await write(action, observedRevision, guardedRating);
            } catch (error) {
                if (!guardedRating || (error?.message ?? error) !== 'RECORD_WRITE_STALE') throw error;
                await write(action, observedRevision, guardedRating);
            }
        }),
        hasPendingWrite: day => day === undefined ? pendingIntent !== null :
            pendingIntent?.operations[0].rating?.date === day,
        retry: () => enqueue(async () => {
            if (!pendingIntent) return false;
            await submit();
            return true;
        }),
        close: async () => {
            stopped = true;
            await sync();
            await queue;
        }
    };
}
