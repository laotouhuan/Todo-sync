import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { createDataCoordinator } from '../src/dataCoordinator.js';
import * as dates from '../src/dateUtils.js';
import * as merge from '../src/dataMerge.js';
import { normalizeLearningData } from '../src/timeTracking.js';
import { requirePersonalTarget } from '../src/collaborationView.js';
import { applyReminderSettingsEdit, normalizeReminderSettings } from '../src/reminderSettingsConflict.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
const names = ['parsePersonalData', 'loadData', 'saveSettings', '_doSaveData', 'commitPersonal', 'commitPeriodData', 'createAndAddTodo', 'applyTaskType', 'openTimelineSubtask'];
const declarations = names.map(name => {
    const node = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    return source.slice(node.start, node.end);
}).join('\n');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function data(name) {
    return normalizeLearningData({ version: 1, last_updated: '2026-10-01T00:00:00Z', reminder_settings: {updated_at:null,enabled:true,privacy_mode:false,global_rules:[]}, todos: [{ ...dates.createTodo(name), id: name,
        updated_at: '2026-10-01T00:00:00Z', subtasks: [{ id: 'child', content: '子步骤', completed: true, completed_at: '2026-10-01T00:00:00.123Z' }] }] });
}
function harness(mode = 'local') {
    const state = { todoData: data('A'), appConfig: { sync_mode: mode, sync_path: 'A', webdav_filepath: 'A' }, personalTarget: 'A', activeSource: { type: 'personal' } };
    const disk = new Map([['A', structuredClone(state.todoData)], ['B', data('B')]]);
    const cloud = new Map([...disk].map(([key, value]) => [key, structuredClone(value)]));
    const notices = [], io = []; let config = structuredClone(state.appConfig), hook = async () => {}, childSave;
    const key = cfg => cfg.sync_mode === 'webdav' ? cfg.webdav_filepath : cfg.sync_path;
    const context = { ...dates, ...merge, normalizeLearningData, applyReminderSettingsEdit, normalizeReminderSettings, requirePersonalTarget, appState: state, structuredClone, Date, JSON,
        render() {}, closeEditModal() {}, updateSourceSelector() {}, learningUI: { refresh() {} },
        setSyncStatus(state) { context.todoSyncState = state; }, todoSyncState: 'idle',
        SyncState: { IDLE: 'idle', SYNCING: 'syncing', ERROR: 'error' }, statusEl: null, showToast: message => notices.push(message), console: { log() {}, error() {} },
        setTimeout() {}, purgeOldDeletedTodos() {}, window: { confirm: () => true },
        document: { getElementById: () => null, querySelector: () => null },
        editTimelineSubtask: (_task, _child, save) => { childSave = save; },
        invoke: async (cmd, args = {}) => {
            const target = key(args.config || config);
            io.push({ cmd, target, data: args.data });
            const captured = cmd === 'read_personal_target' ? { target, data: JSON.stringify(disk.get(target)), missing: false } :
                cmd === 'fetch_from_cloud' ? JSON.stringify(cloud.get(target)) : null;
            await hook(cmd, args);
            if (cmd === 'get_app_config') return structuredClone(config);
            if (cmd === 'read_personal_target' || cmd === 'fetch_from_cloud') return captured;
            if (cmd === 'activate_personal_target') { if (args.config.sync_mode === 'webdav') disk.set(target, JSON.parse(args.data)); config = structuredClone(args.config); return; }
            if (cmd === 'write_todo_data' || cmd === 'sync_to_cloud') {
                assert.equal(args.target, target, '底层写入必须属于提交目标');
                (cmd === 'write_todo_data' ? disk : cloud).set(target, JSON.parse(args.data)); return;
            }
            if (cmd === 'read_collaborations_data' || cmd === 'fetch_collaborations_from_cloud') return '{"collaborations":[]}';
            if (cmd === 'get_collaborations') return [];
        }
    };
    const api = runInNewContext('let personalLoadRequest = 0, _lastRenderedHash = "";' + declarations + `;({${names.join(',')}})`, context);
    context.dataStore = createDataCoordinator({ getData: () => state.todoData, install: next => { state.todoData = next; }, persist: api._doSaveData });
    context.dataStore.activate('A', state.todoData);
    return { api, state, disk, cloud, io, notices, store: context.dataStore,
        hook: next => { hook = next; }, config: () => config,
        editChild: () => { api.openTimelineSubtask(state.todoData.todos[0], state.todoData.todos[0].subtasks[0]); return childSave; } };
}

