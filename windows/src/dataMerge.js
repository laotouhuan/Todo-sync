import { mergeSeriesData } from './taskSeries.js';
import { getISOWeekString, isMonthDate, isWeekDate } from './dateUtils.js';
import { mergeLearningRecords, normalizeLabel, normalizeLearningData } from './timeTracking.js';
import { chooseNormalTodo, choosePeriodTodoBase, normalizeNormalTodo, normalizePeriodTodo, todoTimestampMillis } from './normalTodoConflict.js';
import { chooseReminderSettings, normalizeReminderSettings } from './reminderSettingsConflict.js';

const deepClone = value => structuredClone(value);

export function migrateAndNormalize(todo) {
    if (!todo) return todo;
    todo.label = normalizeLabel(todo.label);
    // 1. 旧版 recurring 迁移
    if (todo.recurring === 'daily') {
        todo.recurring = 'daily_repeat';
        todo.task_type = todo.task_type || 'normal';
    } else if (todo.recurring === 'weekly') {
        todo.recurring = 'none';
        todo.task_type = 'weekly_checkin';
    } else if (todo.recurring === 'monthly') {
        todo.recurring = 'none';
        todo.task_type = 'monthly_checkin';
    }
    // 3. 强制类型与日期的同步
    if (todo.date && isWeekDate(todo.date)) {
        todo.task_type = 'weekly_checkin';
    } else if (todo.date && isMonthDate(todo.date)) {
        todo.task_type = 'monthly_checkin';
    }
    // 2. 补全新字段默认值
    todo.task_type = todo.task_type || 'normal';
    todo.completed_dates = todo.completed_dates || [];
    todo.target_count = Number.isSafeInteger(todo.target_count) && todo.target_count > 0
        ? todo.target_count
        : null;
    todo.deleted = todo.deleted ?? false;
    if (todo.reminder === undefined) todo.reminder = null;
    if (todo.completed === null) todo.completed = false;
    if (todo.subtasks) {
        todo.subtasks.forEach(s => {
            s.completed_at = s.completed_at || null;
        });
    } else {
        todo.subtasks = [];
    }
    return todo;
}

export function getWeeklyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => {
        // 与打卡按日期前缀归组一致，兼容 Z、正负偏移及旧纯日期。
        const day = dStr.split('T')[0];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
        const parsed = new Date(day + 'T00:00:00Z');
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return false;
        const date = new Date(0);
        date.setFullYear(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
        date.setHours(12, 0, 0, 0);
        return getISOWeekString(date) === todo.date;
    }).length;
}

export function getMonthlyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => dStr.startsWith(todo.date)).length;
}

export function resolveCheckinConflict(checkinL, checkinC, lTime, cTime) {
    if (checkinL && checkinC) {
        if (checkinL.length !== checkinC.length) return checkinL.length > checkinC.length ? checkinL : checkinC;
        const rank = value => { const time = checkinMillis(value); return Number.isFinite(time) ? time : -Infinity; };
        const left = rank(checkinL), right = rank(checkinC);
        if (left !== right) return left > right ? checkinL : checkinC;
        // 同毫秒或双方无法解释的旧表示使用 UTF-16 固定序，不依赖本机角色。
        return checkinL >= checkinC ? checkinL : checkinC;
    }
    if (checkinL) {
        if (checkinL.length <= 10) return checkinL;
        return checkinMillis(checkinL) > cTime ? checkinL : null;
    }
    if (checkinC) {
        if (checkinC.length <= 10) return checkinC;
        return checkinMillis(checkinC) > lTime ? checkinC : null;
    }
    return null;
}

function checkinMillis(value) {
    try { return todoTimestampMillis(value); }
    catch { return NaN; }
}

function normalizeCheckinDates(dates) {
    const days = new Map();
    for (const date of dates) {
        const day = date.split('T')[0];
        days.set(day, days.has(day) ? resolveCheckinConflict(days.get(day), date, 0, 0) : date);
    }
    return [...days.values()].sort();
}

export function mergeReminderSettings(localData, cloudData) {
    return chooseReminderSettings(localData, cloudData);
}

function todoDataContentSnapshot(data) {
    return {
        version: data?.version ?? 1,
        todos: data?.todos || [],
        task_series: data?.task_series || [],
        task_series_links: data?.task_series_links || [],
        time_entries: data?.time_entries || [],
        daily_reviews: data?.daily_reviews || [],
        reminder_settings: data?.reminder_settings || {
            updated_at: null,
            enabled: true,
            privacy_mode: false,
            global_rules: []
        }
    };
}

