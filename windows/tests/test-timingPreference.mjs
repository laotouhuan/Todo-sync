import * as seriesHelpers from '../src/taskSeries.js';
import { learningSnapshot, requirePersonalTarget } from '../src/collaborationView.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import * as helpers from '../src/timeTracking.js';
import { sortFunc } from '../src/dateUtils.js';

// 调用真实视图逻辑，仅替换 DOM 与弹窗按钮，不启动浏览器。
const source = readFileSync(new URL('../src/learningView.js', import.meta.url), 'utf8');
const statements = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
const declaration = statements.find(n => n.type === 'ExportNamedDeclaration').declaration;
const localInput = statements.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'localInput');
function harness(entries = [], enabled = true, now = Date.now()) {
    const state = { appConfig: { time_tracking_enabled: enabled }, todoData: { todos: entries.filter(e => e.task_ref?.todo_id).map(e => ({ id: e.task_ref.todo_id, content: "已有任务", completed: false })), time_entries: structuredClone(entries), daily_reviews: [] }, activeSource: { type: 'personal' }, currentView: 'list' };
    let commits = 0, fail = false, scheduled = 0, cleared = 0, afterSync = () => {};
    const buttons = [], dialogs = [], errors = [];
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    function element(tag = '', text = '', className = '') {
        const classes = new Set(className.split(' '));
        const listeners = new Map();
        const node = { tag, textContent: text, children: [], dataset: {}, isConnected: true, open: true,
            get childElementCount() { return node.children.length; },
            classList: { add: name => classes.add(name), contains: name => classes.has(name) },
            append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
            replaceChildren() { node.children.forEach(child => { child.isConnected = false; }); node.children = []; },
            setAttribute() {},
            addEventListener(name, handler) { listeners.set(name, handler); },
            querySelector(selector) { return node.children.find(child => selector.startsWith('.') ? child.classList.contains(selector.slice(1)) : child.tag === selector); },
            close() { node.open = false; node.isConnected = false; listeners.get('close')?.(); }
        };
        return node;
    }
    const startButton = Object.assign(element('button'), { hidden: true });
    let banner;
    const create = runInNewContext(source.slice(localInput.start, localInput.end) + '\n' + source.slice(declaration.start, declaration.end) + ';createLearningView', {
        ...helpers, ...seriesHelpers, sortFunc, learningSnapshot, requirePersonalTarget, structuredClone, Date: FixedDate,
        el: element, button: (text, action) => {
            const b = Object.assign(element('button', text), { action });
            Object.defineProperty(b, 'text', { get: () => b.textContent }); buttons.push(b); return b;
        },
        input: (type, value, caption, host) => { const label = element('label', caption), field = element('input'); field.type = type; field.value = value; field.focus = () => {}; label.append(field); host.append(label); return field; },
        modal: title => { const d = Object.assign(element('dialog'), { title }); d.append(element('h3', title)); dialogs.push(d); return d; },
        document: {
            getElementById: id => id === 'start-timer-btn' ? startButton : null,
            querySelectorAll: selector => selector.startsWith('dialog') ? dialogs.filter(d => d.open && (!selector.includes('data-timing') || d.dataset.timing)) : [],
            querySelector: selector => selector === 'main' ? { before(node) { banner = node; } } : null
        },
        window: { addEventListener() {}, __TAURI__: {} },
        setInterval: () => ++scheduled, clearInterval: () => cleared++
    });
    const api = create({ state, sync: async () => afterSync(), toast: message => errors.push(message), commit: async change => {
        const next = structuredClone(state.todoData); change(next);
        if (fail) throw new Error('保存失败');
        state.todoData = next; commits++;
    } });
    api.install();
    return { state, api, buttons, dialogs, errors, startButton, banner: () => banner, fail: () => { fail = true; }, succeed: () => { fail = false; }, commits: () => commits,
        sync: callback => { afterSync = callback; },
        timers: () => [scheduled, cleared], choose: text => {
            if (text === '开始计时') { assert.equal(startButton.hidden, false); return startButton.onclick(); }
            return buttons.find(b => b.isConnected && b.text === text).action();
        } };
}
const entry = { id: 'e', task_content_snapshot: '测试计时', task_ref: { todo_id: 't' }, started_at: '2026-09-01T00:00:00Z', ended_at: null };

