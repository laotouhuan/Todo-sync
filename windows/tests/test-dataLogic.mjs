import { parse as parseSource } from 'acorn';
import { runInNewContext } from 'node:vm';
import * as learningHelpers from '../src/timeTracking.js';
import * as dateHelpers from '../src/dateUtils.js';
/**
 * 数据逻辑测试（合并、迁移、Schema 校验）
 * 测试 mergeTodoData 和 migrateAndNormalize 的核心逻辑
 *
 * 由于这两个函数定义在 main.js 中且依赖 Tauri 运行时，
 * 我们在此文件中复制它们的纯逻辑版本进行独立测试。
 *
 * 用法: node --test tests/test-dataLogic.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isWeekDate, isMonthDate, getISOWeekString } from '../src/dateUtils.js';

// ====== 从 main.js 提取的纯逻辑函数（无 DOM/Tauri 依赖） ======

function getWeeklyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => {
        const parts = dStr.split('-');
        if (parts.length !== 3) return false;
        const date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return getISOWeekString(date) === todo.date;
    }).length;
}

function getMonthlyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => dStr.startsWith(todo.date)).length;
}

function migrateAndNormalize(todo) {
    if (!todo) return todo;
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
    todo.target_count = todo.target_count ?? null;
    if (todo.reminder === undefined) todo.reminder = null;
    if (todo.subtasks) {
        todo.subtasks.forEach(s => {
            s.completed_at = s.completed_at || null;
        });
    } else {
        todo.subtasks = [];
    }
    return todo;
}

function mergeReminderSettings(localData, cloudData) {
    const ls = localData?.reminder_settings;
    const cs = cloudData?.reminder_settings;
    if (!ls && !cs) return { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] };
    if (!ls) return structuredClone(cs);
    if (!cs) return structuredClone(ls);

    const lSettingsTime = Date.parse(ls.updated_at || '');
    const cSettingsTime = Date.parse(cs.updated_at || '');
    const hasLocalSettingsTime = Number.isFinite(lSettingsTime);
    const hasCloudSettingsTime = Number.isFinite(cSettingsTime);
    if (hasLocalSettingsTime || hasCloudSettingsTime) {
        if (!hasLocalSettingsTime) return structuredClone(cs);
        if (!hasCloudSettingsTime) return structuredClone(ls);
        return structuredClone(cSettingsTime > lSettingsTime ? cs : ls);
    }

    if (stableSerialize(ls) === stableSerialize(cs)) return structuredClone(ls);
    const localRules = Array.isArray(ls.global_rules) ? ls.global_rules : [];
    const cloudRules = Array.isArray(cs.global_rules) ? cs.global_rules : [];
    if (localRules.length > 0 && cloudRules.length === 0) return structuredClone(ls);
    if (cloudRules.length > 0 && localRules.length === 0) return structuredClone(cs);

    const lDataTime = Date.parse(localData?.last_updated || '');
    const cDataTime = Date.parse(cloudData?.last_updated || '');
    return structuredClone(
        Number.isFinite(cDataTime) && (!Number.isFinite(lDataTime) || cDataTime > lDataTime) ? cs : ls
    );
}

function todoDataContentSnapshot(data) {
    return {
        version: data?.version ?? 1,
        todos: data?.todos || [],
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

function hasTodoDataContentChanges(first, second) {
    return stableSerialize(todoDataContentSnapshot(first)) !== stableSerialize(todoDataContentSnapshot(second));
}

function mergeTodoData(localData, cloudData) {
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
                merged = JSON.parse(JSON.stringify(cTodo));
                changed = true;
            } else {
                merged = JSON.parse(JSON.stringify(lTodo));
            }
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

                if (checkinL && checkinC) {
                    if (checkinL.length >= checkinC.length) {
                        mergedDates.push(checkinL);
                    } else {
                        mergedDates.push(checkinC);
                    }
                } else if (checkinL) {
                    if (checkinL.length > 10) {
                        const tCheck = new Date(checkinL).getTime();
                        if (tCheck > cTime) {
                            mergedDates.push(checkinL);
                        }
                    } else {
                        mergedDates.push(checkinL);
                    }
                } else if (checkinC) {
                    if (checkinC.length > 10) {
                        const tCheck = new Date(checkinC).getTime();
                        if (tCheck > lTime) {
                            mergedDates.push(checkinC);
                        }
                    } else {
                        mergedDates.push(checkinC);
                    }
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
                const shouldBeCompleted = merged.target_count && currentPeriodCount >= merged.target_count;
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
        reminder_settings: mergedReminderSettings
    };
    return {
        data: mergedData,
        changed: changed || hasTodoDataContentChanges(mergedData, localData),
        cloudChanged: hasTodoDataContentChanges(mergedData, cloudData)
    };
}

import { generateUUID } from '../src/dateUtils.js';

function makeTodo(overrides = {}) {
    return {
        id: overrides.id || generateUUID(),
        content: overrides.content || '测试任务',
        date: overrides.date || null,
        time: null,
        completed: overrides.completed || false,
        created_at: overrides.created_at || '2026-06-01T00:00:00Z',
        completed_at: overrides.completed_at || null,
        order: overrides.order || 0,
        updated_at: overrides.updated_at || '2026-06-01T00:00:00Z',
        deleted: overrides.deleted || false,
        recurring: overrides.recurring || 'none',
        task_type: overrides.task_type || 'normal',
        completed_dates: overrides.completed_dates || [],
        target_count: overrides.target_count ?? null,
        subtasks: overrides.subtasks || []
    };
}

function makeData(todos = [], overrides = {}) {
    const data = {
        version: 1,
        last_updated: overrides.last_updated || new Date().toISOString(),
        todos: todos
    };
    if (Object.hasOwn(overrides, 'reminder_settings')) {
        data.reminder_settings = overrides.reminder_settings;
    }
    return data;
}

// ====== migrateAndNormalize 测试 ======
describe('migrateAndNormalize', () => {
    it('daily → daily_repeat 迁移', () => {
        const todo = { recurring: 'daily', content: 'test', id: '1', completed: false, created_at: '' };
        migrateAndNormalize(todo);
        assert.equal(todo.recurring, 'daily_repeat');
        assert.equal(todo.task_type, 'normal');
    });

    it('weekly → weekly_checkin 迁移', () => {
        const todo = { recurring: 'weekly', content: 'test', id: '1', completed: false, created_at: '' };
        migrateAndNormalize(todo);
        assert.equal(todo.recurring, 'none');
        assert.equal(todo.task_type, 'weekly_checkin');
    });

    it('monthly → monthly_checkin 迁移', () => {
        const todo = { recurring: 'monthly', content: 'test', id: '1', completed: false, created_at: '' };
        migrateAndNormalize(todo);
        assert.equal(todo.recurring, 'none');
        assert.equal(todo.task_type, 'monthly_checkin');
    });

    it('补全新字段默认值', () => {
        const todo = { recurring: 'none', content: 'test', id: '1', completed: false, created_at: '' };
        migrateAndNormalize(todo);
        assert.equal(todo.task_type, 'normal');
        assert.deepEqual(todo.completed_dates, []);
        assert.equal(todo.target_count, null);
        assert.deepEqual(todo.subtasks, []);
    });

    it('处理 null 输入不崩溃', () => {
        assert.equal(migrateAndNormalize(null), null);
    });

    it('子任务补全 completed_at', () => {
        const todo = {
            recurring: 'none', content: 'test', id: '1', completed: false, created_at: '',
            subtasks: [{ id: 's1', content: 'sub', completed: true }]
        };
        migrateAndNormalize(todo);
        assert.equal(todo.subtasks[0].completed_at, null);
    });

    it('周/月日期强制迁移为对应的周/月打卡类型', () => {
        const todoWeek = { date: '2026-W26', content: 'test', id: '1', completed: false, created_at: '' };
        migrateAndNormalize(todoWeek);
        assert.equal(todoWeek.task_type, 'weekly_checkin');

        const todoMonth = { date: '2026-06', content: 'test', id: '2', completed: false, created_at: '' };
        migrateAndNormalize(todoMonth);
        assert.equal(todoMonth.task_type, 'monthly_checkin');
    });
});

// ====== mergeTodoData 测试 ======
describe('mergeTodoData', () => {
    it('本地为空时采用云端数据', () => {
        const cloud = makeData([makeTodo({ content: '云端任务' })]);
        const result = mergeTodoData(null, cloud);
        assert.equal(result.changed, true);
        assert.equal(result.data.todos.length, 1);
        assert.equal(result.data.todos[0].content, '云端任务');
    });

    it('云端为空时保留本地数据', () => {
        const local = makeData([makeTodo({ content: '本地任务' })]);
        const result = mergeTodoData(local, null);
        assert.equal(result.changed, false);
        assert.equal(result.data.todos.length, 1);
    });

    it('相同 ID 的任务取 updated_at 更新的版本', () => {
        const id = 'shared-id-1';
        const local = makeData([makeTodo({ id, content: '旧版本', updated_at: '2026-06-01T00:00:00Z' })]);
        const cloud = makeData([makeTodo({ id, content: '新版本', updated_at: '2026-06-28T00:00:00Z' })]);

        const result = mergeTodoData(local, cloud);
        assert.equal(result.data.todos.length, 1);
        assert.equal(result.data.todos[0].content, '新版本');
        assert.equal(result.changed, true);
    });

    it('不同 ID 的任务全部合并', () => {
        const local = makeData([makeTodo({ id: 'local-1', content: '本地独有' })]);
        const cloud = makeData([makeTodo({ id: 'cloud-1', content: '云端独有' })]);

        const result = mergeTodoData(local, cloud);
        assert.equal(result.data.todos.length, 2);
        assert.equal(result.changed, true);
    });

    it('completed_dates 销卡同步 (即一方删除了打卡，且该方 updatedAt 较新时，合并后应删除该打卡)', () => {
        const id = 'checkin-delete-sync';
        const local = makeData([makeTodo({
            id, completed_dates: ['2026-06-02T10:00:00.000Z'],
            updated_at: '2026-06-02T10:00:00.000Z'
        })]);
        const cloud = makeData([makeTodo({
            id, completed_dates: [],
            updated_at: '2026-06-02T12:00:00.000Z' // Cloud deleted it later
        })]);

        const result = mergeTodoData(local, cloud);
        const merged = result.data.todos[0];
        assert.deepEqual(merged.completed_dates, []);
    });

    it('completed_dates 取并集', () => {
        const id = 'checkin-1';
        const local = makeData([makeTodo({
            id, completed_dates: ['2026-06-01', '2026-06-02'],
            updated_at: '2026-06-28T00:00:00Z'
        })]);
        const cloud = makeData([makeTodo({
            id, completed_dates: ['2026-06-02', '2026-06-03'],
            updated_at: '2026-06-28T00:00:00Z'
        })]);

        const result = mergeTodoData(local, cloud);
        const merged = result.data.todos[0];
        assert.deepEqual(merged.completed_dates, ['2026-06-01', '2026-06-02', '2026-06-03']);
    });

    it('completed_dates 合并去重并优先保留时间戳', () => {
        const id = 'checkin-dedup';
        const local = makeData([makeTodo({
            id, completed_dates: ['2026-06-02', '2026-06-03T10:00:00.000Z'],
            updated_at: '2026-06-28T00:00:00Z'
        })]);
        const cloud = makeData([makeTodo({
            id, completed_dates: ['2026-06-02T12:00:00.000Z', '2026-06-03'],
            updated_at: '2026-06-28T00:00:00Z'
        })]);

        const result = mergeTodoData(local, cloud);
        const merged = result.data.todos[0];
        assert.deepEqual(merged.completed_dates, ['2026-06-02T12:00:00.000Z', '2026-06-03T10:00:00.000Z']);
    });

    it('合并结果按 created_at 降序排列', () => {
        const local = makeData([
            makeTodo({ id: 'old', content: '旧任务', created_at: '2026-01-01T00:00:00Z' }),
            makeTodo({ id: 'new', content: '新任务', created_at: '2026-06-28T00:00:00Z' })
        ]);
        const result = mergeTodoData(local, makeData([]));
        assert.equal(result.data.todos[0].content, '新任务');
        assert.equal(result.data.todos[1].content, '旧任务');
    });

    it('合并周/月打卡任务时重新计算完成状态（达到目标）', () => {
        const localTodo = makeTodo({
            id: 'checkin-1',
            task_type: 'weekly_checkin',
            date: '2026-W27', // Target week
            target_count: 3,
            completed: false,
            completed_dates: ['2026-07-01', '2026-07-02'],
            updated_at: '2026-07-04T12:00:00Z'
        });
        const cloudTodo = makeTodo({
            id: 'checkin-1',
            task_type: 'weekly_checkin',
            date: '2026-W27',
            target_count: 3,
            completed: false,
            completed_dates: ['2026-07-02', '2026-07-03'],
            updated_at: '2026-07-04T12:01:00Z'
        });

        const result = mergeTodoData(makeData([localTodo]), makeData([cloudTodo]));
        const merged = result.data.todos[0];
        // completed_dates 并集应为 ['2026-07-01', '2026-07-02', '2026-07-03'] (3次)，达到目标
        assert.deepEqual(merged.completed_dates, ['2026-07-01', '2026-07-02', '2026-07-03']);
        assert.equal(merged.completed, true);
        assert.ok(merged.completed_at);
        assert.ok(result.changed);
    });

    it('合并周/月打卡任务时重新联算状态（未达到目标）', () => {
        const localTodo = makeTodo({
            id: 'checkin-2',
            task_type: 'weekly_checkin',
            date: '2026-W27',
            target_count: 3,
            completed: false,
            completed_dates: ['2026-07-01'],
            updated_at: '2026-07-04T12:00:00Z'
        });
        const cloudTodo = makeTodo({
            id: 'checkin-2',
            task_type: 'weekly_checkin',
            date: '2026-W27',
            target_count: 3,
            completed: false,
            completed_dates: ['2026-07-02'],
            updated_at: '2026-07-04T12:01:00Z'
        });

        const result = mergeTodoData(makeData([localTodo]), makeData([cloudTodo]));
        const merged = result.data.todos[0];
        // completed_dates 并集为 ['2026-07-01', '2026-07-02'] (2次)，未达到目标
        assert.deepEqual(merged.completed_dates, ['2026-07-01', '2026-07-02']);
        assert.equal(merged.completed, false);
        assert.equal(merged.completed_at, null);
    });

    it('两端都为空不崩溃', () => {
        const result = mergeTodoData(null, null);
        assert.equal(result.changed, true);
    });

    it('普通待办导致根时间较新时不会覆盖更新的提醒设置', () => {
        const localRule = { id: 'rule-1', time: '09:00', condition: 'unconditional', task_scope: 'all', body: '提醒' };
        const local = makeData([], {
            last_updated: '2026-09-07T08:00:00Z',
            reminder_settings: {
                updated_at: '2026-09-07T07:00:00Z', enabled: true, privacy_mode: false, global_rules: [localRule]
            }
        });
        const cloud = makeData([], {
            last_updated: '2026-09-07T12:00:00Z',
            reminder_settings: {
                updated_at: '2026-09-07T06:00:00Z', enabled: true, privacy_mode: false, global_rules: []
            }
        });

        const result = mergeTodoData(local, cloud);
        assert.deepEqual(result.data.reminder_settings.global_rules, [localRule]);
        assert.equal(result.changed, false);
        assert.equal(result.cloudChanged, true);
    });

    it('新时间戳的空规则整包可以同步用户主动删除', () => {
        const local = makeData([], {
            reminder_settings: {
                updated_at: '2026-09-07T07:00:00Z', enabled: true, privacy_mode: false,
                global_rules: [{ id: 'rule-1', time: '09:00' }]
            }
        });
        const cloud = makeData([], {
            reminder_settings: {
                updated_at: '2026-09-07T08:00:00Z', enabled: true, privacy_mode: false, global_rules: []
            }
        });

        const result = mergeTodoData(local, cloud);
        assert.deepEqual(result.data.reminder_settings.global_rules, []);
        assert.equal(result.changed, true);
    });

    it('旧数据都没有提醒时间戳时优先保留非空规则', () => {
        const legacyRule = { id: 'legacy-rule', time: '18:00' };
        const local = makeData([], {
            last_updated: '2026-09-07T07:00:00Z',
            reminder_settings: { enabled: true, privacy_mode: false, global_rules: [legacyRule] }
        });
        const cloud = makeData([], {
            last_updated: '2026-09-07T12:00:00Z',
            reminder_settings: { enabled: true, privacy_mode: false, global_rules: [] }
        });

        const result = mergeTodoData(local, cloud);
        assert.deepEqual(result.data.reminder_settings.global_rules, [legacyRule]);
    });

    it('业务内容比较忽略根级 last_updated，但能识别提醒设置变化', () => {
        const base = makeData([], {
            last_updated: '2026-09-07T07:00:00Z',
            reminder_settings: { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] }
        });
        const onlyRootChanged = { ...base, last_updated: '2026-09-07T08:00:00Z' };
        const reminderChanged = {
            ...onlyRootChanged,
            reminder_settings: { ...base.reminder_settings, privacy_mode: true }
        };

        assert.equal(hasTodoDataContentChanges(base, onlyRootChanged), false);
        assert.equal(hasTodoDataContentChanges(base, reminderChanged), true);
    });

    it('业务内容比较忽略跨端 JSON 对象字段顺序差异', () => {
        const first = makeData([], {
            reminder_settings: { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] }
        });
        const second = {
            todos: [],
            reminder_settings: { global_rules: [], privacy_mode: false, enabled: true, updated_at: null },
            version: 1,
            last_updated: first.last_updated
        };

        assert.equal(hasTodoDataContentChanges(first, second), false);
    });
});

// ====== Schema 一致性测试 ======
describe('数据契约 Schema 校验', () => {
    const schemaPath = resolve(import.meta.dirname, '..', '..', 'todo_data.schema.json');
    let schema;

    it('Schema 文件可以解析为合法 JSON', () => {
        const raw = readFileSync(schemaPath, 'utf-8');
        schema = JSON.parse(raw);
        assert.ok(schema);
    });

    it('Schema 定义了 version, last_updated, todos 三个必填字段', () => {
        assert.deepEqual(schema.required.sort(), ['last_updated', 'todos', 'version']);
    });

    it('Todo 项定义了 id, content, completed, created_at 四个必填字段', () => {
        const todoRequired = schema.properties.todos.items.required;
        assert.ok(todoRequired.includes('id'));
        assert.ok(todoRequired.includes('content'));
        assert.ok(todoRequired.includes('completed'));
        assert.ok(todoRequired.includes('created_at'));
    });

    it('Schema 包含 task_type 枚举定义', () => {
        const taskTypeProp = schema.properties.todos.items.properties.task_type;
        assert.ok(taskTypeProp);
        assert.deepEqual(taskTypeProp.enum.sort(), ['monthly_checkin', 'normal', 'weekly_checkin']);
    });

    it('Schema 包含 completed_dates 数组定义', () => {
        const prop = schema.properties.todos.items.properties.completed_dates;
        assert.ok(prop);
        assert.equal(prop.type, 'array');
    });

    it('Schema 包含 target_count 定义', () => {
        const prop = schema.properties.todos.items.properties.target_count;
        assert.ok(prop);
    });

    it('Schema 为提醒设置定义了可空的独立更新时间', () => {
        const prop = schema.properties.reminder_settings.properties.updated_at;
        assert.deepEqual(prop.type, ['string', 'null']);
        assert.equal(prop.format, 'date-time');
        assert.equal(prop.default, null);
    });

    it('createTodo() 输出符合 Schema 必填字段要求', async () => {
        // 动态 import dateUtils
        const { createTodo } = await import('../src/dateUtils.js');
        const todo = createTodo('Schema 校验测试', '2026-06-28');

        // 检查 Schema 中 todo required 的所有字段都存在
        const todoRequired = schema.properties.todos.items.required;
        for (const field of todoRequired) {
            assert.ok(field in todo, `createTodo() 缺少 Schema 必填字段: ${field}`);
        }

        // 检查所有 Schema 定义的属性都存在
        const schemaProps = Object.keys(schema.properties.todos.items.properties);
        for (const prop of schemaProps) {
            assert.ok(prop in todo, `createTodo() 缺少 Schema 属性: ${prop}`);
        }
    });
});

// 直接执行实际源文件中的合并函数，避免只验证测试内的旧副本。
describe('学习数据实际合并入口', () => {
    const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const names = ['mergeTodoData', 'migrateAndNormalize', 'mergeReminderSettings', 'resolveCheckinConflict', 'todoDataContentSnapshot', 'canonicalizeForComparison', 'stableSerialize', 'hasTodoDataContentChanges', 'deepClone'];
    const declarations = parseSource(source, {ecmaVersion:'latest', sourceType:'module'}).body.filter(n => n.type === 'FunctionDeclaration' && names.includes(n.id.name)).map(n => source.slice(n.start,n.end)).join('\n');
    const api = runInNewContext(declarations + ';({mergeTodoData,migrateAndNormalize,hasTodoDataContentChanges})', {...dateHelpers,...learningHelpers,structuredClone,Date});
    it('旧数据默认值及任务标签迁移', () => {
        assert.equal(api.migrateAndNormalize({content:'任务',label:' 数学 '}).label,'数学');
        const out=api.mergeTodoData({version:1,todos:[]},null).data;
        assert.equal(out.time_entries.length,0); assert.equal(out.daily_reviews.length,0);
    });
    it('任务标签冲突沿用实际合并结果，候选不收集被覆盖的版本', () => {
        const old = { id:'task', content:'任务', created_at:'2026-09-10T00:00:00Z', updated_at:'2026-09-10T01:00:00Z', label:'数学习' };
        const newer = { ...old, updated_at:'2026-09-10T02:00:00Z', label:'数学' };
        const local = {version:1,todos:[old]}, remote = {version:1,todos:[newer,{...old,id:'other',label:'阅读'}]};
        const result = api.mergeTodoData(local,remote).data;
        assert.deepEqual(learningHelpers.availableLabels(result.todos),['数学','阅读']);
        assert.equal(api.hasTodoDataContentChanges(local,result),true);
        assert.deepEqual(learningHelpers.availableLabels(api.mergeTodoData(remote,local).data.todos),['数学','阅读']);
    });
    it('异 ID 同日复盘归一，新增计时触发双向同步', () => {
        const a={version:1,todos:[],daily_reviews:[{id:'a',date:'2026-09-10',fact:'旧',updated_at:'2026-09-10T00:00:00Z'}]};
        const b={version:1,todos:[],daily_reviews:[{id:'b',date:'2026-09-10',fact:'新',updated_at:'2026-09-10T01:00:00Z'}],time_entries:[{id:'t',task_ref:{todo_id:'x'},started_at:'2026-09-10T00:00:00Z',updated_at:'2026-09-10T00:00:00Z'}]};
        const out=api.mergeTodoData(a,b);
        assert.equal(out.data.daily_reviews.length,1);assert.equal(out.data.daily_reviews[0].fact,'新');
        assert.equal(out.data.time_entries.length,1);assert.equal(out.changed,true);
        assert.equal(api.hasTodoDataContentChanges(out.data,a),true);
    });
});

describe('学习保存失败与串行队列', () => {
    const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const tree = parseSource(source, {ecmaVersion:'latest',sourceType:'module'});
    const declaration = name => { const n = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name); return source.slice(n.start,n.end); };
    it('实际编辑保存失败保留草稿及原标签，重试成功才关闭；协作写入保持来源隔离', async () => {
        let success = false, closed = 0; const notices = [];
        const original = {id:'task',content:'旧内容',label:'旧标签',subtasks:[],updated_at:'2026-09-10T00:00:00Z'};
        const state = {todoData:{todos:[original]},activeSource:{type:'personal'},currentEditingTodo:structuredClone(original),currentEditingSubtasks:[]};
        const fields = {'edit-content':{value:'新内容'},'edit-learning-label':{value:'数学'}};
        const calls = [];
        const save = runInNewContext('let _saveQueue=Promise.resolve(); let _lastRenderedHash="";'+declaration('saveEditModal')+';saveEditModal', {
            ...learningHelpers,...dateHelpers,structuredClone,appState:state,document:{getElementById:id=>fields[id]},
            extractCollaborator:()=>({nickname:null}),deepClone:structuredClone,closeEditModal:()=>closed++,render:()=>{},
            showToast:m=>notices.push(m),console:{error:()=>{}},_doSaveData:async()=>success,invoke:async(cmd,args)=>calls.push([cmd,args])
        });
        await save(); assert.equal(closed,0); assert.equal(state.todoData.todos[0].label,'旧标签');
        assert.equal(fields['edit-learning-label'].value,'数学'); assert.ok(notices.length);
        success=true; await save(); assert.equal(closed,1); assert.equal(state.todoData.todos[0].label,'数学');
        state.activeSource={type:'collaboration',id:'source'}; state.collabData={todos:[structuredClone(original)]};
        fields['edit-learning-label'].value='协作'; await save();
        assert.equal(calls[0][0],'write_collaboration_todo'); assert.equal(calls[0][1].collabId,'source');
        assert.equal(JSON.parse(calls[0][1].todoJson).label,'协作'); assert.equal(state.todoData.todos[0].label,'数学');
    });
    it('落盘失败回滚新集合并保留旧数据，下一次保存仍可成功', async () => {
        let success = false;
        const state = {todoData:{todos:[{id:'existing',content:'原有任务'}],time_entries:[],daily_reviews:[]}};
        const commit = runInNewContext('let _saveQueue=Promise.resolve(); let _lastRenderedHash="";' + declaration('commitLearning') + ';commitLearning', {
            ...learningHelpers, appState:state, structuredClone, render:()=>{}, learningUI:{refresh:()=>{}}, _doSaveData:async()=>success
        });
        await assert.rejects(commit(d=>d.daily_reviews.push({id:'r',date:'2026-09-10',fact:'不能丢失的草稿'})),/保存失败/);
        assert.equal(state.todoData.daily_reviews.length,0);
        assert.equal(state.todoData.todos[0].content,'原有任务');
        success=true;
        await commit(d=>d.daily_reviews.push({id:'r',date:'2026-09-10',fact:'重试保存'}));
        assert.equal(state.todoData.daily_reviews[0].fact,'重试保存');
    });
    it('实际写入命令失败会返回失败，而非误报成功', async () => {
        const save = runInNewContext(declaration('_doSaveData') + ';_doSaveData', {
            ...learningHelpers, appState:{todoData:{todos:[]},appConfig:{sync_mode:'local'},saveVersion:0},
            setSyncStatus:()=>{}, SyncState:{SYNCING:1,ERROR:2}, purgeOldDeletedTodos:()=>{},
            invoke:async()=>{throw new Error('磁盘写入失败');}, console:{error:()=>{}}, Date
        });
        assert.equal(await save(),false);
    });
    it('实际写入成功后保留计时记录，云端失败不回滚已经落盘的记录', async () => {
        for (const mode of ['local', 'webdav']) {
            let persisted;
            const state = {todoData:{todos:[],time_entries:[],daily_reviews:[]},appConfig:{sync_mode:mode},saveVersion:0};
            const commit = runInNewContext('let _saveQueue=Promise.resolve(); let _lastRenderedHash="";' + declaration('_doSaveData') + declaration('commitLearning') + ';commitLearning', {
                ...learningHelpers, appState:state, structuredClone, Date, setTimeout:()=>{},
                setSyncStatus:()=>{}, SyncState:{SYNCING:1,ERROR:2,IDLE:0}, purgeOldDeletedTodos:()=>{},
                render:()=>{}, learningUI:{refresh:()=>{}}, showToast:()=>{}, console:{error:()=>{}},
                invoke:async(cmd,args)=>{if(cmd==='write_todo_data') persisted=JSON.parse(args.data);else throw new Error('云端离线');}
            });
            await commit(d=>d.time_entries.push({id:'t',task_ref:{todo_id:'task',source_type:'personal'},started_at:'2026-09-10T01:00:00Z',ended_at:null,updated_at:'2026-09-10T01:00:00Z'}));
            assert.equal(state.todoData.time_entries.length,1);
            assert.equal(persisted.time_entries[0].id,'t');
        }
    });
    it('创建任务包含 Schema 的所有属性及标签默认值', () => {
        const schema=JSON.parse(readFileSync(new URL('../../todo_data.schema.json',import.meta.url),'utf8'));
        const todo=dateHelpers.createTodo('学习');
        for (const key of Object.keys(schema.properties.todos.items.properties)) assert.ok(key in todo,`缺少 ${key}`);
        assert.equal(todo.label,null);
    });
});