for (const mode of ['local', 'webdav']) {
    test(`${mode} 加载成功返回同步成功结果`, async () => {
        assert.equal(await harness(mode).api.loadData(), true);
    });
    test(`${mode} 实际设置保存保留原位置扩展，表单未改提醒不推进时钟`, async () => {
        const h = harness(mode);
        const original = normalizeReminderSettings({ updated_at: '2026-10-01T00:00:00Z', future: { keep: true },
            global_rules: [{ id: 'legacy-rule', time: '09:00', extension: ['未知规则字段'] }] });
        h.state.todoData.reminder_settings = structuredClone(original);
        const formRule = { ...original.global_rules[0] }; delete formRule.extension;
        const form = { enabled: true, privacy_mode: false, global_rules: [formRule] };
        await h.api.saveSettings(h.state.appConfig, form, h.store.ticket());
        assert.deepEqual(h.state.todoData.reminder_settings, original);
        await h.api.saveSettings(h.state.appConfig, { ...form, enabled: false }, h.store.ticket());
        assert.deepEqual(h.disk.get('A').reminder_settings.future, { keep: true });
        assert.deepEqual(h.disk.get('A').reminder_settings.global_rules[0].extension, ['未知规则字段']);
        assert.equal(h.disk.get('A').reminder_settings.enabled, false);
        assert.notEqual(h.disk.get('A').reminder_settings.updated_at, original.updated_at);
    });
    test(`${mode} 迟到刷新不撤销已保存的父任务和子步骤时间`, async () => {
        const h = harness(mode), started = deferred(), release = deferred();
        h.hook(async cmd => { if (cmd === (mode === 'local' ? 'read_personal_target' : 'fetch_from_cloud')) { started.resolve(); await release.promise; } });
        const loading = h.api.loadData(); await started.promise;
        await h.api.commitPeriodData(d => { d.todos[0].completed_at = '2026-10-28T10:45:00.000Z'; d.todos[0].updated_at = new Date().toISOString(); return d; });
        await h.editChild()({ content: '修改子步骤', completed_at: '2026-10-28T11:00:00.000Z' });
        release.resolve(); await loading;
        assert.equal(h.state.todoData.todos[0].completed_at, '2026-10-28T10:45:00.000Z');
        assert.equal(h.disk.get('A').todos[0].subtasks[0].completed_at, '2026-10-28T11:00:00.000Z');
        if (mode === 'webdav') assert.equal(h.cloud.get('A').todos[0].subtasks[0].content, '修改子步骤');
    });
    test(`${mode} 空队列切换先读取 B，不将 A 任务或提醒写入 B`, async () => {
        const h = harness(mode), originalB = structuredClone(h.disk.get('B'));
        await h.api.saveSettings({ ...h.state.appConfig, sync_path: 'B', webdav_filepath: 'B' }, { enabled: false, privacy_mode: true, global_rules: [] }, h.store.ticket());
        assert.equal(h.state.todoData.todos[0].content, 'B');
        assert.equal(h.disk.get('A').reminder_settings.enabled, false);
        assert.deepEqual(h.disk.get('B').todos, originalB.todos);
        assert.deepEqual(h.cloud.get('B').todos, originalB.todos);
        assert.equal(h.state.todoData.reminder_settings.enabled, true);
    });
}

test('云端读取失败不能作为手动同步成功结果', async () => {
    const h = harness('webdav');
    h.hook(async cmd => { if (cmd === 'fetch_from_cloud') throw new Error('模拟网络失败'); });
    assert.equal(await h.api.loadData(), false);
    assert.ok(h.notices.some(message => message.includes('同步失败')));
});

