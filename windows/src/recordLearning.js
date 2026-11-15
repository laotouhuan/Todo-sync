import { mergeLearningRecords, normalizeLabel } from './timeTracking.js';
import { todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson } from './stableJsonDigest.js';

export const timeTypes = new Set(['time.entry.put', 'time.entry.delete']);
export const reviewTypes = new Set(['daily.review.put', 'daily.review.delete']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const fail = code => { throw new Error(code); };
const copy = value => JSON.parse(canonicalJson(value));

function normalizeIdentity(raw, legacy) {
    const row = copy(raw);
    if (!object(row) || !nonempty(row.id)) fail('INVALID_LEARNING_RECORD');
    if (!Object.hasOwn(row, 'updated_at')) {
        if (!legacy) fail('LEARNING_OPERATION_UPDATE_CLOCK_REQUIRED');
        row.updated_at = row.created_at;
    }
    todoTimestampMillis(row.created_at);
    todoTimestampMillis(row.updated_at);
    if (!Object.hasOwn(row, 'deleted')) row.deleted = false;
    if (typeof row.deleted !== 'boolean') fail('INVALID_LEARNING_RECORD');
    return row;
}

export function normalizeTimeEntry(raw, legacy = false) {
    const entry = normalizeIdentity(raw, legacy);
    if (!object(entry.task_ref) || !nonempty(entry.task_ref.todo_id)) fail('INVALID_TIME_ENTRY_TASK_REF');
    if (!Object.hasOwn(entry.task_ref, 'source_type')) entry.task_ref.source_type = 'personal';
    if (!Object.hasOwn(entry.task_ref, 'source_id')) entry.task_ref.source_id = null;
    if (!['personal', 'collaboration'].includes(entry.task_ref.source_type) ||
        entry.task_ref.source_id !== null && typeof entry.task_ref.source_id !== 'string') fail('INVALID_TIME_ENTRY_TASK_REF');
    if (!Object.hasOwn(entry, 'task_content_snapshot')) entry.task_content_snapshot = '';
    if (!Object.hasOwn(entry, 'label_snapshot')) entry.label_snapshot = null;
    if (!Object.hasOwn(entry, 'ended_at')) entry.ended_at = null;
    if (typeof entry.task_content_snapshot !== 'string' || entry.label_snapshot !== null && typeof entry.label_snapshot !== 'string') fail('INVALID_TIME_ENTRY_SNAPSHOT');
    entry.label_snapshot = normalizeLabel(entry.label_snapshot);
    const started = todoTimestampMillis(entry.started_at);
    if (entry.ended_at !== null && todoTimestampMillis(entry.ended_at) < started) fail('INVALID_TIME_ENTRY_INTERVAL');
    return entry;
}

export function normalizeDailyReview(raw, legacy = false) {
    const review = normalizeIdentity(raw, legacy);
    if (typeof review.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(review.date)) fail('INVALID_DAILY_REVIEW_DATE');
    todoTimestampMillis(`${review.date}T00:00:00Z`);
    for (const field of ['fact', 'obstacle', 'effective_action', 'next_step']) {
        if (!Object.hasOwn(review, field)) review[field] = '';
        if (typeof review[field] !== 'string') fail('INVALID_DAILY_REVIEW_TEXT');
    }
    return review;
}

/** 动作时间由调用方固定；删除运行记录可以显式保留null结束时间。 */
export function timeEntryOperation(action, raw) {
    if (!['put', 'delete'].includes(action)) fail('UNSUPPORTED_TIME_ENTRY_ACTION');
    if (action === 'delete' && (!object(raw) || !Object.hasOwn(raw, 'ended_at'))) fail('TIME_ENTRY_DELETE_END_STATE_REQUIRED');
    const operation = { type: `time.entry.${action}`, entry: normalizeTimeEntry(raw) };
    validateLearningOperation(operation);
    return operation;
}

export function dailyReviewOperation(action, raw) {
    if (!['put', 'delete'].includes(action)) fail('UNSUPPORTED_DAILY_REVIEW_ACTION');
    const operation = { type: `daily.review.${action}`, review: normalizeDailyReview(raw) };
    validateLearningOperation(operation);
    return operation;
}

export function validateLearningOperation(operation) {
    const timer = timeTypes.has(operation?.type), review = reviewTypes.has(operation?.type);
    if (!timer && !review) return false;
    const field = timer ? 'entry' : 'review';
    if (!object(operation) || Object.keys(operation).length !== 2 || !Object.hasOwn(operation, 'type') || !Object.hasOwn(operation, field)) fail('UNSUPPORTED_OPERATION');
    const normalized = timer ? normalizeTimeEntry(operation.entry) : normalizeDailyReview(operation.review);
    if (canonicalJson(normalized) !== canonicalJson(operation[field])) fail('NON_NORMALIZED_LEARNING_OPERATION');
    if (normalized.deleted !== operation.type.endsWith('.delete')) fail('LEARNING_DELETE_KIND_MISMATCH');
    return true;
}

export function replayLearningOperations(data, operations) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const [types, collection, field, normalize, key, invalidId] of [
        [timeTypes, 'time_entries', 'entry', normalizeTimeEntry, 'id', 'INVALID_NEW_TIME_ENTRY_ID'],
        [reviewTypes, 'daily_reviews', 'review', normalizeDailyReview, 'date', 'INVALID_NEW_DAILY_REVIEW_ID']
    ]) {
        const candidates = operations.filter(operation => types.has(operation.type)).map(operation => operation[field]);
        if (!candidates.length) continue;
        const raw = data[collection] === undefined ? [] : data[collection];
        if (!Array.isArray(raw)) fail('INVALID_LEARNING_BASELINE');
        const baseline = raw.map(entry => normalize(entry, true));
        const identities = new Map();
        for (const entry of baseline) {
            const ids = identities.get(entry[key]) ?? new Set();
            identities.set(entry[key], ids);
            ids.add(entry.id);
        }
        for (const entry of candidates) {
            const ids = identities.get(entry[key]) ?? new Set();
            identities.set(entry[key], ids);
            if (!ids.has(entry.id) && !uuid.test(entry.id)) fail(invalidId);
            ids.add(entry.id);
        }
        data[collection] = mergeLearningRecords(baseline, candidates, key);
    }
}