function canonicalizeForComparison(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalizeForComparison);
    }
    if (value && typeof value === 'object') {
        const result = Object.create(null);
        Object.keys(value).sort().forEach(key => {
            result[key] = canonicalizeForComparison(value[key]);
        });
        return result;
    }
    return value;
}

function stableSerialize(value) {
    return JSON.stringify(canonicalizeForComparison(value));
}

export function hasTodoDataContentChanges(first, second) {
    return stableSerialize(todoDataContentSnapshot(first)) !== stableSerialize(todoDataContentSnapshot(second));
}

function normalizeTodoList(todos) {
    const byId = new Map();
    for (const raw of todos) {
        const migrated = migrateAndNormalize(raw);
        let todo = migrated;
        if (migrated.task_type === 'normal') todo = normalizeNormalTodo(migrated);
        else if (isPeriodTodo(migrated)) todo = normalizePeriodTodo(migrated);
        if (isPeriodTodo(todo)) {
            todo.completed_dates = normalizeCheckinDates(todo.completed_dates || []);
        }
        const previous = byId.get(todo.id);
        // 同类重复 ID 使用与跨端一致的基础版本选择，混合类型保持旧行为。
        if (previous?.task_type === 'normal' && todo.task_type === 'normal') byId.set(todo.id, chooseNormalTodo(previous, todo));
        else if (previous && isPeriodTodo(previous) && isPeriodTodo(todo)) byId.set(todo.id, choosePeriodTodoBase(previous, todo));
        else byId.set(todo.id, todo);
    }
    return [...byId.values()];
}

function isPeriodTodo(todo) {
    return todo.task_type === 'weekly_checkin' || todo.task_type === 'monthly_checkin';
}

