import { canonicalJson, sha256Hex } from './stableJsonDigest.js';
import { periodTodoOperation } from './recordPeriods.js';
import { normalizeTimeEntry, timeEntryOperation } from './recordLearning.js';
import { weekOf } from './recordCheckins.js';
import { deletePeriods, deletePreview, importPeriodsAt, mergeSeriesData, normalizeSeriesData, timingPendingReason } from './taskSeries.js';
import { migrateAndNormalize } from './dataMerge.js';
import { todoTimestampMillis } from './normalTodoConflict.js';
import { finishTimeEntry } from './timeTracking.js';
import { isSeriesOperation, prepareSeriesRecords } from './recordSeries.js';

export const LEGACY_SERIES_OPERATION_SET = 'lab-collaboration/1';
export const CAUSAL_SERIES_OPERATION_SET = 'lab-collaboration/2';

const importType = 'series.workflow.import';
const deleteType = 'series.workflow.delete';
const manualStopType = 'time.entry.stop.manual';
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const uuid4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const nonempty = value => typeof value === 'string' && value.length > 0;
const isWorkflow = operation => operation?.type === importType || operation?.type === deleteType;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = code => { throw new Error(code); };

function uniqueStrings(values, predicate) {
    return Array.isArray(values) && values.every(predicate) && values.length === new Set(values).size;
}

export function validateSeriesWorkflowOperation(operation, preferManualStops = false) {
    if (preferManualStops && operation?.type === manualStopType) {
        validateManualStop(operation);
        return true;
    }
    if (!isWorkflow(operation)) return false;
    const importing = operation.type === importType;
    const fields = importing ? ['type', 'source_ids', 'target', 'updated_at', 'offset_minutes', 'generated_ids'] :
        ['type', 'series_id', 'todo_id', 'updated_at', 'member_ids', 'confirmed_timer_ids', 'preview_sha256'];
    if (Object.keys(operation).length !== fields.length || !fields.every(key => Object.hasOwn(operation, key))) fail('INVALID_SERIES_WORKFLOW');
    todoTimestampMillis(operation.updated_at);
    if (importing) {
        if (!uniqueStrings(operation.source_ids, value => matches(value, uuid)) || !operation.source_ids.length ||
            !matches(operation.target, /^\d{4}-(W\d{2}|\d{2})$/) ||
            !Number.isInteger(operation.offset_minutes) || Math.abs(operation.offset_minutes) > 840 ||
            !uniqueStrings(operation.generated_ids, value => matches(value, uuid4)) || !operation.generated_ids.length) fail('INVALID_SERIES_IMPORT');
    } else if (!matches(operation.series_id, uuid) || !matches(operation.todo_id, uuid) ||
        !uniqueStrings(operation.member_ids, value => matches(value, uuid)) || !operation.member_ids.length ||
        !uniqueStrings(operation.confirmed_timer_ids, nonempty) || !matches(operation.preview_sha256, /^[a-f\d]{64}$/)) {
        fail('INVALID_SERIES_DELETE');
    }
    return true;
}

export function importSeriesWorkflow({ sourceIds, target, updatedAt, offsetMinutes, generatedIds }) {
    const operation = { type: importType, source_ids: [...sourceIds], target, updated_at: updatedAt,
        offset_minutes: offsetMinutes, generated_ids: [...generatedIds] };
    validateSeriesWorkflowOperation(operation);
    return operation;
}

const previewHash = preview => sha256Hex(new TextEncoder().encode(canonicalJson(preview.signature)));
const memberIds = preview => preview.todos.map(todo => todo.id).sort();

export function deleteSeriesWorkflow(preview, updatedAt) {
    if (!preview?.all) fail('SERIES_DELETE_REQUIRES_ALL_PREVIEW');
    const operation = { type: deleteType, series_id: preview.seriesId, todo_id: preview.todoId,
        updated_at: updatedAt, member_ids: memberIds(preview), confirmed_timer_ids: preview.running.map(entry => entry.id).sort(),
        preview_sha256: previewHash(preview) };
    validateSeriesWorkflowOperation(operation);
    return operation;
}

function validateManualStop(operation) {
    if (Object.keys(operation).length !== 3 || !Object.hasOwn(operation, 'timer_id') ||
        !Object.hasOwn(operation, 'ended_at') || !nonempty(operation.timer_id)) fail('INVALID_MANUAL_TIMER_STOP');
    todoTimestampMillis(operation.ended_at);
}

