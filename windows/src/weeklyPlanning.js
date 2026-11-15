import { todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson } from './stableJsonDigest.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const collections = {
    weekly_plan_versions: { base_version_id: null, days: Array(7).fill(''), change_reason: '', deleted: false, deleted_at: null },
    weekly_plan_selections: { parent_selection_ids: [], kind: 'save' },
    daily_ratings: { score: null, deleted: false }
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const clock = todoTimestampMillis;
const requireValid = (condition, code = 'INVALID_PLANNING_DATA') => { if (!condition) throw new Error(code); };

function date(value) {
    requireValid(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
    return clock(value + 'T00:00:00Z');
}

export function mondayForDate(value) {
    const instant = date(value);
    const weekday = new Date(instant).getUTCDay();
    return new Date(instant - ((weekday + 6) % 7) * 86400000).toISOString().slice(0, 10);
}

export function planningCalendar(day, month = false) {
    date(day);
    const start = month ? day.slice(0, 7) + '-01' : mondayForDate(day);
    const boundary = new Date(date(start));
    if (month) boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    else boundary.setUTCDate(boundary.getUTCDate() + 7);
    const end = boundary.toISOString().slice(0, 10);
    const last = new Date(date(end) - 86400000).toISOString().slice(0, 10);
    const cells = [];
    for (let offset = date(mondayForDate(start)); offset < date(mondayForDate(last)) + 7 * 86400000; offset += 86400000) {
        const value = new Date(offset).toISOString().slice(0, 10);
        cells.push({ date: value, inRange: value >= start && value < end });
    }
    return { start, last, cells };
}

function row(raw, key) {
    requireValid(raw && typeof raw === 'object' && !Array.isArray(raw));
    const result = { ...structuredClone(collections[key]), ...structuredClone(raw) };
    requireValid(typeof result.id === 'string' && uuid.test(result.id));
    clock(result.created_at);
    clock(result.updated_at);
    if (key === 'daily_ratings') {
        date(result.date);
        requireValid(typeof result.deleted === 'boolean' &&
            (result.score === null || Number.isInteger(result.score) && result.score >= 1 && result.score <= 5));
    } else {
        requireValid(mondayForDate(result.week_start) === result.week_start);
        if (key === 'weekly_plan_versions') {
            requireValid((result.base_version_id === null || uuid.test(result.base_version_id)) &&
                Array.isArray(result.days) && result.days.length === 7 && result.days.every(day => typeof day === 'string') &&
                typeof result.change_reason === 'string' && typeof result.deleted === 'boolean');
            if (result.deleted_at !== null) clock(result.deleted_at);
            requireValid(result.deleted || result.deleted_at === null);
        } else {
            requireValid(uuid.test(result.version_id) && ['save', 'resolve'].includes(result.kind) &&
                Array.isArray(result.parent_selection_ids) && result.parent_selection_ids.every(id => uuid.test(id)) &&
                new Set(result.parent_selection_ids).size === result.parent_selection_ids.length &&
                clock(result.created_at) === clock(result.updated_at));
            result.parent_selection_ids.sort();
        }
    }
    canonicalJson(result);
    return result;
}

function latest(first, second, priority, timestamp = value => value.updated_at) {
    const order = clock(timestamp(first)) - clock(timestamp(second)) ||
        priority(first) - priority(second) || compare(canonicalJson(first), canonicalJson(second));
    return order >= 0 ? first : second;
}

function joinVersion(first, second) {
    const body = ({ deleted, deleted_at, updated_at, ...rest }) => rest;
    requireValid(same(body(first), body(second)), 'WEEKLY_PLAN_ID_CONFLICT');
    if (first.deleted !== second.deleted) return first.deleted ? first : second;
    return latest(first, second, () => 0, value => value.deleted_at ?? value.updated_at);
}

function graph(rows, edges) {
    const byId = new Map(rows.map(item => [item.id, item]));
    const pending = new Map(), successors = new Map();
    for (const item of rows) {
        const parents = edges(item);
        pending.set(item.id, parents.length);
        for (const id of parents) {
            requireValid(byId.get(id)?.week_start === item.week_start, 'INVALID_WEEKLY_PLAN_RELATION');
            if (!successors.has(id)) successors.set(id, []);
            successors.get(id).push(item.id);
        }
    }
    const ready = rows.filter(item => pending.get(item.id) === 0).map(item => item.id);
    for (let index = 0; index < ready.length; index++) {
        for (const id of successors.get(ready[index]) ?? []) {
            const remaining = pending.get(id) - 1;
            pending.set(id, remaining);
            if (remaining === 0) ready.push(id);
        }
    }
    requireValid(ready.length === rows.length, 'INVALID_WEEKLY_PLAN_RELATION');
    return rows.filter(item => !successors.has(item.id));
}

function validateRelations(data) {
    const versions = data.weekly_plan_versions, selections = data.weekly_plan_selections;
    const versionById = new Map(versions.map(item => [item.id, item]));
    const saved = new Set();
    graph(versions, item => item.base_version_id === null ? [] : [item.base_version_id]);
    const tips = graph(selections, item => item.parent_selection_ids);
    for (const selection of selections) {
        requireValid(versionById.get(selection.version_id)?.week_start === selection.week_start, 'INVALID_WEEKLY_PLAN_RELATION');
        if (selection.kind === 'save') saved.add(selection.version_id);
    }
    requireValid(versions.every(item => saved.has(item.id)), 'INVALID_WEEKLY_PLAN_RELATION');
    return tips;
}

export function mergePlanningData(...sources) {
    const data = {};
    for (const key of Object.keys(collections)) {
        const rows = new Map();
        for (const source of sources) {
            const entries = Object.hasOwn(source, key) ? source[key] : [];
            requireValid(Array.isArray(entries));
            for (const raw of entries) {
                const candidate = row(raw, key);
                const identity = key === 'daily_ratings' ? candidate.date : candidate.id;
                const previous = rows.get(identity);
                if (!previous) rows.set(identity, candidate);
                else if (key === 'weekly_plan_versions') rows.set(identity, joinVersion(previous, candidate));
                else if (key === 'daily_ratings') rows.set(identity, latest(previous, candidate, value => value.deleted ? 2 : value.score === null ? 1 : 0));
                else requireValid(same(previous, candidate), 'WEEKLY_PLAN_SELECTION_ID_CONFLICT');
            }
        }
        data[key] = [...rows.values()].sort((a, b) => key === 'daily_ratings' ? compare(a.date, b.date) :
            clock(a.created_at) - clock(b.created_at) || compare(a.id, b.id));
    }
    validateRelations(data);
    return data;
}

export function weeklyPlanState(data, week) {
    requireValid(mondayForDate(week) === week);
    const normalized = mergePlanningData(data);
    const versions = normalized.weekly_plan_versions.filter(item => item.week_start === week);
    const tips = validateRelations(normalized).filter(item => item.week_start === week);
    const candidates = versions.filter(item => tips.some(tip => tip.version_id === item.id));
    const state = !tips.length ? 'empty' : candidates.every(item => item.deleted) ? 'restart' :
        candidates.length === 1 ? 'current' : 'conflict';
    return { state, tips: tips.map(item => item.id).sort(), candidates, history: versions.filter(item => !item.deleted),
        current: state === 'current' ? candidates[0] : null };
}

export function ratingAverage(data, start, end) {
    return ratingSummary(data, start, end).average;
}

export function ratingSummary(data, start, end) {
    const scores = mergePlanningData(data).daily_ratings.filter(item =>
        !item.deleted && item.score !== null && item.date >= start && item.date <= end).map(item => item.score);
    const count = scores.length;
    const days = Math.round((date(end) - date(start)) / 86400000) + 1;
    if (!count) return { average: null, count, days };
    const sum = scores.reduce((total, score) => total + score, 0);
    const average = (Math.floor((20 * sum + count) / (2 * count)) / 10).toFixed(1);
    return { average, count, days };
}

export function comparePlanText(oldText, newText) {
    const old = [...oldText], next = [...newText];
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) prefix++;
    while (prefix + suffix < Math.min(old.length, next.length) &&
        old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    return { before: old.slice(0, prefix).join(''), removed: old.slice(prefix, old.length - suffix).join(''),
        added: next.slice(prefix, next.length - suffix).join(''), after: old.slice(old.length - suffix).join('') };
}

export function planningExport(data, start, end, { includePlans, includeRatings, includePlanHistory }) {
    const days = new Map(), history = [];
    const append = (day, lines) => days.set(day, [...(days.get(day) ?? []), ...lines]);
    const normalize = includePlans || includePlanHistory ? mergePlanningData(data) : mergePlanningData({
        daily_ratings: data.daily_ratings ?? []
    });
    const escape = value => value.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~\-]/g, '\\$&')
        .replace(/^([ \t]+)/gm, whitespace => whitespace.replace(/ /g, '&#32;').replace(/\t/g, '&#9;'));
    if (includeRatings) for (const rating of normalize.daily_ratings) {
        if (rating.date >= start && rating.date < end && !rating.deleted && rating.score !== null) {
            append(rating.date, ['### 整体满意度', '', `${rating.score} / 5`, '']);
        }
    }
    if (includePlans || includePlanHistory) {
        const weeks = [...new Set(normalize.weekly_plan_versions.map(version => version.week_start))].sort();
        for (const week of weeks) {
            const calendar = Array.from({ length: 7 }, (_, index) => new Date(date(week) + index * 86400000).toISOString().slice(0, 10));
            if (!calendar.some(day => day >= start && day < end)) continue;
            const plan = weeklyPlanState(normalize, week);
            if (includePlans) calendar.forEach((day, index) => {
                if (day < start || day >= end) return;
                const text = plan.state === 'conflict' ? '计划存在分歧，尚未选择当前版本' : plan.state === 'restart' ?
                    '当前候选计划均已删除，需重新制定' : escape(plan.current.days[index]) || '未安排';
                append(day, ['### 计划', '', text, '']);
            });
            if (includePlanHistory && plan.history.length) {
                history.push(`### ${week} 当周`, '');
                for (const version of plan.history) {
                    history.push(`#### ${version.created_at}`, '', `版本：${version.id}`, '',
                        `修订原因：${escape(version.change_reason) || '未填写'}`, '');
                    calendar.forEach((day, index) => history.push(`**${day}**`, '', escape(version.days[index]) || '未安排', ''));
                }
            }
        }
    }
    return { days, history };
}