export function mergeTodoData(localData, cloudData) {
    if (localData) {
        normalizeLearningData(localData);
        localData.reminder_settings = normalizeReminderSettings(localData.reminder_settings);
    }
    if (cloudData) {
        normalizeLearningData(cloudData);
        cloudData.reminder_settings = normalizeReminderSettings(cloudData.reminder_settings);
    }
    if (!localData || !localData.todos) {
        if (cloudData && cloudData.todos) {
            cloudData.todos = normalizeTodoList(cloudData.todos);
        }
        const data = cloudData || { version: 1, last_updated: new Date().toISOString(), todos: [] };
        if (!data.reminder_settings) {
            data.reminder_settings = { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
        }
        return { data, changed: true };
    }
    if (!cloudData || !cloudData.todos) {
        localData.todos = normalizeTodoList(localData.todos);
        if (!localData.reminder_settings) {
            localData.reminder_settings = { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
        }
        return { data: localData, changed: false };
    }

    localData.todos = normalizeTodoList(localData.todos);
    cloudData.todos = normalizeTodoList(cloudData.todos);

    const localMap = new Map(localData.todos.map(t => [t.id, t]));
    const cloudMap = new Map(cloudData.todos.map(t => [t.id, t]));
    const mergedTodos = [];
    let changed = false;

    for (const [id, lTodo] of localMap) {
        const cTodo = cloudMap.get(id);
        if (cTodo) {
            if (lTodo.task_type === 'normal' && cTodo.task_type === 'normal') {
                // 普通任务选整条，不再拼接日期或生成新的任务更新时间。
                mergedTodos.push(deepClone(chooseNormalTodo(lTodo, cTodo)));
                continue;
            }
            let merged;
            if (isPeriodTodo(lTodo) && isPeriodTodo(cTodo)) {
                merged = deepClone(choosePeriodTodoBase(lTodo, cTodo));
            } else {
                const lTime = new Date(lTodo.updated_at || lTodo.created_at || 0).getTime();
                const cTime = new Date(cTodo.updated_at || cTodo.created_at || 0).getTime();
                merged = deepClone(cTime > lTime ? cTodo : lTodo);
                if (cTime > lTime) changed = true;
            }
            // completed_dates 智能合并：支持销卡（删除打卡）同步与离线补卡合并
            const lDates = normalizeCheckinDates(lTodo.completed_dates || []);
            const cDates = normalizeCheckinDates(cTodo.completed_dates || []);
            const allDateParts = [...new Set([
                ...lDates.map(d => d.split('T')[0]),
                ...cDates.map(d => d.split('T')[0])
            ])];

            const mergedDates = [];
            allDateParts.forEach(datePart => {
                const checkinL = lDates.find(d => d.split('T')[0] === datePart);
                const checkinC = cDates.find(d => d.split('T')[0] === datePart);
                const resolved = resolveCheckinConflict(checkinL, checkinC,
                    checkinMillis(lTodo.updated_at ?? lTodo.created_at ?? ''),
                    checkinMillis(cTodo.updated_at ?? cTodo.created_at ?? ''));
                if (resolved) {
                    mergedDates.push(resolved);
                }
            });
            mergedDates.sort();

            if (JSON.stringify(merged.completed_dates) !== JSON.stringify(mergedDates)) {
                merged.completed_dates = mergedDates;
                merged.updated_at = new Date().toISOString();
                changed = true;
            }

            // 重新计算周/月打卡任务完成状态
            if (merged.task_type === 'weekly_checkin' || merged.task_type === 'monthly_checkin') {
                const currentPeriodCount = merged.task_type === 'weekly_checkin'
                    ? getWeeklyCompletedCount(merged)
                    : getMonthlyCompletedCount(merged);
                const shouldBeCompleted = Boolean(merged.target_count && currentPeriodCount >= merged.target_count);
                if (merged.completed !== shouldBeCompleted) {
                    merged.completed = shouldBeCompleted;
                    merged.completed_at = shouldBeCompleted ? (merged.completed_at || new Date().toISOString()) : null;
                    merged.updated_at = new Date().toISOString();
                    changed = true;
                }
            }
            mergedTodos.push(merged);
        } else {
            mergedTodos.push(lTodo);
        }
    }
    for (const [id, cTodo] of cloudMap) {
        if (!localMap.has(id)) {
            mergedTodos.push(cTodo);
            changed = true;
        }
    }
    mergedTodos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const mergedReminderSettings = mergeReminderSettings(localData, cloudData);

    const mergedData = {
        version: localData.version || 1,
        last_updated: new Date().toISOString(),
        todos: mergedTodos,
        ...mergeSeriesData(localData, cloudData),
        reminder_settings: mergedReminderSettings,
        time_entries: mergeLearningRecords(localData.time_entries, cloudData.time_entries),
        daily_reviews: mergeLearningRecords(localData.daily_reviews, cloudData.daily_reviews, 'date')
    };
    return {
        data: mergedData,
        changed: changed || hasTodoDataContentChanges(mergedData, localData),
        cloudChanged: hasTodoDataContentChanges(mergedData, cloudData)
    };
}

export function mergeCollaborations(local, cloud) {
    let localData = local || { version: 1, last_updated: "", collaborations: [] };
    let cloudData = cloud || { version: 1, last_updated: "", collaborations: [] };

    let mergedList = [];
    let localMap = new Map((localData.collaborations || []).map(c => [c.id, c]));
    let cloudMap = new Map((cloudData.collaborations || []).map(c => [c.id, c]));

    let allIds = new Set([...localMap.keys(), ...cloudMap.keys()]);

    let changed = false;

    for (let id of allIds) {
        let localItem = localMap.get(id);
        let cloudItem = cloudMap.get(id);

        if (localItem && cloudItem) {
            let localTime = new Date(localItem.updated_at || 0).getTime();
            let cloudTime = new Date(cloudItem.updated_at || 0).getTime();

            if (cloudTime > localTime) {
                const sameTarget = ['webdav_url', 'webdav_username', 'webdav_filepath']
                    .every(field => localItem[field] === cloudItem[field]);
                mergedList.push({ ...cloudItem, webdav_password: sameTarget ? (localItem.webdav_password || '') : '' });
                changed = true;
            } else {
                mergedList.push(localItem);
                if (localTime > cloudTime) {
                    changed = true;
                }
            }
        } else {
            mergedList.push(localItem || { ...cloudItem, webdav_password: '' });
            changed = true;
        }
    }

    let mergedData = {
        version: 1,
        last_updated: changed ? new Date().toISOString() : (localData.last_updated || cloudData.last_updated || new Date().toISOString()),
        collaborations: mergedList
    };

    return { data: mergedData, changed: changed };
}
