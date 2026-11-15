import { PERSONAL_LEARNING_PROFILE } from './learning-record-profile.mjs';
import { PERSONAL_CHECKIN_PROFILE } from './checkin-record-profile.mjs';
import { preparePeriodRecords, validatePeriodOperation } from '../../windows/src/recordPeriods.js';

export { periodTodoOperation } from '../../windows/src/recordPeriods.js';

export const PERSONAL_PERIOD_PROFILE = Object.freeze({
    id: 'lab-personal-period/1',
    validateBaseline: PERSONAL_LEARNING_PROFILE.validateBaseline,
    validateOperation(operation) {
        if (!validatePeriodOperation(operation)) PERSONAL_CHECKIN_PROFILE.validateOperation(operation);
    },
    project(baseline, orderedRecords) {
        const { records, applyTo } = preparePeriodRecords(baseline, orderedRecords);
        const data = PERSONAL_LEARNING_PROFILE.project(baseline, records);
        const todos = new Map(data.todos.map(todo => [todo.id, todo]));
        applyTo(todos);
        data.todos = [...todos.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        return data;
    }
});