export function planningChange(data, action, identity) {
    const { id, at } = identity;
    const stamps = { created_at: at, updated_at: at };
    if (action.kind === 'rate') {
        date(action.date);
        const existing = mergePlanningData(data).daily_ratings.find(item => item.date === action.date);
        if (!existing && action.score === null) return null;
        return { type: 'planning.rating.put', rating: row({ ...existing, id: existing?.id ?? id, date: action.date,
            created_at: existing?.created_at ?? at, updated_at: at, deleted: false, score: action.score }, 'daily_ratings') };
    }
    const week = action.week;
    const current = weeklyPlanState(data, week);
    if (action.kind === 'delete') {
        const target = current.history.find(item => item.id === action.versionId);
        if (!target) {
            requireValid(mergePlanningData(data).weekly_plan_versions.some(item => item.id === action.versionId &&
                item.week_start === week && item.deleted));
            return null;
        }
        requireValid(same(current.tips, action.tips) && !current.candidates.some(item => item.id === target.id), 'WEEKLY_PLAN_STALE');
        return { type: 'planning.version.delete', version: { ...target, deleted: true, updated_at: at, deleted_at: at } };
    }
    requireValid(same(current.tips, action.tips), 'WEEKLY_PLAN_STALE');
    const selection = { id, ...stamps, week_start: week, parent_selection_ids: current.tips };
    if (action.kind === 'resolve') {
        requireValid(current.state === 'conflict' && current.candidates.some(item => item.id === action.versionId && !item.deleted));
        return { type: 'planning.selection.resolve', selection: { ...selection, kind: 'resolve', version_id: action.versionId } };
    }
    requireValid(action.kind === 'save' && ['empty', 'current', 'restart'].includes(current.state) &&
        Array.isArray(action.days) && action.days.length === 7 && action.days.every(day => typeof day === 'string') &&
        (current.state === 'current' || action.days.some(day => day.trim())));
    requireValid(!mergePlanningData(data).weekly_plan_versions.some(item => item.id === action.versionId), 'WEEKLY_PLAN_ID_CONFLICT');
    return { type: 'planning.version.save', version: { id: action.versionId, ...stamps, week_start: week,
        base_version_id: current.current?.id ?? null, days: action.days, change_reason: action.reason, deleted: false, deleted_at: null },
    selection: { ...selection, kind: 'save', version_id: action.versionId } };
}