it('更换所属任务时保存原计时精度和新任务快照，并从原任务的记录列表移出', async () => {
    const original = { ...entry, started_at: '2026-09-01T08:00:00.125+08:00', ended_at: '2026-09-01T08:00:20.875+08:00' };
    const h = harness([original], true, Date.parse('2026-11-19T12:00:00Z'));
    const [oldTask] = h.state.todoData.todos;
    const target = { id: 'right', content: '往期打卡', label: '学习', task_type: 'weekly_checkin', date: '2026-W36', completed: true };
    h.state.todoData.todos.push(target);
    const [normalized] = helpers.normalizeLearningData(h.state.todoData).time_entries;
    h.api.showRecords([normalized], '计时记录', oldTask, helpers.taskReference(oldTask));
    const records = h.dialogs.at(-1).querySelector('.learning-records-body');
    await h.choose('编辑记录');
    const editor = h.dialogs.at(-1);
    await h.choose('更换任务');
    const picker = h.dialogs.at(-1);
    assert.equal(picker.querySelector('h3').textContent, '最近计时的任务');
    assert.equal(picker.querySelector('label').hidden, true);
    await h.choose('选择其他任务');
    const search = picker.querySelector('label').children[0];
    search.value = '往期'; search.oninput();
    const option = picker.querySelector('.learning-timer-candidates').children[0];
    assert.equal(option.children[0].textContent, target.content);
    await option.action();
    assert.ok(editor.children.some(node => node.textContent === '所属任务标签：学习（在任务编辑页修改）'));
    assert.equal(h.commits(), 0);

    target.deleted = true;
    await h.choose('保存记录');
    assert.equal(h.commits(), 0);
    assert.match(editor.querySelector('.learning-error').textContent, /所选任务已不可用/);
    target.deleted = false;
    target.label = '阅读';
    await h.choose('保存记录');
    assert.equal(h.commits(), 1);
    assert.equal(records.childElementCount, 0);
    assert.deepEqual(structuredClone(h.state.todoData.time_entries), [{ ...normalized, task_ref: helpers.taskReference(target),
        task_content_snapshot: target.content, label_snapshot: '阅读', updated_at: '2026-11-19T12:00:00.000Z' }]);
});

it('更换任务的最近列表和搜索都按关联去重，按计时开始日期选中对应一期', async () => {
    const older = { id: '15518504-d36a-4344-9362-d659cc3e70d1', content: '旧名', task_type: 'weekly_checkin', date: '2026-W36' };
    const newer = { ...older, id: '25518504-d36a-4344-9362-d659cc3e70d1', date: '2026-W37' };
    const seriesId = '35518504-d36a-4344-9362-d659cc3e70d1';
    const timer = { ...entry, started_at: '2026-09-02T08:00:00+08:00' };
    const records = [timer, ...[older, newer].map((task, i) => ({ ...entry, id: `past-${i}`, task_ref: helpers.taskReference(task),
        started_at: `2026-09-0${i + 3}T01:00:00Z`, ended_at: `2026-09-0${i + 3}T02:00:00Z` }))];
    const h = harness(records);
    h.state.todoData.todos = [{ id: 't', content: '原任务' }, { id: 'untimed', content: '未计时任务' }, older, newer];
    const stamp = '2026-09-01T00:00:00Z';
    h.state.todoData.task_series = [{ id: seriesId, content: '关联阅读', period_type: 'week', created_at: stamp, updated_at: stamp, content_updated_at: stamp }];
    h.state.todoData.task_series_links = [older, newer].map(task => ({ todo_id: task.id, series_id: seriesId, period: task.date, created_at: stamp, updated_at: stamp }));
    helpers.normalizeLearningData(h.state.todoData);
    h.api.editRecord(timer);
    await h.choose('更换任务');
    const picker = h.dialogs.at(-1);
    const options = () => picker.querySelector('.learning-timer-candidates').children.filter(node => node.tag === 'button');
    assert.deepEqual(options().map(node => node.children[0].textContent), ['关联阅读']);
    await h.choose('选择其他任务');
    const search = picker.querySelector('label').children[0]; search.value = '关联'; search.oninput();
    assert.equal(options().length, 1);
    assert.match(options()[0].children[1].textContent, /2026-W36/);
    await h.choose('返回最近任务');
    assert.equal(picker.querySelector('label').hidden, true);
    await options()[0].action();
    await h.choose('保存记录');
    assert.equal(h.state.todoData.time_entries.find(record => record.id === timer.id).task_ref.todo_id, older.id);
});

