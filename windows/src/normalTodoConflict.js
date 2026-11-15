import { canonicalLearning, normalizeLabel } from './timeTracking.js';
import { canonicalJson, canonicalJsonDigest } from './stableJsonDigest.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = code => { throw new Error(code); };

// 比较实际时间点并截至毫秒，保留原时间字符串用于整条记录输出。
export function todoTimestampMillis(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid('INVALID_TODO_TIMESTAMP');
    const day = value.slice(0, 10);
    const dayTime = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(dayTime) || new Date(dayTime).toISOString().slice(0, 10) !== day ||
        +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59 ||
        value.at(-1) !== 'Z' && (+value.slice(-5, -3) > 23 || +value.slice(-2) > 59)) invalid('INVALID_TODO_TIMESTAMP');
    const result = Date.parse(value);
    if (!Number.isFinite(result)) invalid('INVALID_TODO_TIMESTAMP');
    return result;
}

// 只补默认值，不重排数组、不改写正文；未知扩展参与比较并随赢家保留。
export function normalizeNormalTodo(raw) {
    return normalizeTodo(raw, false);
}

export function normalizePeriodTodo(raw) {
    return normalizeTodo(raw, true);
}

function normalizeTodo(raw, period) {
    const todo = structuredClone(raw);
    if (!object(todo) || typeof todo.id !== 'string' || typeof todo.content !== 'string') invalid('INVALID_NORMAL_TODO');
    if (!period) todoTimestampMillis(todo.created_at);
    if (todo.updated_at === undefined || todo.updated_at === null || !period && todo.updated_at === '') todo.updated_at = todo.created_at;
    if (!period) todoTimestampMillis(todo.updated_at);
    const defaults = { date: null, time: null, completed: false, completed_at: null, order: 0,
        deleted: false, recurring: 'none', task_type: 'normal', completed_dates: [], target_count: null,
        reminder: null, subtasks: [], label: null };
    for (const [key, value] of Object.entries(defaults)) if (todo[key] === undefined) todo[key] = structuredClone(value);
    todo.label = normalizeLabel(todo.label);
    if (!period) todo.target_count = Number.isSafeInteger(todo.target_count) && todo.target_count > 0 ? todo.target_count : null;
    if (period ? !['weekly_checkin', 'monthly_checkin'].includes(todo.task_type) : todo.task_type !== 'normal') invalid('UNSUPPORTED_TODO_TYPE');
    if (![todo.date, todo.time].every(value => value === null || typeof value === 'string') ||
        typeof todo.completed !== 'boolean' || typeof todo.deleted !== 'boolean' ||
        typeof todo.order !== 'number' || !Number.isFinite(todo.order) || typeof todo.recurring !== 'string' ||
        !Array.isArray(todo.completed_dates) || todo.completed_dates.some(value => typeof value !== 'string') ||
        !Array.isArray(todo.subtasks)) invalid('INVALID_NORMAL_TODO');
    if (!period && todo.completed_at !== null) todoTimestampMillis(todo.completed_at);
    for (const subtask of todo.subtasks) {
        if (!object(subtask) || typeof subtask.id !== 'string' || typeof subtask.content !== 'string') invalid('INVALID_TODO_SUBTASK');
        if (subtask.completed === undefined) subtask.completed = false;
        if (subtask.completed_at === undefined) subtask.completed_at = null;
        if (typeof subtask.completed !== 'boolean') invalid('INVALID_TODO_SUBTASK');
        if (!period && subtask.completed_at !== null) todoTimestampMillis(subtask.completed_at);
    }
    if (todo.reminder !== null) {
        if (!object(todo.reminder) || typeof todo.reminder.reminder_time !== 'string') invalid('INVALID_TODO_REMINDER');
        if (todo.reminder.reminder_date === undefined) todo.reminder.reminder_date = null;
        if (todo.reminder.repeat_daily === undefined) todo.reminder.repeat_daily = false;
        if (todo.reminder.reminder_date !== null && typeof todo.reminder.reminder_date !== 'string' ||
            typeof todo.reminder.repeat_daily !== 'boolean') invalid('INVALID_TODO_REMINDER');
    }
    // 扩展也必须是相同的有限 JSON / Unicode 域，不能到平局最后一层才发现坏值。
    canonicalJson(todo);
    return todo;
}

// 输入必须已经归一。仅在前一层平局时才计算下一层键，避免普通更新走摘要计算。
export function chooseNormalTodo(first, second) {
    return chooseTodo(first, second, false);
}

export function choosePeriodTodoBase(first, second) {
    if (![first, second].every(todo => ['weekly_checkin', 'monthly_checkin'].includes(todo.task_type))) invalid('UNSUPPORTED_TODO_TYPE');
    return chooseTodo(first, second, true);
}

function chooseTodo(first, second, period) {
    if (first.id !== second.id) invalid('TODO_ID_MISMATCH');
    const time = value => {
        try { return todoTimestampMillis(value); }
        catch (error) { if (!period) throw error; return -Infinity; }
    };
    const firstTime = time(first.updated_at), secondTime = time(second.updated_at);
    if (firstTime !== secondTime) return firstTime > secondTime ? first : second;
    const businessKey = todo => {
        const business = { ...todo };
        delete business.id; delete business.created_at; delete business.updated_at;
        if (period) business.target_count = Number.isSafeInteger(business.target_count) && business.target_count > 0 ? business.target_count : null;
        return canonicalLearning(business);
    };
    const firstKey = businessKey(first), secondKey = businessKey(second);
    if (firstKey !== secondKey) return firstKey > secondKey ? first : second;
    return canonicalJsonDigest(first) >= canonicalJsonDigest(second) ? first : second;
}
