import { migrateAndNormalize } from './dataMerge.js';
import { choosePeriodTodoBase, normalizePeriodTodo, todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson } from './stableJsonDigest.js';
import { applyCheckinDays, collectCheckin, refreshCheckinCompletion, weekOf } from './recordCheckins.js';

const baseTypes = new Set(['todo.period.create', 'todo.period.put', 'todo.period.delete']);
const checkinTypes = new Set(['checkin.mark', 'checkin.clear']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => { throw new Error(code); };

function validPeriod(todo) {
    if (typeof todo.date !== 'string') return false;
    if (todo.task_type === 'monthly_checkin') return /^\d{4}-(0[1-9]|1[0-2])$/.test(todo.date);
    if (todo.task_type !== 'weekly_checkin' || !/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(todo.date)) return false;
    return todo.date.slice(6) <= weekOf(todo.date.slice(0, 4) + '-12-28').slice(6);
}

function baseTodo(raw) {
    if (!raw || typeof raw !== 'object' || !validPeriod(raw) || !raw.id) fail('INVALID_PERIOD_BASE');
    todoTimestampMillis(raw.created_at);
    todoTimestampMillis(raw.updated_at);
    if (raw.target_count != null && (!Number.isInteger(raw.target_count) || raw.target_count < 1 ||
        raw.target_count > 2147483647)) fail('INVALID_PERIOD_TARGET_COUNT');
    const todo = normalizePeriodTodo(raw);
    if (!['none', 'daily_repeat'].includes(todo.recurring)) fail('INVALID_PERIOD_RECURRING');
    if (todo.completed_dates.length || todo.target_count && (todo.completed || todo.completed_at !== null)) fail('PERIOD_BASE_INCLUDES_CHECKIN_PROJECTION');
    if (todo.completed_at !== null) todoTimestampMillis(todo.completed_at);
    const children = new Set();
    for (const child of todo.subtasks) {
        if (!child.id || children.has(child.id)) fail('INVALID_PERIOD_SUBTASK_ID');
        children.add(child.id);
        if (child.completed_at !== null) todoTimestampMillis(child.completed_at);
    }
    return todo;
}

export function periodTodoOperation(action, raw) {
    const type = `todo.period.${action}`;
    if (!baseTypes.has(type)) fail('UNSUPPORTED_PERIOD_BASE_ACTION');
    const operation = { type, todo: baseTodo(raw) };
    validatePeriodOperation(operation);
    return operation;
}

export function validatePeriodOperation(operation) {
    if (!baseTypes.has(operation?.type)) return false;
    if (Object.keys(operation).length !== 2 || !Object.hasOwn(operation, 'todo')) fail('UNSUPPORTED_OPERATION');
    const todo = baseTodo(operation.todo);
    if (canonicalJson(todo) !== canonicalJson(operation.todo)) fail('NON_NORMALIZED_PERIOD_BASE_OPERATION');
    if (todo.deleted !== (operation.type === 'todo.period.delete')) fail('PERIOD_BASE_DELETE_KIND_MISMATCH');
    return true;
}

function baselineCandidate(todo) {
    const base = normalizePeriodTodo(migrateAndNormalize(structuredClone(todo)));
    base.completed_dates = [];
    if (base.target_count) {
        base.completed = false;
        base.completed_at = null;
    }
    return base;
}

export function seesRecord(record, creation, records) {
    if (!creation || creation.id === record.id) return true;
    const parents = record.parents.map(parent => parent.id);
    const visited = new Set();
    while (parents.length) {
        const id = parents.pop();
        if (id === creation.id) return true;
        if (visited.has(id)) continue;
        visited.add(id);
        const parent = records.get(id);
        if (parent.lamport > creation.lamport) for (const reference of parent.parents) parents.push(reference.id);
    }
    return false;
}

export function preparePeriodRecords(baseline, orderedRecords) {
    const seeded = new Map(baseline.todos.map(todo => [todo.id, todo]));
    const records = new Map(orderedRecords.map(record => [record.id, record]));
    const periods = new Map(), days = new Map(), learningRecords = [];
    const normalIds = new Set();

    function existing(id) {
        const period = periods.get(id);
        if (period) return period;
        const original = seeded.get(id);
        if (!original) fail('PERIOD_TARGET_WITHOUT_CREATION');
        const migrated = migrateAndNormalize(structuredClone(original));
        if (!validPeriod(migrated) || migrated.deleted) fail('CHECKIN_TARGET_NOT_ACTIVE_PERIOD');
        const entry = { original, identity: migrated, winner: null, legacyChildren: new Set(migrated.subtasks.map(child => child.id)) };
        periods.set(id, entry);
        return entry;
    }

    for (const record of orderedRecords) {
        // 同一原子批次允许创建和首次打卡；跨批次必须可追溯到创建记录。
        for (const operation of record.operations) {
            if (operation.type !== 'todo.period.create') continue;
            validatePeriodOperation(operation);
            const todo = operation.todo;
            if (seeded.has(todo.id) || periods.has(todo.id)) fail('PERIOD_CREATION_ID_CONFLICT');
            if (!uuid.test(todo.id)) fail('INVALID_NEW_PERIOD_TODO_ID');
            periods.set(todo.id, { identity: todo, winner: todo, creation: record, legacyChildren: new Set() });
        }
        const inherited = [];
        for (const operation of record.operations) {
            const base = baseTypes.has(operation.type);
            const checkin = checkinTypes.has(operation.type);
            if (!base && !checkin) {
                if (operation.type === 'todo.normal.put' || operation.type === 'todo.normal.delete') normalIds.add(operation.todo?.id);
                inherited.push(operation);
                continue;
            }
            const entry = existing(base ? operation.todo?.id : operation.todo_id);
            if (!seesRecord(record, entry.creation, records)) fail('PERIOD_CREATION_NOT_IN_CAUSAL_HISTORY');
            if (checkin) {
                collectCheckin(days, operation);
                continue;
            }
            validatePeriodOperation(operation);
            const todo = operation.todo;
            if (todo.task_type !== entry.identity.task_type || todo.date !== entry.identity.date) fail('PERIOD_MOVE_UNSUPPORTED');
            for (const child of todo.subtasks) {
                if (!entry.legacyChildren.has(child.id) && !uuid.test(child.id)) fail('INVALID_NEW_PERIOD_SUBTASK_ID');
            }
            const previous = entry.winner ?? baselineCandidate(entry.original);
            const winner = choosePeriodTodoBase(previous, todo);
            if (winner === todo) entry.winner = todo;
        }
        learningRecords.push({ ...record, operations: inherited });
    }
    for (const id of periods.keys()) {
        if (normalIds.has(id)) fail('PERIOD_NORMAL_ID_CONFLICT');
    }
    return {
        records: learningRecords,
        applyTo(todos) {
            for (const [id, entry] of periods) {
                const todo = structuredClone(entry.winner ?? entry.original);
                if (entry.winner && entry.original) {
                    if (entry.original.completed_dates !== undefined) todo.completed_dates = structuredClone(entry.original.completed_dates);
                    if (todo.target_count && todo.target_count === entry.original.target_count && entry.original.completed === true) {
                        todo.completed = true;
                        todo.completed_at = entry.original.completed_at ?? null;
                    }
                }
                const changed = applyCheckinDays(todo, days.get(id) ?? new Map());
                if (changed || entry.winner) refreshCheckinCompletion(todo, entry.winner ?? entry.identity);
                todos.set(id, todo);
            }
        }
    };
}