describe('统一计时入口实际交互', () => {
    const candidates = dialog => dialog.querySelector('.learning-timer-candidates').children.filter(child => child.tag === 'button');
    it('开始计时仍须等待云端核对结束，再保存并关闭选择面板', async () => {
        const h = harness();
        h.state.todoData.todos = [{ id: 't', content: '本地任务', completed: false }];
        h.api.refresh(); await h.choose('开始计时'); await h.choose('选择其他任务');
        const dialog = h.dialogs.at(-1);
        let release;
        h.sync(() => new Promise(resolve => { release = resolve; }));
        const pending = candidates(dialog)[0].action();
        await new Promise(resolve => setImmediate(resolve));
        try {
            assert.equal(dialog.open, true, '云端核对未完成时保留选择面板');
            assert.equal(h.state.todoData.time_entries.length, 0);
        } finally { release?.(); await pending; }
        assert.equal(dialog.open, false);
        assert.equal(h.state.todoData.time_entries.length, 1);
    });
    it('任务行仅显示运行标记，顶部入口提供最近列表及全部任务搜索', async () => {
        const h = harness();
        h.state.todoData.todos = Array.from({ length: 7 }, (_, i) => ({ id: String(i), content: `任务 ${i}`, completed: false, order: i }));
        h.state.todoData.todos.push({ id: 'new', content: '未计时任务', completed: false });
        h.state.todoData.time_entries = h.state.todoData.todos.slice(0, 7).map((todo, i) => ({ ...entry, id: `e${i}`,
            task_ref: helpers.taskReference(todo), started_at: `2026-09-01T0${i}:00:00Z`, ended_at: `2026-09-01T0${i}:01:00Z` }));
        h.api.attachTimer({ insertBefore() {}, querySelector: () => null }, h.state.todoData.todos[0]);
        assert.equal(h.buttons.length, 0);
        h.api.refresh(); await h.choose('开始计时');
        assert.equal(h.banner().hidden, true);
        assert.equal(h.buttons.some(b => b.text === '开始计时'), false);
        const dialog = h.dialogs.at(-1);
        assert.equal(candidates(dialog).length, 5);
        assert.deepEqual(candidates(dialog).map(b => b.children[0].textContent), ['任务 6', '任务 5', '任务 4', '任务 3', '任务 2']);
        await h.choose('选择其他任务');
        assert.equal(candidates(dialog).length, 8);
        const search = dialog.querySelector('label').children[0]; search.value = '未计时'; search.oninput();
        assert.deepEqual(candidates(dialog).map(b => b.children[0].textContent), ['未计时任务']);
        await h.choose('返回最近任务');
        assert.equal(candidates(dialog).length, 5);
    });
    it('选择时禁用全部候选并防止重复提交，保存失败保留面板和错误，可重试', async () => {
        const h = harness();
        h.state.todoData.todos = [{ id: 't', content: '新任务', label: '学习', completed: false }];
        h.api.refresh(); await h.choose('开始计时'); await h.choose('选择其他任务');
        const dialog = h.dialogs.at(-1);
        let release;
        h.sync(() => new Promise(resolve => { release = resolve; }));
        const item = candidates(dialog)[0], pending = item.action();
        assert.ok(candidates(dialog).every(b => b.disabled));
        await item.action();
        assert.equal(h.commits(), 0);
        h.fail(); release(); await pending;
        assert.equal(dialog.open, true);
        assert.equal(dialog.querySelector('.learning-error').textContent, '保存失败');
        assert.equal(h.state.todoData.time_entries.length, 0);
        h.succeed(); h.sync(() => {}); await candidates(dialog)[0].action();
        assert.equal(dialog.open, false); assert.equal(h.commits(), 1);
        assert.equal(h.state.todoData.time_entries[0].task_content_snapshot, '新任务');
    });
    it('计时关闭和数据源切换关闭选择面板，不保留过期入口', async () => {
        for (const change of [h => { h.state.appConfig.time_tracking_enabled = false; }, h => { h.state.activeSource = { type: 'collaboration', id: 'source' }; }]) {
            const h = harness(); h.api.refresh(); await h.choose('开始计时');
            const dialog = h.dialogs.at(-1); change(h); h.api.refresh();
            assert.equal(dialog.open, false); assert.equal(h.commits(), 0);
            assert.equal(h.startButton.hidden, true);
        }
    });
    it('运行期间保留计时栏并隐藏开始图标，结束后恢复图标', () => {
        const h = harness([entry]); h.api.refresh();
        assert.equal(h.startButton.hidden, true);
        assert.equal(h.banner().hidden, false);
        h.state.todoData.time_entries[0].ended_at = '2026-09-01T00:01:00Z'; h.api.refresh();
        assert.equal(h.startButton.hidden, false);
        assert.equal(h.banner().hidden, true);
    });
});

