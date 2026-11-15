import { migrateAndNormalize } from './dataMerge.js';
import { normalizeNormalTodo, todoTimestampMillis } from './normalTodoConflict.js';
import { periodTodoOperation, seesRecord } from './recordPeriods.js';

export const collaborationCreateType = 'collaboration.todo.create';
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const types = new Set(['normal', 'weekly_checkin', 'monthly_checkin']);
const fail = code => { throw new Error(code); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const validId = value => typeof value === 'string' && uuid.test(value);
const validContent = value => typeof value === 'string' && value.trim().length > 0;

export function validateCollaborationCreate(operation) {
    if (!exact(operation, ['type', 'todo']) || operation.type !== collaborationCreateType) fail('INVALID_COLLABORATION_CREATE');
    const todo = operation.todo;
    if (!exact(todo, ['id', 'content', 'date', 'task_type', 'target_count', 'subtasks', 'created_at', 'order']) ||
        !validId(todo.id) || !validContent(todo.content) || !types.has(todo.task_type) ||
        !Number.isFinite(todo.order) || !Array.isArray(todo.subtasks)) fail('INVALID_COLLABORATION_TODO');
    todoTimestampMillis(todo.created_at);
    if (todo.target_count !== null && (!Number.isInteger(todo.target_count) || todo.target_count < 1 || todo.target_count > 2147483647)) {
        fail('INVALID_COLLABORATION_TARGET_COUNT');
    }
    const ids = new Set([todo.id]);
    for (const child of todo.subtasks) {
        if (!exact(child, ['id', 'content']) || !validId(child.id) || !validContent(child.content) || ids.has(child.id)) {
            fail('INVALID_COLLABORATION_SUBTASK');
        }
        ids.add(child.id);
    }
    if (todo.task_type === 'normal') {
        if (todo.target_count !== null) fail('INVALID_COLLABORATION_TARGET_COUNT');
        if (todo.date !== null) {
            if (typeof todo.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(todo.date)) fail('INVALID_COLLABORATION_DATE');
            todoTimestampMillis(todo.date + 'T00:00:00Z');
        }
    }
    const candidate = { ...todo, updated_at: todo.created_at };
    return todo.task_type === 'normal'
        ? { type: 'todo.normal.put', todo: normalizeNormalTodo(migrateAndNormalize(structuredClone(candidate))) }
        : periodTodoOperation('create', candidate);
}

export function collaborationTodoCreate(todo) {
    const operation = { type: collaborationCreateType, todo: structuredClone(todo) };
    validateCollaborationCreate(operation);
    return operation;
}

export function translateCollaborationRecords(baseline, orderedRecords) {
    const existing = new Set(baseline.todos.map(todo => todo.id.toLowerCase()));
    const records = new Map(orderedRecords.map(record => [record.id, record]));
    const creates = new Map();
    const translated = orderedRecords.map(record => {
        const operation = record.operations.find(operation => operation?.type === collaborationCreateType);
        if (!operation) return record;
        if (record.operations.length !== 1) fail('COLLABORATION_REQUIRES_ONE_CREATE');
        const candidate = validateCollaborationCreate(operation);
        const id = candidate.todo.id;
        if (existing.has(id) || creates.has(id)) fail('COLLABORATION_TODO_ALREADY_EXISTS');
        creates.set(id, record);
        return { ...record, operations: [candidate] };
    });
    // 普通任务的所有者入口是新增／编辑共用，必须确认同 ID 修改认识这次新增。
    for (const record of orderedRecords) {
        for (const operation of record.operations) {
            if (!['todo.normal.put', 'todo.normal.delete', 'todo.period.create', 'todo.period.put', 'todo.period.delete'].includes(operation?.type)) continue;
            const id = operation.todo?.id;
            const creator = typeof id === 'string' && creates.get(id.toLowerCase());
            if (!creator) continue;
            if (id !== id.toLowerCase() || !seesRecord(record, creator, records)) fail('COLLABORATION_TODO_ID_CONFLICT');
        }
    }
    return translated;
}