for (const secondFails of [false, true]) {
    test(`前一次编辑失败，排队新增${secondFails ? '失败并保留输入' : '成功且不会被回滚丢失'}`, async () => {
        const h = harness(), started = deferred(), release = deferred(); let writes = 0;
        h.hook(async cmd => { if (cmd !== 'write_todo_data') return; if (++writes === 1) { started.resolve(); await release.promise; throw new Error('磁盘失败'); } if (secondFails) throw new Error('磁盘仍失败'); });
        const first = h.api.commitPeriodData(d => { d.todos[0].content = '未保存编辑'; return d; });
        const rejected = assert.rejects(first, /保存失败/); await started.promise;
        const adding = h.api.createAndAddTodo('等待保存时新增');
        release.resolve(); await rejected;
        assert.equal(await adding, !secondFails);
        assert.deepEqual(h.disk.get('A').todos.map(t => t.content), secondFails ? ['A'] : ['A', '等待保存时新增']);
    });
}

test('切换等待在途本地写入和 A 的推送完成，排在切换后的旧目标操作拒绝执行', async () => {
    const h = harness('webdav'), started = deferred(), release = deferred();
    h.hook(async cmd => { if (cmd === 'write_todo_data') { started.resolve(); await release.promise; } });
    const saving = h.api.createAndAddTodo('A的新任务'); await started.promise;
    const switching = h.api.saveSettings({ ...h.state.appConfig, webdav_filepath: 'B' }, h.state.todoData.reminder_settings, h.store.ticket());
    const late = h.api.createAndAddTodo('旧目标的排队新增');
    release.resolve(); assert.equal(await saving, true); await switching;
    assert.equal(await late, false);
    assert.ok(h.cloud.get('A').todos.some(t => t.content === 'A的新任务'));
    assert.deepEqual(h.cloud.get('B').todos.map(t => t.content), ['B']);
});

test('B 网络读取失败不激活 B；随后重新加载仍只读取 A', async () => {
    const h = harness('webdav');
    h.hook(async (cmd, args) => { if (cmd === 'fetch_from_cloud' && args.config.webdav_filepath === 'B') throw new Error('超时'); });
    await assert.rejects(h.api.saveSettings({ ...h.state.appConfig, webdav_filepath: 'B' }, h.state.todoData.reminder_settings, h.store.ticket()), /超时/);
    assert.equal(h.config().webdav_filepath, 'A');
    await h.api.loadData();
    assert.deepEqual(h.state.todoData.todos.map(t => t.content), ['A']);
    assert.deepEqual(h.cloud.get('B').todos.map(t => t.content), ['B']);
});

test('乱序刷新与重复文件事件不会重复保存或覆盖新响应', async () => {
    const h = harness(), started = deferred(), release = deferred(); let reads = 0;
    h.hook(async cmd => { if (cmd === 'read_personal_target' && ++reads === 1) { started.resolve(); await release.promise; } });
    const old = h.api.loadData(); await started.promise;
    h.disk.get('A').todos[0].content = '外部新内容'; h.disk.get('A').todos[0].updated_at = '2099-01-01T00:00:00Z';
    await h.api.loadData(); release.resolve(); await old;
    const writes = h.io.filter(call => call.cmd === 'write_todo_data').length;
    await Promise.all([h.api.loadData(), h.api.loadData(), h.api.loadData()]);
    assert.equal(h.state.todoData.todos[0].content, '外部新内容');
    assert.equal(h.io.filter(call => call.cmd === 'write_todo_data').length, writes);
});

test('无变化的子步骤保存不写盘；并发修改同一字段保留草稿并报冲突', async () => {
    const h = harness(); const save = h.editChild();
    await save({ content: '子步骤', completed_at: '2026-10-01T00:00:00.123Z' });
    assert.equal(h.io.filter(call => call.cmd === 'write_todo_data').length, 0);
    await h.api.commitPeriodData(d => { d.todos[0].subtasks[0].content = '其他编辑'; return d; });
    await assert.rejects(save({content:'旧草稿内容',completed_at:'2026-10-01T00:00:00.123Z'}), /子步骤已变化/);
    assert.equal(h.disk.get('A').todos[0].subtasks[0].content, '其他编辑');
});

test('新目标 JSON 损坏时保留旧状态与配置', async () => {
    const h = harness('webdav'); h.cloud.set('B', {invalid:true});
    await assert.rejects(h.api.saveSettings({ ...h.state.appConfig, webdav_filepath:'B' }, h.state.todoData.reminder_settings, h.store.ticket()), /格式无效/);
    assert.equal(h.config().webdav_filepath, 'A'); assert.equal(h.state.todoData.todos[0].content, 'A');
    assert.deepEqual(h.cloud.get('B'), {invalid:true});
});