it('协作模式的实际计时与记录入口仅查看，个人计时关闭后仍能显示远端记录', () => {
    const h = harness([], false);
    h.state.activeSource = { type: 'collaboration', id: 'remote' };
    h.state.collabData = { todos: [{ id: 't', content: '对方任务' }], time_entries: [{ ...entry, task_ref: { todo_id: 't', source_type: 'personal', source_id: null } }], daily_reviews: [] };
    h.api.attachTimer({ insertBefore() {}, querySelector() {} }, { id: 't', content: '对方任务' });
    h.api.editRecord(h.api.resolvedEntries()[0]);
    assert.equal(h.api.enabled(), true);
    assert.ok(h.buttons.some(b => b.text === '记录'));
    assert.ok(h.buttons.some(b => b.text === '关闭'));
    assert.equal(h.buttons.filter(b => ['开始', '结束', '编辑记录', '删除', '补录计时记录'].includes(b.text)).length, 0);
    assert.equal(h.commits(), 0);
});

it('协作页面关闭本机计时时只处理个人运行记录，不处理对方计时', async () => {
    const h = harness([entry]);
    h.state.activeSource = { type: 'collaboration', id: 'remote' };
    h.state.collabData = { todos: [], time_entries: [{ ...entry, id: 'owner-entry' }], daily_reviews: [] };
    const disabling = h.api.prepareDisable();
    await h.choose('结束计时并关闭');
    assert.equal(await disabling, true);
    assert.ok(h.state.todoData.time_entries[0].ended_at);
    assert.equal(h.state.collabData.time_entries[0].ended_at, null);
});

