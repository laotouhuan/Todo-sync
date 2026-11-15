import { mergeSeriesData, normalizeSeriesData, normalizedTaskName, periodType } from './taskSeries.js';
import { migrateAndNormalize } from './dataMerge.js';
import { todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson } from './stableJsonDigest.js';

const seriesTypes = new Set(['series.rename', 'series.link.put', 'series.link.unlink']);
const id = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const newId = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function isSeriesOperation(operation) {
    return seriesTypes.has(operation?.type);
}

export function seriesOperation(action, fields) {
    const type = `series.${action}`;
    if (!seriesTypes.has(type)) throw new Error('UNSUPPORTED_SERIES_ACTION');
    const operation = { ...fields, type };
    validateSeriesOperation(operation);
    return operation;
}

export function validateSeriesOperation(operation) {
    if (!isSeriesOperation(operation)) return false;
    const fields = ['type', 'series_id', 'updated_at'];
    if (operation.type === 'series.rename') fields.push('content');
    else fields.push('todo_id');
    if (operation.type === 'series.link.unlink') fields.push('next_series_id');
    if (Object.keys(operation).length !== fields.length || !fields.every(key => Object.hasOwn(operation, key)) ||
        typeof operation.series_id !== 'string' || !id.test(operation.series_id)) throw new Error('INVALID_SERIES_OPERATION');
    if (operation.type === 'series.rename') {
        if (typeof operation.content !== 'string' || !normalizedTaskName(operation.content)) throw new Error('INVALID_SERIES_NAME');
    } else if (typeof operation.todo_id !== 'string' || !id.test(operation.todo_id)) throw new Error('INVALID_SERIES_LINK_TODO_ID');
    if (operation.type === 'series.link.unlink' &&
        (typeof operation.next_series_id !== 'string' || !newId.test(operation.next_series_id))) throw new Error('INVALID_NEXT_SERIES_ID');
    todoTimestampMillis(operation.updated_at);
    canonicalJson(operation);
    return true;
}

export function baselineSeries(baseline) {
    return normalizeSeriesData(structuredClone({
        task_series: baseline.task_series,
        task_series_links: baseline.task_series_links
    }));
}

export function prepareSeriesRecords(baseline, orderedRecords) {
    const seeded = baselineSeries(baseline);
    const series = new Map(seeded.task_series.map(item => [item.id, item]));
    const links = new Map(seeded.task_series_links.map(item => [item.todo_id, item]));
    const todos = new Map(baseline.todos.map(item => [item.id, item]));
    const names = new Map(), associations = new Map();
    const periodRecords = orderedRecords.map(record => {
        const operations = record.operations.filter(operation => {
            if (!isSeriesOperation(operation)) return true;
            validateSeriesOperation(operation);
            const original = series.get(operation.series_id);
            if (!original || original.deleted) throw new Error('SERIES_TARGET_NOT_ACTIVE_IN_BASELINE');
            if (operation.type === 'series.rename') {
                const candidate = { ...original, content: operation.content, content_renamed: true,
                    content_updated_at: operation.updated_at, updated_at: operation.updated_at };
                const merged = mergeSeriesData({ task_series: [names.get(original.id) ?? original] }, { task_series: [candidate] });
                names.set(original.id, merged.task_series[0]);
                return false;
            }
            const initial = links.get(operation.todo_id);
            if (!initial || initial.series_id !== original.id) throw new Error('SERIES_LINK_TARGET_NOT_IN_BASELINE');
            const unlink = operation.type === 'series.link.unlink';
            if (!unlink) {
                const todo = migrateAndNormalize(structuredClone(todos.get(initial.todo_id)));
                if (!todo || todo.deleted || todo.date !== initial.period || periodType(todo) !== original.period_type) {
                    throw new Error('SERIES_RELINK_TODO_NOT_ACTIVE_IN_BASELINE');
                }
            }
            const candidate = { ...initial, updated_at: operation.updated_at, deleted: unlink,
                next_series_id: unlink ? operation.next_series_id : null };
            const merged = mergeSeriesData({ task_series_links: [associations.get(initial.todo_id) ?? initial] },
                { task_series_links: [candidate] });
            associations.set(initial.todo_id, merged.task_series_links[0]);
            return false;
        });
        return { ...record, operations };
    });

    return {
        records: periodRecords,
        changes: { series: [...names.values()], links: [...associations.values()] },
        applyTo(data) {
            if (names.size) data.task_series = seeded.task_series.map(item => names.get(item.id) ?? item)
                .sort((a, b) => compare(a.id, b.id));
            if (associations.size) data.task_series_links = seeded.task_series_links.map(item => associations.get(item.todo_id) ?? item)
                .sort((a, b) => compare(a.todo_id, b.todo_id));
        }
    };
}