export function manualTimerStop(timerId, endedAt) {
    const operation = { type: manualStopType, timer_id: timerId, ended_at: endedAt };
    validateManualStop(operation);
    return operation;
}

function manualStopOperation(view, operation) {
    const timer = view.time_entries.find(entry => entry.id === operation.timer_id);
    if (!timer || timer.deleted || timer.ended_at !== null) fail('MANUAL_TIMER_NOT_RUNNING');
    if (timingPendingReason(view, timer)) fail('MANUAL_TIMER_REQUIRES_END_REVIEW');
    const finished = finishTimeEntry(timer, operation.ended_at);
    return timeEntryOperation(finished.deleted ? 'delete' : 'put', finished);
}

function importEffects(view, operation) {
    const byId = new Map(view.todos.map(todo => [todo.id, todo]));
    const sources = operation.source_ids.map(id => byId.get(id));
    if (sources.some(todo => !todo)) fail('SERIES_IMPORT_SOURCE_NOT_FOUND');
    const localDay = new Date(todoTimestampMillis(operation.updated_at) + operation.offset_minutes * 60000).toISOString().slice(0, 10);
    const seriesIds = new Set(view.task_series.map(series => series.id));
    const oldLinks = new Map(view.task_series_links.map(link => [link.todo_id, link]));
    const occupied = new Set([...seriesIds, ...oldLinks.keys(), ...view.todos.flatMap(todo => [todo.id, ...(todo.subtasks ?? []).map(child => child.id)])]);
    let index = 0;
    function generate() {
        const value = operation.generated_ids[index++];
        if (!value || occupied.has(value)) fail('SERIES_IMPORT_GENERATED_ID_CONFLICT');
        return value;
    }
    const next = importPeriodsAt(view, sources, operation.target, operation.updated_at, generate,
        type => type === 'week' ? weekOf(localDay) : localDay.slice(0, 7));
    if (index !== operation.generated_ids.length) fail('SERIES_IMPORT_UNUSED_IDS');
    const sourceIds = new Set(operation.source_ids);
    return {
        operations: next.todos.slice(view.todos.length).map(todo => periodTodoOperation('create', todo)),
        series: next.task_series.filter(row => !seriesIds.has(row.id)),
        origins: next.task_series_links.filter(link => sourceIds.has(link.todo_id) && !seriesIds.has(link.series_id)),
        links: next.task_series_links.filter(row => !same(row, oldLinks.get(row.todo_id) ?? null))
            .map(row => ({ ...oldLinks.get(row.todo_id), ...row }))
    };
}

function deleteEffects(view, operation) {
    const current = view.task_series.find(row => row.id === operation.series_id);
    const preview = deletePreview(view, operation.todo_id, true);
    if (!current || current.deleted || preview.seriesId !== current.id || previewHash(preview) !== operation.preview_sha256 ||
        !same(memberIds(preview), operation.member_ids)) fail('SERIES_DELETE_PREVIEW_CHANGED');
    const members = new Set(operation.member_ids);
    const timerIds = new Set(operation.confirmed_timer_ids);
    const timers = (view.time_entries ?? []).filter(entry => timerIds.has(entry.id));
    if (timers.length !== timerIds.size || timers.some(entry => entry.task_ref?.source_type !== 'personal' ||
        entry.task_ref.source_id !== null || !members.has(entry.task_ref.todo_id))) fail('SERIES_DELETE_TIMER_OUTSIDE_PREVIEW');
    const confirmed = preview.running.filter(entry => timerIds.has(entry.id));
    const next = deletePeriods(view, { ...preview, running: confirmed }, operation.updated_at);
    const changedTimers = new Map(confirmed.map(entry => [entry.id, entry]));
    const operations = next.todos.filter(todo => members.has(todo.id)).map(todo => {
        const base = migrateAndNormalize(todo);
        return periodTodoOperation('delete', { ...base, completed_dates: [],
            completed: base.target_count ? false : base.completed,
            completed_at: base.target_count ? null : base.completed_at });
    });
    for (const entry of next.time_entries) {
        const previous = changedTimers.get(entry.id);
        if (previous && !same(previous, entry)) operations.push(timeEntryOperation('put', entry));
    }
    return { operations, series: [next.task_series.find(row => row.id === current.id)], links: [] };
}