describe('本机计时开关实际交互逻辑', () => {
    it('公共计时栏结束按钮丢弃不超过 30 秒的记录，成功后弹窗；较长记录正常保留', async () => {
        for (const duration of [0, 30000, 30001]) {
            const active = { ...entry, task_ref: { todo_id: 't', source_type: 'personal', source_id: null }, deleted: false };
            const h = harness([active], true, Date.parse(active.started_at) + duration);
            h.api.refresh();
            await h.choose('结束');
            assert.equal(h.errors.length, 0);
            assert.equal(h.state.todoData.time_entries[0].deleted, duration <= 30000);
            assert.equal(h.dialogs.filter(d => d.title === '计时过短').length, duration <= 30000 ? 1 : 0);
        }
    });
    it('结束短计时保存失败时保留运行状态，不弹出成功提示', async () => {
        const active = { ...entry, task_ref: { todo_id: 't', source_type: 'personal', source_id: null } };
        const h = harness([active], true, Date.parse(active.started_at) + 10000);
        h.api.refresh();
        h.fail(); await h.choose('结束');
        assert.equal(h.state.todoData.time_entries[0].ended_at, null);
        assert.deepEqual(h.errors, ['保存失败']);
        assert.equal(h.dialogs.length, 0);
    });
    it('设置中批量结束同时保留长记录、丢弃短记录且只提示一次', async () => {
        const now = Date.parse(entry.started_at) + 120000;
        const short = { ...entry, id: 'short', started_at: new Date(now - 30000).toISOString() };
        const h = harness([entry, short], true, now);
        const pending = h.api.prepareDisable(); h.choose('结束计时并关闭');
        assert.equal(await pending, true);
        assert.equal(h.state.todoData.time_entries[0].deleted, false);
        assert.equal(h.state.todoData.time_entries[1].deleted, true);
        assert.equal(h.dialogs.filter(d => d.title === '计时过短').length, 1);
        const failed = harness([short], true, now); failed.fail();
        const rejected = failed.api.prepareDisable(); failed.choose('结束计时并关闭');
        await assert.rejects(rejected, /保存失败/);
        assert.equal(failed.dialogs.filter(d => d.title === '计时过短').length, 0);
    });
    it('无运行记录无需弹窗或写入数据', async () => {
        const h = harness(); assert.equal(await h.api.prepareDisable(), true);
        assert.equal(h.dialogs.length, 0); assert.equal(h.commits(), 0);
    });
    it('仅关闭和取消均保留多条运行记录', async () => {
        for (const [choice, expected] of [['仅关闭本机计时功能', true], ['取消', false]]) {
            const h = harness([entry, { ...entry, id: 'e2' }]), before = structuredClone(h.state.todoData);
            const result = h.api.prepareDisable(); h.choose(choice);
            assert.equal(await result, expected); assert.equal(h.commits(), 0); assert.deepEqual(h.state.todoData, before);
        }
    });
    it('明确确认后一次结束所列记录并更新其时间戳', async () => {
        const h = harness([entry, { ...entry, id: 'e2' }, { ...entry, id: 'deleted', deleted: true }]);
        const result = h.api.prepareDisable(); h.choose('结束计时并关闭'); assert.equal(await result, true);
        assert.equal(h.commits(), 1);
        const [first, second, deleted] = h.state.todoData.time_entries;
        assert.ok(first.ended_at); assert.equal(first.updated_at, first.ended_at); assert.equal(second.ended_at, first.ended_at); assert.equal(deleted.ended_at, null);
    });
    it('确认期间出现新运行记录时拒绝结束，保存失败不应用数据', async () => {
        const h = harness([entry]);
        const result = h.api.prepareDisable(); h.state.todoData.time_entries.push({ ...entry, id: 'new' }); h.choose('结束计时并关闭');
        await assert.rejects(result, /运行记录已变化/); assert.equal(h.commits(), 0);
        const failed = harness([entry]); failed.fail(); const pending = failed.api.prepareDisable(); failed.choose('结束计时并关闭');
        await assert.rejects(pending, /保存失败/); assert.equal(failed.state.todoData.time_entries[0].ended_at, null);
    });
    it('关闭时无计时入口、弹窗或刷新定时器，重复刷新不重复注册', () => {
        const h = harness([entry], false);
        h.api.attachTimer(null, { id: 't' }); h.api.showRecords([entry]); h.api.refresh();
        assert.equal(h.dialogs.length, 0); assert.deepEqual(h.timers(), [0, 0]);
        h.state.appConfig.time_tracking_enabled = true; h.state.todoData.time_entries = [];
        h.api.refresh(); h.api.refresh(); assert.deepEqual(h.timers(), [1, 0]);
        h.state.appConfig.time_tracking_enabled = false; h.api.refresh(); assert.deepEqual(h.timers(), [1, 1]);
    });
});
