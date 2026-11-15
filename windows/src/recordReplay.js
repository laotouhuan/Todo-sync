import { migrateAndNormalize } from './dataMerge.js';
import { chooseNormalTodo, normalizeNormalTodo, todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson } from './stableJsonDigest.js';
import { preparePeriodRecords } from './recordPeriods.js';
import { translateCollaborationRecords } from './recordCollaboration.js';
import { prepareSeriesRecords } from './recordSeries.js';
import { CAUSAL_SERIES_OPERATION_SET, LEGACY_SERIES_OPERATION_SET, hasSeriesWorkflowRecords, replaySeriesWorkflows } from './recordSeriesWorkflows.js';
import { chooseReminderSettings, normalizeReminderSettings } from './reminderSettingsConflict.js';
import { replayLearningOperations, validateLearningOperation } from './recordLearning.js';
import { applyPlanningOperations, validatePlanningRecords } from './weeklyPlanning.js';

export const PLANNING_OPERATION_SET = 'lab-planning/1';
export const CLOUD_PLANNING_OPERATION_SET = 'planning/1';
const planningTypes = new Set(['planning.version.save', 'planning.version.delete', 'planning.selection.resolve', 'planning.rating.put']);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normalTypes = new Set(['todo.normal.put', 'todo.normal.delete']);
const ruleConditions = new Set(['none_completed', 'any_remaining', 'unconditional']);
const ruleScopes = new Set(['all', 'today_only', 'recurring_only']);

function applyReminderRecord(data, operation, known) {
    if (Object.keys(operation).length !== 2 || !Object.hasOwn(operation, 'settings')) throw new Error('INVALID_REMINDER_RECORD');
    const current = normalizeReminderSettings(data.reminder_settings);
    const candidate = normalizeReminderSettings(operation.settings);
    if (canonicalJson(candidate) !== canonicalJson(operation.settings)) throw new Error('INVALID_REMINDER_RECORD');
    todoTimestampMillis(candidate.updated_at);
    for (const rule of current.global_rules) known.add(rule.id);
    for (const rule of candidate.global_rules) {
        if (!ruleConditions.has(rule.condition) || !ruleScopes.has(rule.task_scope)) throw new Error('UNSUPPORTED_REMINDER_RULE_ENUM');
        if (!known.has(rule.id) && !uuid.test(rule.id)) throw new Error('INVALID_NEW_REMINDER_RULE_ID');
        known.add(rule.id);
    }
    data.reminder_settings = chooseReminderSettings(data, { reminder_settings: candidate, last_updated: data.last_updated });
}

// 后端已确认封装、字节和依赖闭包。先构建副本，失败时由调用方继续展示上次完整结果。
export function replayPersonalRecords(baseline, records, operationSet = LEGACY_SERIES_OPERATION_SET) {
    if (baseline?.version !== 1 || !Array.isArray(baseline.todos)) throw new Error('INVALID_RECORD_BASELINE');
    if (operationSet === CLOUD_PLANNING_OPERATION_SET) {
        if (baseline.todos.length || records.some(record => record.operations.length !== 1 || !planningTypes.has(record.operations[0]?.type))) {
            throw new Error('INVALID_PLANNING_OPERATION');
        }
        validatePlanningRecords(baseline, records);
        const data = structuredClone(baseline);
        applyPlanningOperations(data, records.flatMap(record => record.operations));
        return data;
    }
    const planning = operationSet === PLANNING_OPERATION_SET;
    const causalSeries = planning || operationSet === CAUSAL_SERIES_OPERATION_SET;
    if (!causalSeries && operationSet !== LEGACY_SERIES_OPERATION_SET) throw new Error('UNSUPPORTED_RECORD_OPERATION_SET');
    if (planning) validatePlanningRecords(baseline, records);
    const translated = translateCollaborationRecords(baseline, records);
    const project = (data, events) => replayBaseRecords(data, events, planning);
    return hasSeriesWorkflowRecords(translated, causalSeries)
        ? replaySeriesWorkflows(baseline, translated, project, { causalSeries })
        : project(baseline, translated);
}

function replayBaseRecords(baseline, records, planning) {
    todoTimestampMillis(baseline.last_updated);
    const data = structuredClone(baseline), todos = new Map(), kinds = new Map(), children = new Map();
    for (const raw of data.todos) {
        if (typeof raw?.id !== 'string' || todos.has(raw.id)) throw new Error('AMBIGUOUS_BASELINE_TODO_ID');
        const migrated = migrateAndNormalize(structuredClone(raw));
        kinds.set(raw.id, migrated.task_type);
        if (migrated.task_type === 'normal') {
            const normalized = normalizeNormalTodo(migrated);
            todos.set(raw.id, normalized);
            children.set(raw.id, new Set(normalized.subtasks.map(child => child.id)));
        } else {
            todos.set(raw.id, raw);
        }
    }
    const series = prepareSeriesRecords(baseline, records);
    const periods = preparePeriodRecords(baseline, series.records);
    const reminderRuleIds = new Set(), learning = [], plans = [];
    for (const record of periods.records) {
        todoTimestampMillis(record.created_at);
        for (const operation of record.operations) {
            if (planning && operation?.type?.startsWith?.('planning.')) {
                plans.push(operation);
                continue;
            }
            if (validateLearningOperation(operation)) {
                learning.push(operation);
                continue;
            }
            if (operation?.type === 'reminder.settings.put') {
                applyReminderRecord(data, operation, reminderRuleIds);
                continue;
            }
            if (!normalTypes.has(operation?.type)) throw new Error('UNSUPPORTED_RECORD_OPERATION');
            if (Object.keys(operation).length !== 2 || !Object.hasOwn(operation, 'todo')) throw new Error('INVALID_NORMAL_RECORD');
            const candidate = normalizeNormalTodo(migrateAndNormalize(structuredClone(operation.todo)));
            if (candidate.deleted !== (operation.type === 'todo.normal.delete') ||
                canonicalJson(candidate) !== canonicalJson(operation.todo)) throw new Error('INVALID_NORMAL_RECORD');
            const { id } = candidate, previous = todos.get(id);
            if (previous && kinds.get(id) !== 'normal') throw new Error('NORMAL_RECORD_TARGET_TYPE_CONFLICT');
            if (!previous && !uuid.test(id)) throw new Error('INVALID_NEW_TODO_ID');
            const known = children.get(id) ?? new Set();
            for (const child of candidate.subtasks) {
                if (!known.has(child.id) && !uuid.test(child.id)) throw new Error('INVALID_NEW_SUBTASK_ID');
                known.add(child.id);
            }
            children.set(id, known);
            kinds.set(id, 'normal');
            todos.set(id, previous ? chooseNormalTodo(previous, candidate) : candidate);
        }
    }
    periods.applyTo(todos);
    series.applyTo(data);
    replayLearningOperations(data, learning);
    if (planning) applyPlanningOperations(data, plans);
    data.todos = [...todos.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (records.length) data.last_updated = records.at(-1).created_at;
    return data;
}
