import { PERSONAL_LEARNING_PROFILE } from './learning-record-profile.mjs';
import { migrateAndNormalize } from '../../windows/src/dataMerge.js';
import { applyCheckinDays, collectCheckin, refreshCheckinCompletion, validateCheckinOperation } from '../../windows/src/recordCheckins.js';

export { applyCheckinDays, checkinOperation, collectCheckin, refreshCheckinCompletion, weekOf } from '../../windows/src/recordCheckins.js';

const periodTypes = new Set(['weekly_checkin', 'monthly_checkin']);

function validateOperation(operation) {
    if (operation?.type === 'checkin.mark' || operation?.type === 'checkin.clear') validateCheckinOperation(operation);
    else PERSONAL_LEARNING_PROFILE.validateOperation(operation);
}

function project(baseline, orderedRecords) {
    const byTodo = new Map();
    const learningRecords = orderedRecords.map(record => ({ ...record,
        operations: record.operations.filter(operation => !collectCheckin(byTodo, operation)) }));
    const data = PERSONAL_LEARNING_PROFILE.project(baseline, learningRecords);
    const todos = new Map(data.todos.map(todo => [todo.id, todo]));
    for (const [id, days] of byTodo) {
        const todo = todos.get(id);
        if (!todo) throw new Error('CHECKIN_TARGET_NOT_ACTIVE_PERIOD');
        const period = migrateAndNormalize(structuredClone(todo));
        if (!periodTypes.has(period.task_type) || period.deleted) throw new Error('CHECKIN_TARGET_NOT_ACTIVE_PERIOD');
        if (applyCheckinDays(todo, days)) refreshCheckinCompletion(todo, period);
    }
    return data;
}

export const PERSONAL_CHECKIN_PROFILE = Object.freeze({
    id: 'lab-personal-checkin/1',
    validateBaseline: PERSONAL_LEARNING_PROFILE.validateBaseline,
    validateOperation,
    project
});
