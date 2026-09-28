import { getISOWeekString, isMonthDate, isWeekDate } from './dateUtils.js';
import { mergeLearningRecords, normalizeLabel, normalizeLearningData } from './timeTracking.js';

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
        const parts = dStr.split('-');
        if (parts.length !== 3) return false;
        const date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return getISOWeekString(date) === todo.date;
    }).length;
}

export function getMonthlyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => dStr.startsWith(todo.date)).length;
}

export function resolveCheckinConflict(checkinL, checkinC, lTime, cTime) {
    if (checkinL && checkinC) {
        return checkinL.length >= checkinC.length ? checkinL : checkinC;
    }
    if (checkinL) {
        if (checkinL.length <= 10) return checkinL;
        return new Date(checkinL).getTime() > cTime ? checkinL : null;
    }
    if (checkinC) {
        if (checkinC.length <= 10) return checkinC;
        return new Date(checkinC).getTime() > lTime ? checkinC : null;
    }
    return null;
}

export function mergeReminderSettings(localData, cloudData) {
    const ls = localData?.reminder_settings;
    const cs = cloudData?.reminder_settings;
    if (!ls && !cs) return { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
    if (!ls) return deepClone(cs);
    if (!cs) return deepClone(ls);

    const lSettingsTime = Date.parse(ls.updated_at || '');
    const cSettingsTime = Date.parse(cs.updated_at || '');
    const hasLocalSettingsTime = Number.isFinite(lSettingsTime);
    const hasCloudSettingsTime = Number.isFinite(cSettingsTime);

    // 新格式仅比较提醒设置自己的时间戳，普通待办的 last_updated 不参与判断。
    if (hasLocalSettingsTime || hasCloudSettingsTime) {
        if (!hasLocalSettingsTime) return deepClone(cs);
        if (!hasCloudSettingsTime) return deepClone(ls);
        return deepClone(cSettingsTime > lSettingsTime ? cs : ls);
    }

    // 兼容旧数据：空规则与非空规则冲突时优先保住非空规则。
    if (stableSerialize(ls) === stableSerialize(cs)) return deepClone(ls);
    const localRules = Array.isArray(ls.global_rules) ? ls.global_rules : [];
    const cloudRules = Array.isArray(cs.global_rules) ? cs.global_rules : [];
    if (localRules.length > 0 && cloudRules.length === 0) return deepClone(ls);
    if (cloudRules.length > 0 && localRules.length === 0) return deepClone(cs);

    // 两端旧配置均非空且不同，只能回退旧版文件时间。
    const lDataTime = Date.parse(localData?.last_updated || '');
    const cDataTime = Date.parse(cloudData?.last_updated || '');
    return deepClone(
        Number.isFinite(cDataTime) && (!Number.isFinite(lDataTime) || cDataTime > lDataTime) ? cs : ls
    );
}

function todoDataContentSnapshot(data) {
    return {
        version: data?.version ?? 1,
        todos: data?.todos || [],
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
        const result = {};
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

export function mergeTodoData(localData, cloudData) {
    if (localData) normalizeLearningData(localData);
    if (cloudData) normalizeLearningData(cloudData);
    if (!localData || !localData.todos) {
        if (cloudData && cloudData.todos) {
            cloudData.todos.forEach(migrateAndNormalize);
        }
        const data = cloudData || { version: 1, last_updated: new Date().toISOString(), todos: [] };
        if (!data.reminder_settings) {
            data.reminder_settings = { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
        }
        return { data, changed: true };
    }
    if (!cloudData || !cloudData.todos) {
        localData.todos.forEach(migrateAndNormalize);
        if (!localData.reminder_settings) {
            localData.reminder_settings = { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
        }
        return { data: localData, changed: false };
    }

    localData.todos.forEach(migrateAndNormalize);
    cloudData.todos.forEach(migrateAndNormalize);

    const localMap = new Map(localData.todos.map(t => [t.id, t]));
    const cloudMap = new Map(cloudData.todos.map(t => [t.id, t]));
    const mergedTodos = [];
    let changed = false;

    for (const [id, lTodo] of localMap) {
        const cTodo = cloudMap.get(id);
        if (cTodo) {
            const lTime = new Date(lTodo.updated_at || lTodo.created_at || 0).getTime();
            const cTime = new Date(cTodo.updated_at || cTodo.created_at || 0).getTime();
            let merged;
            if (cTime > lTime) {
                merged = deepClone(cTodo);
                changed = true;
            } else {
                merged = deepClone(lTodo);
            }
            // completed_dates 智能合并：支持销卡（删除打卡）同步与离线补卡合并
            const lDates = lTodo.completed_dates || [];
            const cDates = cTodo.completed_dates || [];
            const allDateParts = [...new Set([
                ...lDates.map(d => d.split('T')[0]),
                ...cDates.map(d => d.split('T')[0])
            ])];

            const mergedDates = [];
            allDateParts.forEach(datePart => {
                const checkinL = lDates.find(d => d.startsWith(datePart));
                const checkinC = cDates.find(d => d.startsWith(datePart));
                const resolved = resolveCheckinConflict(checkinL, checkinC, lTime, cTime);
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
