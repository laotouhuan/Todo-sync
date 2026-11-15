import { resolveCheckinConflict } from './dataMerge.js';
import { todoTimestampMillis } from './normalTodoConflict.js';

const checkinTypes = new Set(['checkin.mark', 'checkin.clear']);
const calendarDay = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = value => value.split('T', 1)[0];

function validDay(day) {
    if (typeof day !== 'string' || !calendarDay.test(day)) return false;
    const date = new Date(day + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function checkinOperation(action, fields) {
    if (!['mark', 'clear'].includes(action)) throw new Error('UNSUPPORTED_CHECKIN_ACTION');
    const operation = { ...fields, type: `checkin.${action}` };
    validateCheckinOperation(operation);
    return operation;
}

export function validateCheckinOperation(operation) {
    if (!checkinTypes.has(operation?.type)) throw new Error('UNSUPPORTED_OPERATION');
    const mark = operation.type === 'checkin.mark';
    const fields = mark ? ['type', 'todo_id', 'day', 'updated_at', 'value'] : ['type', 'todo_id', 'day', 'updated_at'];
    if (Object.keys(operation).length !== fields.length || !fields.every(key => Object.hasOwn(operation, key)) ||
        typeof operation.todo_id !== 'string' || !operation.todo_id.length || !validDay(operation.day)) {
        throw new Error('INVALID_CHECKIN_OPERATION');
    }
    const millis = todoTimestampMillis(operation.updated_at);
    if (mark) {
        if (typeof operation.value !== 'string' || dayOf(operation.value) !== operation.day) throw new Error('CHECKIN_VALUE_DAY_MISMATCH');
        if (operation.value !== operation.day) todoTimestampMillis(operation.value);
    }
    return millis;
}

function pickMark(previous, value) {
    return previous === undefined ? value : resolveCheckinConflict(previous, value, 0, 0);
}

export function weekOf(day) {
    // 用 UTC 日历运算确定 ISO 周，避免设备时区改变日历日期。
    const thursday = new Date(day + 'T00:00:00Z');
    thursday.setUTCDate(thursday.getUTCDate() + 3 - (thursday.getUTCDay() + 6) % 7);
    const start = new Date(thursday.getTime());
    start.setUTCMonth(0, 1);
    const week = 1 + Math.floor((thursday - start) / 604800000);
    return `${String(thursday.getUTCFullYear()).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

export function applyCheckinDays(todo, days) {
    const original = todo.completed_dates === undefined ? [] : todo.completed_dates;
    if (!Array.isArray(original) || original.some(value => typeof value !== 'string')) throw new Error('INVALID_CHECKIN_BASELINE_DATES');

    const originalsByDay = new Map();
    for (const value of original) {
        const day = dayOf(value);
        if (days.has(day)) {
            const values = originalsByDay.get(day) ?? [];
            values.push(value);
            originalsByDay.set(day, values);
        }
    }

    const changed = new Map();
    for (const day of [...days.keys()].sort()) {
        const { cutoff, marks } = days.get(day);
        const values = originalsByDay.get(day) ?? [];
        // 先看齐全部销卡，再筛选补卡，避免较长旧值遮住销卡后的新值。
        let winner = cutoff === -Infinity ? values.reduce(pickMark, undefined) : undefined;
        for (const { millis, value } of marks) {
            if (millis > cutoff) winner = pickMark(winner, value);
        }
        const unchanged = winner === undefined ? values.length === 0 : values.length === 1 && values[0] === winner;
        if (!unchanged) changed.set(day, winner);
    }
    if (!changed.size) return false;
    todo.completed_dates = original.filter(value => !changed.has(dayOf(value)));
    for (const winner of changed.values()) {
        if (winner !== undefined) todo.completed_dates.push(winner);
    }
    return true;
}

export function refreshCheckinCompletion(todo, period) {
    if (period.target_count && period.date) {
        const markedDays = new Set(todo.completed_dates.map(dayOf).filter(validDay));
        const periodOf = period.task_type === 'weekly_checkin' ? weekOf : day => day.slice(0, 7);
        const count = [...markedDays].filter(day => periodOf(day) === period.date).length;
        const completed = count >= period.target_count;
        todo.completed_at = completed && todo.completed === true ? todo.completed_at ?? null : null;
        todo.completed = completed;
    }
}

export function collectCheckin(byTodo, operation) {
    if (!checkinTypes.has(operation?.type)) return false;
    const millis = validateCheckinOperation(operation);
    const days = byTodo.get(operation.todo_id) ?? new Map();
    const day = days.get(operation.day) ?? { cutoff: -Infinity, marks: [] };
    if (operation.type === 'checkin.clear') day.cutoff = Math.max(day.cutoff, millis);
    else day.marks.push({ millis, value: operation.value });
    days.set(operation.day, day);
    byTodo.set(operation.todo_id, days);
    return true;
}