export function applyPlanningOperations(data, operations) {
    const additions = { weekly_plan_versions: [], weekly_plan_selections: [], daily_ratings: [] };
    for (const operation of operations) {
        switch (operation.type) {
            case 'planning.version.save': {
                const version = row(operation.version, 'weekly_plan_versions');
                const selection = row(operation.selection, 'weekly_plan_selections');
                requireValid(!version.deleted && selection.kind === 'save' && selection.version_id === version.id);
                additions.weekly_plan_versions.push(version);
                additions.weekly_plan_selections.push(selection);
                break;
            }
            case 'planning.version.delete':
                requireValid(operation.version?.deleted === true);
                additions.weekly_plan_versions.push(operation.version);
                break;
            case 'planning.selection.resolve':
                requireValid(operation.selection?.kind === 'resolve');
                additions.weekly_plan_selections.push(operation.selection);
                break;
            case 'planning.rating.put':
                additions.daily_ratings.push(operation.rating);
                break;
            default: throw new Error('UNSUPPORTED_RECORD_OPERATION');
        }
    }
    Object.assign(data, mergePlanningData(data, additions));
}

export function validatePlanningRecords(baseline, records) {
    const parents = new Map(), changes = new Map();
    for (const record of records) {
        const own = record.operations.filter(operation => typeof operation?.type === 'string' && operation.type.startsWith('planning.'));
        parents.set(record.id, record.parents);
        if (!own.length) continue;
        requireValid(record.operations.length === 1);
        const visited = new Set(), stack = record.parents.map(parent => parent.id);
        while (stack.length) {
            const id = stack.pop();
            if (visited.has(id)) continue;
            visited.add(id);
            for (const parent of parents.get(id) ?? []) stack.push(parent.id);
        }
        const view = structuredClone(baseline);
        applyPlanningOperations(view, [...visited].flatMap(id => changes.has(id) ? [changes.get(id)] : []));
        const operation = own[0], version = operation.version, selection = operation.selection;
        let action;
        switch (operation.type) {
            case 'planning.version.save':
                action = { kind: 'save', week: version.week_start, versionId: version.id,
                    days: version.days, reason: version.change_reason, tips: selection.parent_selection_ids };
                break;
            case 'planning.version.delete':
                action = { kind: 'delete', week: version.week_start, versionId: version.id,
                    tips: weeklyPlanState(view, version.week_start).tips };
                break;
            case 'planning.selection.resolve':
                action = { kind: 'resolve', week: selection.week_start, versionId: selection.version_id, tips: selection.parent_selection_ids };
                break;
            case 'planning.rating.put':
                action = { kind: 'rate', date: operation.rating.date, score: operation.rating.score };
                break;
            default: throw new Error('UNSUPPORTED_RECORD_OPERATION');
        }
        const expected = planningChange(view, action, { id: record.id, at: record.created_at });
        requireValid(expected !== null && same(operation, expected), 'INVALID_PLANNING_OPERATION');
        changes.set(record.id, operation);
    }
}
