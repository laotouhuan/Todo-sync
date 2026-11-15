import { canonicalLearning } from './timeTracking.js';
import { todoTimestampMillis } from './normalTodoConflict.js';
import { canonicalJson, canonicalJsonDigest } from './stableJsonDigest.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new Error('INVALID_REMINDER_SETTINGS'); };

// 补齐已有契约默认值，保留数组顺序、原时钟及规则内外的未知扩展。
export function normalizeReminderSettings(raw = {}) {
    const settings = structuredClone(raw);
    if (!object(settings)) invalid();
    const defaults = { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
    for (const [key, value] of Object.entries(defaults)) if (settings[key] === undefined) settings[key] = structuredClone(value);
    if (settings.updated_at !== null && typeof settings.updated_at !== 'string' ||
        typeof settings.enabled !== 'boolean' || typeof settings.privacy_mode !== 'boolean' || !Array.isArray(settings.global_rules)) invalid();
    for (const rule of settings.global_rules) {
        if (!object(rule) || typeof rule.id !== 'string' || typeof rule.time !== 'string') invalid();
        for (const [key, value] of Object.entries({ enabled: true, condition: 'unconditional', task_scope: 'all', title: '', body: '' })) {
            if (rule[key] === undefined) rule[key] = value;
        }
        if (typeof rule.enabled !== 'boolean' || !['condition', 'task_scope', 'title', 'body'].every(key => typeof rule[key] === 'string')) invalid();
    }
    canonicalJson(settings);
    return settings;
}

// 设置表单只提交已知字段；按规则身份保留当前清单中的扩展，不把删除的规则补回来。
export function applyReminderSettingsEdit(previous, edited) {
    if (!object(edited)) invalid();
    const current = normalizeReminderSettings(previous);
    const next = { ...current, ...edited };
    if (Object.hasOwn(edited, 'global_rules')) {
        if (!Array.isArray(edited.global_rules)) invalid();
        const byId = new Map(current.global_rules.map(rule => [rule.id, rule]));
        next.global_rules = edited.global_rules.map(rule => {
            if (!object(rule)) invalid();
            return { ...byId.get(rule.id), ...rule };
        });
    }
    return normalizeReminderSettings(next);
}

function timestamp(value) {
    try { return todoTimestampMillis(value); }
    catch { return null; }
}

function compareTime(first, second) {
    if (first === null) return second === null ? 0 : -1;
    return second === null ? 1 : first - second;
}

function fixedChoice(first, second) {
    const key = settings => {
        const business = { ...settings };
        delete business.updated_at;
        return canonicalLearning(business);
    };
    const left = key(first), right = key(second);
    if (left !== right) return left > right ? first : second;
    return canonicalJsonDigest(first) >= canonicalJsonDigest(second) ? first : second;
}

/** 整份选择：独立时钟优先，旧非空规则优先，再回退文件时间，最后固定内容平局。 */
export function chooseReminderSettings(localData, cloudData) {
    if (!localData) return normalizeReminderSettings(cloudData?.reminder_settings);
    if (!cloudData) return normalizeReminderSettings(localData.reminder_settings);
    const local = normalizeReminderSettings(localData.reminder_settings);
    const cloud = normalizeReminderSettings(cloudData.reminder_settings);
    const lTime = timestamp(local.updated_at), cTime = timestamp(cloud.updated_at);
    if (lTime !== null || cTime !== null) {
        const difference = compareTime(lTime, cTime);
        if (difference !== 0) return difference > 0 ? local : cloud;
        return fixedChoice(local, cloud);
    }
    if (local.global_rules.length > 0 && cloud.global_rules.length === 0) return local;
    if (cloud.global_rules.length > 0 && local.global_rules.length === 0) return cloud;
    const difference = compareTime(timestamp(localData.last_updated), timestamp(cloudData.last_updated));
    if (difference !== 0) return difference > 0 ? local : cloud;
    return fixedChoice(local, cloud);
}
