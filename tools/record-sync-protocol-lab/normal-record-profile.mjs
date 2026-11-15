import { encode, decode } from './codec.mjs';
import { migrateAndNormalize } from '../../windows/src/dataMerge.js';
import { chooseNormalTodo, normalizeNormalTodo, todoTimestampMillis } from '../../windows/src/normalTodoConflict.js';

// 仅在隔离实验中使用；新增 profile 不会自动启用应用记录同步。
export const NORMAL_TODO_OPERATION_SET = 'lab-normal-todo/1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => decode(encode(value));
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function ordinaryTodo(raw) {
    const migrated = migrateAndNormalize(copy(raw));
    if (!object(migrated) || migrated.task_type !== 'normal') fail('UNSUPPORTED_NORMAL_RECORD_TASK_TYPE');
    return copy(normalizeNormalTodo(migrated));
}

/** 调用方先固定动作时间和完整任务候选；此入口不生成时间或身份。 */
export function normalTodoOperation(action, raw) {
    if (!['put', 'delete'].includes(action)) fail('UNSUPPORTED_NORMAL_RECORD_ACTION');
    const operation = { type: `todo.normal.${action}`, todo: ordinaryTodo(raw) };
    validateOperation(operation);
    return operation;
}

function validateOperation(operation) {
    if (!object(operation) || Object.keys(operation).length !== 2 || !Object.hasOwn(operation, 'todo') ||
        !['todo.normal.put', 'todo.normal.delete'].includes(operation.type)) fail('UNSUPPORTED_OPERATION');
    const normalized = ordinaryTodo(operation.todo);
    if (!encode(normalized).equals(encode(operation.todo))) fail('NON_NORMALIZED_NORMAL_TODO_OPERATION');
    if (normalized.deleted !== (operation.type === 'todo.normal.delete')) fail('NORMAL_TODO_DELETE_KIND_MISMATCH');
}

function prepareBaseline(input) {
    const data = copy(input);
    if (!object(data) || data.version !== 1 || !Array.isArray(data.todos)) fail('INVALID_NORMAL_TODO_BASELINE');
    todoTimestampMillis(data.last_updated);
    const todos = new Map(), kinds = new Map(), knownChildren = new Map();
    for (const raw of data.todos) {
        if (!object(raw) || typeof raw.id !== 'string' || todos.has(raw.id)) fail('AMBIGUOUS_BASELINE_TODO_ID');
        const migrated = migrateAndNormalize(copy(raw));
        kinds.set(raw.id, migrated.task_type);
        // 周/月及其他域仅透传，未覆盖的操作不能借普通任务接口改写它们。
        const normalized = migrated.task_type === 'normal' ? ordinaryTodo(raw) : copy(raw);
        todos.set(raw.id, normalized);
        if (migrated.task_type === 'normal') knownChildren.set(raw.id, new Set(normalized.subtasks.map(child => child.id)));
    }
    return { data, todos, kinds, knownChildren };
}

function project(baseline, orderedRecords) {
    const { data, todos, kinds, knownChildren } = prepareBaseline(baseline);
    for (const record of orderedRecords) {
        record.operations.forEach(validateOperation);
        for (const operation of record.operations) {
            const todo = ordinaryTodo(operation.todo), previous = todos.get(todo.id);
            if (previous && kinds.get(todo.id) !== 'normal') fail('NORMAL_RECORD_TARGET_TYPE_CONFLICT');
            if (!previous && !uuid.test(todo.id)) fail('INVALID_NEW_TODO_ID');
            const children = knownChildren.get(todo.id) ?? new Set();
            for (const child of todo.subtasks) {
                if (!children.has(child.id) && !uuid.test(child.id)) fail('INVALID_NEW_SUBTASK_ID');
                children.add(child.id);
            }
            todos.set(todo.id, previous ? chooseNormalTodo(previous, todo) : todo);
            kinds.set(todo.id, 'normal');
            knownChildren.set(todo.id, children);
        }
    }
    data.todos = [...todos.values()].sort(compareId);
    if (orderedRecords.length) data.last_updated = orderedRecords.at(-1).created_at;
    return data;
}

export const NORMAL_TODO_PROFILE = Object.freeze({
    id: NORMAL_TODO_OPERATION_SET,
    validateBaseline: data => { prepareBaseline(data); },
    validateOperation,
    project
});