function recordsWithManualStops(entries) {
    const stopsByTimer = new Map();
    for (const entry of entries) {
        if (entry.kind !== manualStopType) continue;
        const stops = stopsByTimer.get(entry.timerId) ?? [];
        stops.push(entry);
        stopsByTimer.set(entry.timerId, stops);
    }
    return entries.map(entry => {
        if (entry.kind !== deleteType || !stopsByTimer.size) return entry.record;
        const operations = entry.record.operations.filter(operation => {
            if (operation.type !== 'time.entry.put') return true;
            const stops = stopsByTimer.get(operation.entry.id) ?? [];
            // 只从投影排除并发自动结束，原始整体删除记录仍完整保留。
            return !stops.some(stop => !stop.ancestors.has(entry.record.id) && !entry.ancestors.has(stop.record.id));
        });
        return { ...entry.record, operations };
    });
}

function projectExpanded(baseline, entries, projectBase, preferManualStops) {
    const records = preferManualStops ? recordsWithManualStops(entries) : entries.map(entry => entry.record);
    const data = normalizeSeriesData(projectBase(baseline, records));
    if (!entries.some(entry => entry.effects)) return data;
    let result = { task_series: data.task_series, task_series_links: data.task_series_links };
    for (const { effects } of entries) {
        if (effects) result = mergeSeriesData(result, { task_series: effects.series, task_series_links: effects.links });
    }
    return { ...data, ...result };
}

function ancestorIdsOf(record, entries) {
    const seen = new Set(), stack = record.parents.map(parent => parent.id);
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        const parent = entries.get(id);
        if (!parent) fail('SERIES_WORKFLOW_MISSING_PARENT');
        seen.add(id);
        for (const reference of parent.record.parents) stack.push(reference.id);
    }
    return seen;
}

export function hasSeriesWorkflowRecords(records, causalSeries) {
    return records.some(record => record.operations.some(operation =>
        isWorkflow(operation) || operation?.type === manualStopType || (causalSeries && isSeriesOperation(operation))));
}

export function replaySeriesWorkflows(baseline, orderedRecords, projectBase, { preferManualStops = true, causalSeries = false } = {}) {
    const entries = new Map();
    const generatedIds = new Set(), seriesOrigins = new Map();
    for (const record of orderedRecords) {
        const operation = record.operations.find(operation => isWorkflow(operation) || (preferManualStops && operation?.type === manualStopType));
        if (!operation && causalSeries && record.operations.some(isSeriesOperation)) {
            const ancestors = ancestorIdsOf(record, entries);
            const causalEntries = [...entries.values()].filter(entry => ancestors.has(entry.record.id));
            const view = projectExpanded(baseline, causalEntries, projectBase, preferManualStops);
            const { records, changes } = prepareSeriesRecords(view, [record]);
            entries.set(record.id, { record: records[0], effects: changes });
            continue;
        }
        if (!operation) {
            entries.set(record.id, { record });
            continue;
        }
        if (record.operations.length !== 1) fail('SERIES_WORKFLOW_REQUIRES_OWN_RECORD');
        validateSeriesWorkflowOperation(operation, preferManualStops);
        const ancestors = ancestorIdsOf(record, entries);
        const causalEntries = [...entries.values()].filter(entry => ancestors.has(entry.record.id));
        const projected = projectExpanded(baseline, causalEntries, projectBase, preferManualStops);
        const view = { ...projected, time_entries: (projected.time_entries ?? []).map(entry => normalizeTimeEntry(entry, true)) };
        if (operation.type === manualStopType) {
            entries.set(record.id, { record: { ...record, operations: [manualStopOperation(view, operation)] },
                kind: manualStopType, timerId: operation.timer_id, ancestors });
            continue;
        }
        const effects = operation.type === importType ? importEffects(view, operation) : deleteEffects(view, operation);
        if (operation.type === importType) {
            for (const id of operation.generated_ids) {
                if (generatedIds.has(id)) fail('CONCURRENT_SERIES_IMPORT_ID_CONFLICT');
                generatedIds.add(id);
            }
            for (const { series_id, todo_id } of effects.origins) {
                const origin = seriesOrigins.get(series_id);
                if (origin && origin !== todo_id) fail('CONCURRENT_SERIES_IMPORT_ORIGIN_CONFLICT');
                seriesOrigins.set(series_id, todo_id);
            }
        }
        entries.set(record.id, { record: { ...record, operations: effects.operations }, effects, kind: operation.type, ancestors });
    }
    return projectExpanded(baseline, [...entries.values()], projectBase, preferManualStops);
}
