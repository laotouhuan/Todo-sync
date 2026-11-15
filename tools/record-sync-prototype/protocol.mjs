import { createHash } from 'node:crypto';

// 仅供独立记录同步原型使用；不替代应用当前的时间戳合并规则。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATCH_FIELDS = new Set(['content', 'completed', 'date', 'time', 'order', 'label']);
const LEARNING_FIELDS = ['fact', 'obstacle', 'effective_action', 'next_step'];
const COLLECTIONS = ['weekly_plan_versions', 'weekly_plan_selections', 'daily_ratings', 'daily_reviews'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new Error(message); };
const object = value => value != null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (value, name) => typeof value === 'string' && value.length > 0 || fail(`${name} 必须是非空字符串`);
const uuid = (value, name) => typeof value === 'string' && UUID.test(value) || fail(`${name} 必须是 UUID v4`);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && date(value.slice(0, 10)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const monday = value => date(value) && new Date(value + 'T12:00:00Z').getUTCDay() === 1;

export function canonical(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort(compare).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return fail('原型协议只接受 JSON 值');
}

export function snapshotHash(snapshot) {
    return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function validateSnapshot(snapshot) {
    if (!object(snapshot) || snapshot.protocol !== 1 || !object(snapshot.data) || !Array.isArray(snapshot.data.todos)) fail('快照格式无效');
    uuid(snapshot.dataset_id, 'dataset_id');
    canonical(snapshot);
    for (const key of COLLECTIONS) if (snapshot.data[key] !== undefined && !Array.isArray(snapshot.data[key])) fail(`${key} 必须是数组`);
}

function validateOperation(operation) {
    if (!object(operation)) fail('操作必须是对象');
    const keys = { 'todo.add': ['todo'], 'todo.patch': ['todo_id', 'fields'], 'todo.delete': ['todo_id'],
        'rating.set': ['id', 'date', 'score'], 'review.set': ['id', 'date', ...LEARNING_FIELDS],
        'plan.version.add': ['version'], 'plan.selection.add': ['selection'], 'plan.version.delete': ['version_id'] }[operation.type];
    if (!keys || Object.keys(operation).some(key => key !== 'type' && !keys.includes(key)) || keys.some(key => !(key in operation))) fail('未知操作或操作字段无效');
    if (operation.type === 'todo.add') {
        if (!object(operation.todo) || typeof operation.todo.content !== 'string' || typeof operation.todo.completed !== 'boolean') fail('todo.add 需要完整任务');
        string(operation.todo.id, 'todo.id');
    }
    if (operation.type === 'todo.patch' || operation.type === 'todo.delete') string(operation.todo_id, 'todo_id');
    if (operation.type === 'todo.patch') {
        if (!object(operation.fields) || !Object.keys(operation.fields).length || Object.keys(operation.fields).some(key => !PATCH_FIELDS.has(key))) fail('任务修改字段不在白名单中');
        for (const [key, value] of Object.entries(operation.fields)) {
            const valid = key === 'completed' ? typeof value === 'boolean' : key === 'order' ? typeof value === 'number' && Number.isFinite(value) :
                key === 'content' ? typeof value === 'string' : value === null || typeof value === 'string';
            if (!valid) fail(`任务字段 ${key} 类型无效`);
        }
    }
    if (operation.type === 'rating.set' || operation.type === 'review.set') {
        string(operation.id, '学习记录 id');
        if (!date(operation.date)) fail('学习记录日期无效');
    }
    if (operation.type === 'rating.set' && !(operation.score === null || Number.isInteger(operation.score) && operation.score >= 1 && operation.score <= 5)) fail('评分必须是 1～5 的整数或 null');
    if (operation.type === 'review.set' && LEARNING_FIELDS.some(key => typeof operation[key] !== 'string')) fail('复盘正文必须是字符串');
    if (operation.type === 'plan.version.add') {
        const version = operation.version;
        if (!object(version)) fail('计划版本无效');
        string(version.id, '版本 id');
        if (!monday(version.week_start) || !(version.base_version_id === null || typeof version.base_version_id === 'string' && version.base_version_id.length) ||
            !Array.isArray(version.days) || version.days.length !== 7 || version.days.some(day => typeof day !== 'string') || typeof version.change_reason !== 'string') fail('计划版本字段无效');
    }
    if (operation.type === 'plan.selection.add') {
        const selection = operation.selection;
        if (!object(selection)) fail('计划采用记录无效');
        string(selection.id, '采用记录 id'); string(selection.version_id, 'version_id');
        if (!monday(selection.week_start) || !['save', 'resolve'].includes(selection.kind) || !Array.isArray(selection.parent_selection_ids) ||
            selection.parent_selection_ids.some(id => typeof id !== 'string' || !id) || new Set(selection.parent_selection_ids).size !== selection.parent_selection_ids.length) fail('采用记录字段无效');
    }
    if (operation.type === 'plan.version.delete') string(operation.version_id, 'version_id');
}

function validateRecord(record, snapshot, hash) {
    if (!object(record) || record.protocol !== 1 || record.dataset_id !== snapshot.dataset_id || record.snapshot_hash !== hash) fail('记录与固定快照或数据集不匹配');
    canonical(record);
    uuid(record.id, '记录 id'); uuid(record.actor_id, 'actor_id');
    if (!timestamp(record.created_at) || !Number.isSafeInteger(record.lamport) || record.lamport < 1 || !Array.isArray(record.parents) ||
        new Set(record.parents).size !== record.parents.length || !Array.isArray(record.operations) || !record.operations.length) fail('记录时间、因果关系或操作无效');
    record.parents.forEach(id => uuid(id, '父记录 id'));
    if (canonical(record.parents) !== canonical([...record.parents].sort(compare))) fail('父记录必须按 ID 排序');
    record.operations.forEach(validateOperation);
    const versions = record.operations.filter(op => op.type === 'plan.version.add');
    const saves = record.operations.filter(op => op.type === 'plan.selection.add' && op.selection.kind === 'save');
    if (versions.some(op => !saves.some(save => save.selection.version_id === op.version.id)) ||
        saves.some(op => !versions.some(version => version.version.id === op.selection.version_id))) fail('保存计划必须在同一记录中新增版本及 save 采用记录');
}

function rejectCycles(nodes, parents, label) {
    const visiting = new Set(), finished = new Set();
    function visit(id) {
        if (visiting.has(id)) fail(`${label}存在循环`);
        if (finished.has(id)) return;
        visiting.add(id);
        for (const parent of parents(nodes.get(id))) if (nodes.has(parent)) visit(parent);
        visiting.delete(id); finished.add(id);
    }
    for (const id of nodes.keys()) visit(id);
}

function find(items, id, label) {
    return items.find(item => item.id === id) || fail(`${label}不存在：${id}`);
}

function apply(data, record) {
    const now = record.created_at;
    for (const op of record.operations) {
        if (op.type === 'todo.add') {
            const previous = data.todos.find(todo => todo.id === op.todo.id);
            if (previous) {
                // 删除保留优先，晚到的新增副本不能恢复任务。
                if (!previous.deleted) fail(`重复的任务新增：${op.todo.id}`);
            } else data.todos.push({ ...structuredClone(op.todo), created_at: now, updated_at: now });
        } else if (op.type === 'todo.patch') {
            const todo = find(data.todos, op.todo_id, '任务');
            Object.assign(todo, structuredClone(op.fields), { updated_at: now });
            if ('completed' in op.fields) todo.completed_at = op.fields.completed ? now : null;
        } else if (op.type === 'todo.delete') {
            const todo = find(data.todos, op.todo_id, '任务');
            if (!todo.deleted) Object.assign(todo, { deleted: true, updated_at: now });
        } else if (op.type === 'rating.set' || op.type === 'review.set') {
            const collection = op.type === 'rating.set' ? data.daily_ratings : data.daily_reviews;
            const index = collection.findIndex(item => item.date === op.date);
            const previous = collection[index];
            const body = op.type === 'rating.set' ? { score: op.score } : Object.fromEntries(LEARNING_FIELDS.map(key => [key, op[key]]));
            const updated = { ...previous, id: op.id, date: op.date, ...body, deleted: false,
                created_at: previous?.created_at || now, updated_at: now };
            if (index === -1) collection.push(updated); else collection[index] = updated;
        } else if (op.type === 'plan.version.add') {
            const previous = data.weekly_plan_versions.find(version => version.id === op.version.id);
            if (previous) {
                const immutable = Object.fromEntries(Object.keys(op.version).map(key => [key, previous[key]]));
                if (canonical(immutable) !== canonical(op.version)) fail('同 ID 计划版本正文冲突');
            } else data.weekly_plan_versions.push({ ...structuredClone(op.version), created_at: now, updated_at: now, deleted: false, deleted_at: null });
        } else if (op.type === 'plan.selection.add') {
            const previous = data.weekly_plan_selections.find(selection => selection.id === op.selection.id);
            if (previous) fail('重复的计划采用记录 ID');
            data.weekly_plan_selections.push({ ...structuredClone(op.selection), created_at: now, updated_at: now });
        } else if (op.type === 'plan.version.delete') {
            const version = find(data.weekly_plan_versions, op.version_id, '计划版本');
            if (!version.deleted) Object.assign(version, { deleted: true, deleted_at: now, updated_at: now });
        }
    }
}

function planningState(data) {
    const versions = new Map(data.weekly_plan_versions.map(version => [version.id, version]));
    const selections = new Map(data.weekly_plan_selections.map(selection => [selection.id, selection]));
    if (versions.size !== data.weekly_plan_versions.length || selections.size !== data.weekly_plan_selections.length) fail('快照中存在重复计划身份');
    for (const version of versions.values()) {
        if (!monday(version.week_start)) fail('计划所属周无效');
        if (version.base_version_id != null && versions.get(version.base_version_id)?.week_start !== version.week_start) fail('版本前版缺失或跨周');
    }
    for (const selection of selections.values()) {
        if (versions.get(selection.version_id)?.week_start !== selection.week_start || !Array.isArray(selection.parent_selection_ids)) fail('采用版本缺失或跨周');
        for (const id of selection.parent_selection_ids) if (selections.get(id)?.week_start !== selection.week_start) fail('采用前驱缺失或跨周');
    }
    rejectCycles(versions, version => version.base_version_id ? [version.base_version_id] : [], '版本关系');
    rejectCycles(selections, selection => selection.parent_selection_ids, '采用关系');
    const weeks = [...new Set([...versions.values()].map(version => version.week_start))].sort(compare);
    const weekStates = {}, conflicts = [];
    for (const week of weeks) {
        const items = [...selections.values()].filter(selection => selection.week_start === week);
        const parents = new Set(items.flatMap(selection => selection.parent_selection_ids));
        const heads = items.filter(selection => !parents.has(selection.id));
        const candidateVersionIds = [...new Set(heads.map(selection => selection.version_id))].sort(compare);
        const deletedCandidateVersionIds = candidateVersionIds.filter(id => versions.get(id).deleted);
        const status = !heads.length || deletedCandidateVersionIds.length ? 'needs-review' : candidateVersionIds.length === 1 ? 'current' : 'conflict';
        weekStates[week] = { week_start: week, status, currentVersionId: status === 'current' ? candidateVersionIds[0] : null,
            candidateSelectionIds: heads.map(selection => selection.id).sort(compare), candidateVersionIds, deletedCandidateVersionIds };
        if (status !== 'current') conflicts.push({ type: status === 'conflict' ? 'plan-selection-conflict' : 'plan-needs-review', ...weekStates[week] });
    }
    return { weekStates, conflicts };
}

export function project(snapshot, records) {
    validateSnapshot(snapshot);
    if (!Array.isArray(records)) fail('记录集合必须是数组');
    const hash = snapshotHash(snapshot), unique = new Map();
    for (const record of records) {
        validateRecord(record, snapshot, hash);
        const old = unique.get(record.id);
        if (old && canonical(old) !== canonical(record)) fail(`同 ID 记录正文冲突：${record.id}`);
        unique.set(record.id, record);
    }
    rejectCycles(unique, record => record.parents, '记录因果关系');
    const eligible = new Map();
    function ready(id) {
        if (!unique.has(id)) return false;
        if (!eligible.has(id)) eligible.set(id, unique.get(id).parents.every(ready));
        return eligible.get(id);
    }
    const applied = [...unique.values()].filter(record => ready(record.id)).sort((a, b) =>
        a.lamport - b.lamport || compare(a.actor_id, b.actor_id) || compare(a.id, b.id));
    for (const record of applied) {
        const expected = Math.max(0, ...record.parents.map(id => unique.get(id).lamport)) + 1;
        if (record.lamport !== expected) fail(`记录 lamport 无效：${record.id}`);
    }
    const data = structuredClone(snapshot.data);
    for (const key of COLLECTIONS) data[key] ??= [];
    for (const record of applied) apply(data, record);
    if (applied.length) data.last_updated = applied.at(-1).created_at;
    const parents = new Set(applied.flatMap(record => record.parents));
    return { data, appliedIds: applied.map(record => record.id), pendingIds: [...unique.keys()].filter(id => !eligible.get(id)).sort(compare),
        heads: applied.filter(record => !parents.has(record.id)).map(record => record.id).sort(compare), ...planningState(data) };
}

export function createRecord(snapshot, knownRecords, { id, actor_id, created_at, operations }) {
    const state = project(snapshot, knownRecords);
    const previous = knownRecords.find(record => record.id === id);
    if (previous) {
        if (previous.actor_id !== actor_id || previous.created_at !== created_at || canonical(previous.operations) !== canonical(operations)) fail('已存在的记录 ID 不能用于新内容');
        return freeze(structuredClone(previous));
    }
    const byId = new Map(knownRecords.map(record => [record.id, record]));
    const record = { protocol: 1, dataset_id: snapshot.dataset_id, snapshot_hash: snapshotHash(snapshot), id, actor_id,
        parents: state.heads, lamport: Math.max(0, ...state.heads.map(parent => byId.get(parent).lamport)) + 1,
        created_at, operations: structuredClone(operations) };
    validateRecord(record, snapshot, record.snapshot_hash);
    project(snapshot, [...knownRecords, record]);
    return freeze(record);
}
