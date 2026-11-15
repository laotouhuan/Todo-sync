import { PERSONAL_CORE_PROFILE } from './personal-record-profile.mjs';
import { mergeLearningRecords } from '../../windows/src/timeTracking.js';
import { timeTypes, reviewTypes, normalizeTimeEntry, normalizeDailyReview, validateLearningOperation } from '../../windows/src/recordLearning.js';

export { timeEntryOperation, dailyReviewOperation } from '../../windows/src/recordLearning.js';
export const PERSONAL_LEARNING_OPERATION_SET = 'lab-personal-learning/1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => { throw new Error(code); };

function validateOperation(operation) {
    if (!validateLearningOperation(operation)) PERSONAL_CORE_PROFILE.validateOperation(operation);
}

function prepareBaseline(baseline) {
    PERSONAL_CORE_PROFILE.validateBaseline(baseline);
    const timeEntries = baseline.time_entries === undefined ? [] : baseline.time_entries;
    const dailyReviews = baseline.daily_reviews === undefined ? [] : baseline.daily_reviews;
    if (!Array.isArray(timeEntries) || !Array.isArray(dailyReviews)) fail('INVALID_LEARNING_BASELINE');
    const times = timeEntries.map(entry => normalizeTimeEntry(entry, true));
    const reviews = dailyReviews.map(review => normalizeDailyReview(review, true));
    // 按日期收集全部原始复盘身份，保留同日输掉归并的旧ID。
    const reviewIds = new Map();
    for (const review of reviews) {
        const ids = reviewIds.get(review.date) ?? new Set();
        ids.add(review.id);
        reviewIds.set(review.date, ids);
    }
    return { times, reviews, timeIds: new Set(times.map(entry => entry.id)), reviewIds };
}

function project(baseline, orderedRecords) {
    const { times, reviews, timeIds, reviewIds } = prepareBaseline(baseline);
    for (const record of orderedRecords) record.operations.forEach(validateOperation);
    const coreRecords = orderedRecords.map(record => ({ ...record, operations: record.operations
        .filter(operation => !timeTypes.has(operation.type) && !reviewTypes.has(operation.type)) }));
    const data = PERSONAL_CORE_PROFILE.project(baseline, coreRecords);
    for (const record of orderedRecords) for (const operation of record.operations) {
        if (timeTypes.has(operation.type)) {
            const entry = normalizeTimeEntry(operation.entry);
            if (!timeIds.has(entry.id) && !uuid.test(entry.id)) fail('INVALID_NEW_TIME_ENTRY_ID');
            timeIds.add(entry.id);
            times.push(entry);
        } else if (reviewTypes.has(operation.type)) {
            const review = normalizeDailyReview(operation.review);
            const ids = reviewIds.get(review.date) ?? new Set();
            if (!ids.has(review.id) && !uuid.test(review.id)) fail('INVALID_NEW_DAILY_REVIEW_ID');
            ids.add(review.id);
            reviewIds.set(review.date, ids);
            reviews.push(review);
        }
    }
    data.time_entries = mergeLearningRecords(times);
    data.daily_reviews = mergeLearningRecords(reviews, [], 'date');
    if (orderedRecords.length) data.last_updated = orderedRecords.at(-1).created_at;
    return data;
}

export const PERSONAL_LEARNING_PROFILE = Object.freeze({
    id: PERSONAL_LEARNING_OPERATION_SET,
    validateBaseline: data => { prepareBaseline(data); },
    validateOperation,
    project
});
