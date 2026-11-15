import { readFileSync } from 'node:fs';
import { encode, decode } from './codec.mjs';
import { NORMAL_TODO_PROFILE } from './normal-record-profile.mjs';
import { normalizeReminderSettings, chooseReminderSettings } from '../../windows/src/reminderSettingsConflict.js';
import { todoTimestampMillis } from '../../windows/src/normalTodoConflict.js';

// 隔离实验能力集：不改变旧普通任务数据集的解释，不启用应用记录同步。
export const PERSONAL_CORE_OPERATION_SET = 'lab-personal-core/1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(code); };
const copy = value => decode(encode(value));
const ruleProperties = JSON.parse(readFileSync(new URL('../../todo_data.schema.json', import.meta.url), 'utf8'))
    .properties.reminder_settings.properties.global_rules.items.properties;

function settingsValue(raw) {
    return copy(normalizeReminderSettings(raw));
}

/** 动作时间由调用方预先固定；省略时钟不代表一次新的设置修改。 */
export function reminderSettingsOperation(raw) {
    const operation = { type: 'reminder.settings.put', settings: settingsValue(raw) };
    validateOperation(operation);
    return operation;
}

function validateOperation(operation) {
    if (operation?.type !== 'reminder.settings.put') {
        NORMAL_TODO_PROFILE.validateOperation(operation);
        return;
    }
    if (!object(operation) || Object.keys(operation).length !== 2 ||
        !Object.hasOwn(operation, 'type') || !Object.hasOwn(operation, 'settings')) fail('UNSUPPORTED_OPERATION');
    const normalized = settingsValue(operation.settings);
    if (!encode(normalized).equals(encode(operation.settings))) fail('NON_NORMALIZED_REMINDER_OPERATION');
    todoTimestampMillis(normalized.updated_at);
    for (const rule of normalized.global_rules) {
        for (const field of ['condition', 'task_scope']) {
            if (!ruleProperties[field].enum.includes(rule[field])) fail('UNSUPPORTED_REMINDER_RULE_ENUM');
        }
    }
}

function prepareBaseline(data) {
    NORMAL_TODO_PROFILE.validateBaseline(data);
    return settingsValue(data.reminder_settings);
}

function project(baseline, orderedRecords) {
    let settings = prepareBaseline(baseline);
    // 旧身份只来自提醒自己的基线/历史，不能借用任务或子任务的旧字符串身份。
    const knownRuleIds = new Set(settings.global_rules.map(rule => rule.id));
    for (const record of orderedRecords) record.operations.forEach(validateOperation);
    const normalRecords = orderedRecords.map(record => ({ ...record,
        operations: record.operations.filter(operation => operation.type !== 'reminder.settings.put') }));
    const data = NORMAL_TODO_PROFILE.project(baseline, normalRecords);
    for (const record of orderedRecords) for (const operation of record.operations) {
        if (operation.type !== 'reminder.settings.put') continue;
        for (const rule of operation.settings.global_rules) {
            if (!knownRuleIds.has(rule.id) && !uuid.test(rule.id)) fail('INVALID_NEW_REMINDER_RULE_ID');
            knownRuleIds.add(rule.id);
        }
        // 文件时钟只用固定基线，不将任务/记录派生last_updated伪装成提醒编辑。
        settings = chooseReminderSettings(
            { reminder_settings: settings, last_updated: baseline.last_updated },
            { reminder_settings: operation.settings, last_updated: baseline.last_updated }
        );
    }
    data.reminder_settings = settingsValue(settings);
    return data;
}

export const PERSONAL_CORE_PROFILE = Object.freeze({
    id: PERSONAL_CORE_OPERATION_SET,
    validateBaseline: data => { prepareBaseline(data); },
    validateOperation,
    project
});
