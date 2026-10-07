import { learningSnapshot, requirePersonalTarget } from '../src/collaborationView.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import * as helpers from '../src/timeTracking.js';

// 调用真实视图逻辑，仅替换 DOM 与弹窗按钮，不启动浏览器。
const source = readFileSync(new URL('../src/learningView.js', import.meta.url), 'utf8');
const statements = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
const declaration = statements.find(n => n.type === 'ExportNamedDeclaration').declaration;
const localInput = statements.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'localInput');
function harness(entries = [], enabled = true, now = Date.now()) {
    const state = { appConfig: { time_tracking_enabled: enabled }, todoData: { todos: [], time_entries: structuredClone(entries), daily_reviews: [] }, activeSource: { type: 'personal' }, currentView: 'list' };
    let commits = 0, fail = false, scheduled = 0, cleared = 0;
    const buttons = [], dialogs = [], errors = [];
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const element = () => ({ dataset: {}, classList: { add() {} }, append() {}, replaceChildren() {}, addEventListener() {}, close() {} });
    const create = runInNewContext(source.slice(localInput.start, localInput.end) + '\n' + source.slice(declaration.start, declaration.end) + ';createLearningView', {
        ...helpers, learningSnapshot, requirePersonalTarget, structuredClone, Date: FixedDate,
        el: element, button: (text, action) => { const b = { text, action }; buttons.push(b); return b; },
        modal: title => { const d = { ...element(), title }; dialogs.push(d); return d; },
        document: { querySelectorAll: () => [], querySelector: () => null },
        setInterval: () => ++scheduled, clearInterval: () => cleared++
    });
    const api = create({ state, toast: message => errors.push(message), commit: async change => {
        const next = structuredClone(state.todoData); change(next);
        if (fail) throw new Error('保存失败');
        state.todoData = next; commits++;
    } });
    return { state, api, buttons, dialogs, errors, fail: () => { fail = true; }, commits: () => commits,
        timers: () => [scheduled, cleared], choose: text => buttons.find(b => b.text === text).action() };
}
const entry = { id: 'e', task_content_snapshot: '测试计时', task_ref: { todo_id: 't' }, started_at: '2026-09-01T00:00:00Z', ended_at: null };

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
    it('任务结束按钮丢弃不超过 30 秒的记录，成功后弹窗；较长记录正常保留', async () => {
        for (const duration of [0, 30000, 30001]) {
            const active = { ...entry, task_ref: { todo_id: 't', source_type: 'personal', source_id: null }, deleted: false };
            const h = harness([active], true, Date.parse(active.started_at) + duration);
            h.api.attachTimer({ insertBefore() {}, querySelector: () => null }, { id: 't' });
            await h.choose('结束');
            assert.equal(h.errors.length, 0);
            assert.equal(h.state.todoData.time_entries[0].deleted, duration <= 30000);
            assert.equal(h.dialogs.filter(d => d.title === '计时过短').length, duration <= 30000 ? 1 : 0);
        }
    });
    it('结束短计时保存失败时保留运行状态，不弹出成功提示', async () => {
        const active = { ...entry, task_ref: { todo_id: 't', source_type: 'personal', source_id: null } };
        const h = harness([active], true, Date.parse(active.started_at) + 10000);
        h.api.attachTimer({ insertBefore() {}, querySelector: () => null }, { id: 't' });
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
