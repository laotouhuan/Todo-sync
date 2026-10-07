import { requirePersonalTarget } from '../src/collaborationView.js';
import { parse as parseSource } from 'acorn';
import { runInNewContext } from 'node:vm';
import * as learningHelpers from '../src/timeTracking.js';
import * as dateHelpers from '../src/dateUtils.js';
import { applyLabelChange, planLabelChange } from '../src/labelUtils.js';
import { generateUUID } from '../src/dateUtils.js';
import {
    getMonthlyCompletedCount,
    getWeeklyCompletedCount,
    hasTodoDataContentChanges,
    mergeCollaborations,
    mergeReminderSettings,
    mergeTodoData,
    migrateAndNormalize,
    resolveCheckinConflict
} from '../src/dataMerge.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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

function readContractFixture(name) {
    const fixturePath = resolve(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'contract', name);
    return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

describe('共享数据契约样例', () => {
    it('旧版个人数据经生产迁移后补齐默认值', () => {
        const legacy = readContractFixture('legacy-personal.json');
        const result = mergeTodoData(null, legacy).data;
        const todo = result.todos[0];

        assert.equal(todo.recurring, 'daily_repeat');
        assert.equal(todo.task_type, 'normal');
        assert.equal(todo.completed, false);
        assert.equal(todo.deleted, false);
        assert.equal(todo.reminder, null);
        assert.equal(todo.subtasks[0].completed_at, null);
        assert.deepEqual(result.reminder_settings, {
            updated_at: null, enabled: true, privacy_mode: false, global_rules: []
        });
        assert.deepEqual(result.time_entries, []);
        assert.deepEqual(result.daily_reviews, []);
    });

    it('当前个人数据合并后保留提醒、计时、复盘及两种打卡日期格式', () => {
        const current = readContractFixture('current-personal.json');
        const result = mergeTodoData(current, makeData([])).data;
        const task = result.todos.find(item => item.id === '1b2c3d4e-5f60-4a71-8b92-000000000011');
        const checkin = result.todos.find(item => item.id === '1b2c3d4e-5f60-4a71-8b92-000000000013');

        assert.equal(result.todos.length, 2);
        assert.deepEqual(checkin.completed_dates, ['2026-09-09', '2026-09-10T11:30:00Z']);
        assert.equal(task.reminder.reminder_time, '18:00');
        assert.equal(result.reminder_settings.global_rules.length, 1);
        assert.equal(result.time_entries.length, 1);
        assert.equal(result.time_entries[0].label_snapshot, '学习');
        assert.equal(result.daily_reviews.length, 1);
        assert.equal(result.daily_reviews[0].fact, '完成了样例任务');
    });

    it('当前协作配置合并后保留软删除标记', () => {
        const current = readContractFixture('current-collaboration.json');
        const result = mergeCollaborations(current, { version: 1, last_updated: '', collaborations: [] });

        assert.equal(result.data.collaborations.length, 2);
        assert.equal(result.data.collaborations.find(item => item.deleted).id,
            '1b2c3d4e-5f60-4a71-8b92-000000000052');
    });

    it('当前样例的必填字段、日期和本地时刻符合两份 Schema 结构', () => {
        const todoSchema = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'todo_data.schema.json'), 'utf8'));
        const collabSchema = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'collaborations.schema.json'), 'utf8'));
        const personal = readContractFixture('current-personal.json');
        const collaborations = readContractFixture('current-collaboration.json');
        const requireFields = (value, fields, label) => {
            assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} 必须是对象`);
            for (const field of fields) assert.ok(field in value, `${label} 缺少必填字段 ${field}`);
        };
        const isTimestamp = value => typeof value === 'string' &&
            Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
        const validTaskDate = value => value === null ||
            /^(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-\d{2})$/.test(value);

        requireFields(personal, todoSchema.required, '个人数据');
        assert.equal(typeof personal.version, 'number');
        assert.ok(isTimestamp(personal.last_updated));
        for (const [index, todo] of personal.todos.entries()) {
            requireFields(todo, todoSchema.properties.todos.items.required, `任务 ${index}`);
            assert.ok(validTaskDate(todo.date), `任务 ${index} 的日期格式无效`);
            assert.ok(todo.time === null || /^\d{2}:\d{2}$/.test(todo.time), `任务 ${index} 的时刻格式无效`);
            assert.ok(todo.completed_dates.every(value =>
                /^\d{4}-\d{2}-\d{2}$/.test(value) || isTimestamp(value)), `任务 ${index} 的打卡日期格式无效`);
            assert.ok(isTimestamp(todo.created_at));
            assert.ok(isTimestamp(todo.updated_at));
            for (const subtask of todo.subtasks) {
                requireFields(subtask, todoSchema.properties.todos.items.properties.subtasks.items.required, '子任务');
                assert.ok(subtask.completed_at === null || isTimestamp(subtask.completed_at));
            }
        }
        for (const entry of personal.time_entries) {
            requireFields(entry, todoSchema.properties.time_entries.items.required, '计时记录');
            requireFields(entry.task_ref, todoSchema.properties.time_entries.items.properties.task_ref.required, '计时任务引用');
            assert.ok(isTimestamp(entry.started_at) && isTimestamp(entry.created_at) && isTimestamp(entry.updated_at));
        }
        for (const review of personal.daily_reviews) {
            requireFields(review, todoSchema.properties.daily_reviews.items.required, '每日复盘');
            assert.match(review.date, /^\d{4}-\d{2}-\d{2}$/);
            assert.ok(isTimestamp(review.created_at) && isTimestamp(review.updated_at));
        }

        requireFields(collaborations, collabSchema.required, '协作配置');
        for (const item of collaborations.collaborations) {
            requireFields(item, collabSchema.properties.collaborations.items.required, '协作来源');
            assert.ok(item.expire_at === null || Number.isInteger(item.expire_at));
            assert.ok(isTimestamp(item.updated_at));
        }
    });
});

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

    it('清除不合法的打卡目标并保留正整数', () => {
        for (const targetCount of ['<b>注入</b>', 1.5, 0, -1, Infinity]) {
            const todo = { target_count: targetCount, content: '测试' };
            migrateAndNormalize(todo);
            assert.equal(todo.target_count, null);
        }
        const validTodo = { target_count: 4, content: '测试' };
        migrateAndNormalize(validTodo);
        assert.equal(validTodo.target_count, 4);
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

describe('实际页面的同步 ID 注入回归', () => {
    const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const names = ['escapeHtml', 'renderHealth', 'renderCollabListInSettings'];
    const declarations = parseSource(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .filter(n => n.type === 'FunctionDeclaration' && names.includes(n.id.name))
        .map(n => source.slice(n.start, n.end)).join('\n');
    const ids = ['normal-id', '\"><img data-injected="yes" src="x">', "'&<>\""];

    function harness() {
        const htmlWrites = [];
        const element = () => ({
            dataset: {}, style: {}, children: [], buttons: [], listeners: {},
            classList: { add() {} },
            set innerHTML(value) {
                htmlWrites.push(value);
                // 记录 HTML 写入边界；按钮仅作为 dataset 和事件的测试替身。
                this.buttons = [...value.matchAll(/<button class="([^"]+)"/g)].map(match => {
                    const button = element(); button.className = match[1]; return button;
                });
            },
            querySelector(selector) { return this.querySelectorAll(selector)[0]; },
            querySelectorAll(selector) { return this.buttons.filter(b => b.className.split(' ').includes(selector.slice(1))); },
            appendChild(child) { this.children.push(child); },
            addEventListener(type, action) { this.listeners[type] = action; }
        });
        const nodes = new Map();
        const document = { createElement: element, getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, element());
            return nodes.get(id);
        } };
        const state = { healthThroughputDays: 7, collaborations: [] };
        const todos = [];
        const api = runInNewContext(declarations + ';({migrateAndNormalize,renderHealth,renderCollabListInSettings})', {
            ...dateHelpers, requirePersonalTarget, ...learningHelpers, migrateAndNormalize, document, appState: state, getActiveTodos: () => todos, Date
        });
        return { api, state, todos, document, htmlWrites };
    }

    it('任务 ID 经实际归一化和健康页渲染后只进入按钮属性，不进入 HTML 模板', () => {
        const h = harness();
        h.todos.push(...ids.map(id => h.api.migrateAndNormalize({
            id, content: '任务', completed: false, created_at: '2020-01-01T00:00:00Z'
        })));
        h.api.renderHealth('2026-09-24', '2026-09-25');
        const items = h.document.getElementById('sleeping-list').children;
        assert.equal(items.length, ids.length);
        items.forEach((item, i) => {
            assert.equal(item.buttons.length, 2);
            item.buttons.forEach(button => assert.equal(button.dataset.id, ids[i]));
        });
        assert.ok(h.htmlWrites.every(html => !html.includes('data-injected')));
    });

    it('协作来源 ID 不进入 HTML 模板，解绑按钮保留原 ID 和点击事件', () => {
        const h = harness();
        h.state.collaborations = ids.map(id => ({ id, name: '朋友' }));
        h.api.renderCollabListInSettings();
        const items = h.document.getElementById('collab-list').children;
        assert.equal(items.length, ids.length);
        items.forEach((item, i) => {
            assert.equal(item.buttons.length, 1);
            assert.equal(item.buttons[0].dataset.id, ids[i]);
            assert.equal(typeof item.buttons[0].listeners.click, 'function');
        });
        assert.ok(h.htmlWrites.every(html => !html.includes('data-injected')));
    });
});

describe('生产数据合并模块', () => {
    it('任务标签冲突后只保留获胜版本的候选标签，交换合并方向结果一致', () => {
        const old = { ...makeTodo({ id: 'task' }), label: '数学习' };
        const newer = { ...old, updated_at: '2026-06-02T00:00:00Z', label: '数学' };
        const local = makeData([old]);
        const cloud = makeData([newer, { ...old, id: 'other', label: '阅读' }]);

        for (const [first, second] of [[local, cloud], [cloud, local]]) {
            const result = mergeTodoData(structuredClone(first), structuredClone(second));
            assert.equal(result.data.todos.find(todo => todo.id === 'task').label, '数学');
            assert.deepEqual(learningHelpers.availableLabels(result.data.todos), ['数学', '阅读']);
        }
        const result = mergeTodoData(structuredClone(local), structuredClone(cloud));
        assert.equal(result.changed, true);
        assert.equal(hasTodoDataContentChanges(result.data, local), true);
    });

    it('异 ID 同日复盘经生产入口归一，新增计时会触发同步', () => {
        const oldReview = {
            id: 'review-local', date: '2026-09-10', fact: '旧记录',
            created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z'
        };
        const newReview = { ...oldReview, id: 'review-cloud', fact: '新记录', updated_at: '2026-09-10T01:00:00Z' };
        const entry = {
            id: 'entry', task_ref: { todo_id: 'task' }, started_at: '2026-09-10T00:00:00Z',
            ended_at: '2026-09-10T00:30:00Z', created_at: '2026-09-10T00:00:00Z',
            updated_at: '2026-09-10T00:30:00Z'
        };
        const local = { ...makeData(), daily_reviews: [oldReview], time_entries: [] };
        const cloud = { ...makeData(), daily_reviews: [newReview], time_entries: [entry] };

        for (const [first, second] of [[local, cloud], [cloud, local]]) {
            const result = mergeTodoData(structuredClone(first), structuredClone(second));
            assert.equal(result.data.daily_reviews.length, 1);
            assert.equal(result.data.daily_reviews[0].id, newReview.id);
            assert.equal(result.data.daily_reviews[0].fact, newReview.fact);
            assert.equal(result.data.time_entries.length, 1);
            assert.equal(result.data.time_entries[0].id, entry.id);
        }
        const result = mergeTodoData(structuredClone(local), structuredClone(cloud));
        assert.equal(result.changed, true);
        assert.equal(hasTodoDataContentChanges(result.data, local), true);

        // 让复盘在两端相同，单独确认新增计时能让合并入口要求本地保存。
        const withSameReview = { ...local, daily_reviews: [newReview] };
        const timingOnly = mergeTodoData(structuredClone(withSameReview), structuredClone(cloud));
        assert.equal(timingOnly.changed, true);
        assert.equal(timingOnly.data.time_entries[0].id, entry.id);
    });

    it('归一化生产迁移函数修剪标签并把空完成状态归一为 false', () => {
        const todo = migrateAndNormalize({ content: '任务', label: ' 数学 ', completed: null });
        assert.equal(todo.label, '数学');
        assert.equal(todo.completed, false);
        assert.equal(todo.reminder, null);
        assert.deepEqual(todo.subtasks, []);
    });

    it('没有目标次数时仍把打卡任务完成状态归一为布尔值', () => {
        const local = makeData([makeTodo({
            id: 'checkin-without-target', task_type: 'weekly_checkin', date: '2026-W37',
            target_count: null, completed: true, completed_dates: []
        })]);
        const cloud = makeData([makeTodo({
            id: 'checkin-without-target', task_type: 'weekly_checkin', date: '2026-W37',
            target_count: null, completed: true, completed_dates: []
        })]);
        const result = mergeTodoData(local, cloud);
        assert.equal(result.data.todos[0].completed, false);
        assert.equal(typeof result.data.todos[0].completed, 'boolean');
    });

    it('纯计时或复盘变化会被内容比较识别', () => {
        const empty = makeData([]);
        const withEntry = { ...empty, time_entries: [{ id: 'entry', task_ref: { todo_id: 'task' } }] };
        const withReview = { ...empty, daily_reviews: [{ id: 'review', date: '2026-09-10', fact: '记录' }] };
        assert.equal(hasTodoDataContentChanges(empty, withEntry), true);
        assert.equal(hasTodoDataContentChanges(empty, withReview), true);
    });

    it('协作合并保留较新的软删除记录', () => {
        const active = { id: 'source', name: '清单', updated_at: '2026-09-10T01:00:00Z', deleted: false };
        const tombstone = { ...active, updated_at: '2026-09-10T02:00:00Z', deleted: true };
        const result = mergeCollaborations(
            { version: 1, last_updated: '', collaborations: [active] },
            { version: 1, last_updated: '', collaborations: [tombstone] }
        );
        assert.equal(result.data.collaborations.length, 1);
        assert.equal(result.data.collaborations[0].deleted, true);
    });

    it('独立提醒设置合并沿用新的有效时间戳', () => {
        const local = { reminder_settings: { updated_at: '2026-09-10T01:00:00Z', global_rules: [] } };
        const cloud = { reminder_settings: { updated_at: '2026-09-10T02:00:00Z', global_rules: [{ id: 'rule' }] } };
        assert.deepEqual(mergeReminderSettings(local, cloud), cloud.reminder_settings);
    });

    it('纯日期销卡记录在单端缺席时仍按任务更新时间裁决', () => {
        assert.equal(resolveCheckinConflict('2026-09-10', null, 0, 0), '2026-09-10');
        assert.equal(resolveCheckinConflict(null, '2026-09-10', 0, 0), '2026-09-10');
    });
});
describe('学习保存失败与串行队列', () => {
    const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const tree = parseSource(source, {ecmaVersion:'latest',sourceType:'module'});
    const declaration = name => { const n = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name); return source.slice(n.start,n.end); };
    it('实际标签保存固定个人来源，失败可重试且完整保留计时和复盘', async () => {
        const task = { id: 'same', content: '个人任务', label: '学习', updated_at: '2026-09-01T00:00:00Z' };
        const entry = { id: 'e', task_ref: { todo_id: 'deleted', source_type: 'personal' }, started_at: '2026-09-01T00:00:00Z', ended_at: null };
        const original = { todos: [task, { id: 'deleted', deleted: true }], time_entries: [entry], daily_reviews: [{ id: 'r', fact: '保留复盘' }], reminder_settings: { enabled: false } };
        const state = { todoData: original, collabData: { todos: [{ ...task, content: '协作任务' }] }, activeSource: { type: 'collaboration' }, appConfig: { sync_mode: 'webdav' }, saveVersion: 0 };
        let fail = true, writes = 0, saved;
        const commit = runInNewContext('let _saveQueue=Promise.resolve();let _lastRenderedHash="";' + declaration('_doSaveData') + declaration('commitPersonalLabels') + ';commitPersonalLabels', {
            requirePersonalTarget, ...learningHelpers, applyLabelChange, appState: state, structuredClone, Date, setTimeout: () => {},
            render: () => {}, learningUI: { refresh: () => {} }, setSyncStatus: () => {}, SyncState: { SYNCING: 1, ERROR: 2, IDLE: 0 },
            purgeOldDeletedTodos: () => { throw new Error('标签保存不能清理记录'); }, showToast: () => {}, console: { error: () => {} },
            invoke: async (cmd, args) => {
                if (cmd === 'write_todo_data') { writes++; if (fail) throw new Error('磁盘失败'); saved = JSON.parse(args.data); }
                else if (cmd === 'sync_to_cloud') throw new Error('云端离线');
                else throw new Error('不应写协作数据');
            }
        });
        const plan = planLabelChange(original.todos, '学习');
        await assert.rejects(commit(plan, '英语'), /保存失败/);
        assert.equal(state.todoData, original);
        fail = false;
        assert.equal(await commit(plan, '英语'), 1);
        assert.equal(writes, 2); assert.equal(saved.todos[0].label, '英语');
        assert.deepEqual(saved.time_entries, original.time_entries);
        assert.deepEqual(saved.daily_reviews, original.daily_reviews);
        assert.deepEqual(saved.reminder_settings, original.reminder_settings);
        assert.equal(saved.todos.length, 2); assert.equal(state.collabData.todos[0].label, '学习');
    });
    it('实际编辑保存失败保留草稿及原标签，重试成功才关闭；协作编辑拒绝写入并保持来源隔离', async () => {
        let success = false, closed = 0; const notices = [];
        const original = {id:'task',content:'旧内容',label:'旧标签',subtasks:[],updated_at:'2026-09-10T00:00:00Z'};
        const state = {appConfig:{},todoData:{todos:[original]},activeSource:{type:'personal'},currentEditingTodo:structuredClone(original),currentEditingSubtasks:[]};
        const fields = {'edit-content':{value:'新内容'},'edit-learning-label':{value:'数学'}};
        const calls = [];
        const save = runInNewContext('let _saveQueue=Promise.resolve(); let _lastRenderedHash="";'+declaration('saveEditModal')+';saveEditModal', {
            requirePersonalTarget, ...learningHelpers,...dateHelpers,structuredClone,appState:state,document:{getElementById:id=>fields[id]},
            extractCollaborator:()=>({nickname:null}),deepClone:structuredClone,closeEditModal:()=>closed++,render:()=>{},
            showToast:m=>notices.push(m),console:{error:()=>{}},_doSaveData:async()=>success,invoke:async(cmd,args)=>calls.push([cmd,args])
        });
        await save(); assert.equal(closed,0); assert.equal(state.todoData.todos[0].label,'旧标签');
        assert.equal(fields['edit-learning-label'].value,'数学'); assert.ok(notices.length);
        success=true; await save(); assert.equal(closed,1); assert.equal(state.todoData.todos[0].label,'数学');
        state.activeSource={type:'collaboration',id:'source'}; state.collabData={todos:[structuredClone(original)]};
        fields['edit-learning-label'].value='协作'; await save();
        assert.equal(calls.length,0); assert.equal(state.collabData.todos[0].label,'旧标签');
        assert.equal(state.todoData.todos[0].label,'数学');
    });
    it('落盘失败回滚新集合并保留旧数据，下一次保存仍可成功', async () => {
        let success = false;
        const state = {activeSource:{type:'personal'},todoData:{todos:[{id:'existing',content:'原有任务'}],time_entries:[],daily_reviews:[]}};
        const commit = runInNewContext('let _saveQueue=Promise.resolve(); let _lastRenderedHash="";' + declaration('commitLearning') + ';commitLearning', {
            requirePersonalTarget, ...learningHelpers, appState:state, structuredClone, render:()=>{}, learningUI:{refresh:()=>{}}, _doSaveData:async()=>success
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
            requirePersonalTarget, ...learningHelpers, appState:{todoData:{todos:[]},appConfig:{sync_mode:'local'},saveVersion:0},
            setSyncStatus:()=>{}, SyncState:{SYNCING:1,ERROR:2}, purgeOldDeletedTodos:()=>{},
            invoke:async()=>{throw new Error('磁盘写入失败');}, console:{error:()=>{}}, Date
        });
        assert.equal(await save(),false);
    });
    it('实际写入成功后保留计时记录，云端失败不回滚已经落盘的记录', async () => {
        for (const mode of ['local', 'webdav']) {
            let persisted;
            const state = {activeSource:{type:'personal'},todoData:{todos:[],time_entries:[],daily_reviews:[]},appConfig:{sync_mode:mode},saveVersion:0};
            const commit = runInNewContext('let _saveQueue=Promise.resolve(); let _lastRenderedHash="";' + declaration('_doSaveData') + declaration('commitLearning') + ';commitLearning', {
                requirePersonalTarget, ...learningHelpers, appState:state, structuredClone, Date, setTimeout:()=>{},
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
