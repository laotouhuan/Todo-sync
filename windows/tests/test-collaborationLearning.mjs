import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { learningSnapshot, requirePersonalTarget, createCollaborationSubmissions } from '../src/collaborationView.js';
import { summarizeLearning, resolveLearningEntries, normalizeLearningData } from '../src/timeTracking.js';
import { collectTimerArcs } from '../src/statsTimeline.js';
import { exportReviews } from '../src/reviewUtils.js';
import { createTodo, parseInputSyntax } from '../src/dateUtils.js';

const target = { id: 'shared', name: '分享者', webdav_url: 'https://example.test/dav/', webdav_username: 'user', webdav_filepath: 'todos.json' };
const start = '2026-10-06T09:00:00+08:00';
const entry = (id, source = 'personal', end = '2026-10-06T10:00:00+08:00') => ({ id, task_ref: { todo_id: 'task', source_type: source, source_id: source === 'personal' ? null : 'other' },
    started_at: start, ended_at: end, created_at: start, updated_at: start, label_snapshot: '旧标签', task_content_snapshot: '旧任务' });
const owner = () => ({ todos: [{ id: 'task', content: '分享者任务', label: '数学' }], time_entries: [entry('visible'), entry('hidden', 'collaboration')],
    daily_reviews: [{ id: 'review', date: '2026-10-06', fact: '分享者复盘', created_at: start, updated_at: start }] });
const state = remote => ({ activeSource: { type: 'collaboration', id: target.id }, collabData: remote,
    todoData: { todos: [{ id: 'task', content: '本机任务' }], time_entries: [entry('personal-only')], daily_reviews: [] } });

it('协作展示隔离个人数据、只复制映射引用并保留原文件', () => {
    const remote = owner(), before = structuredClone(remote), snapshot = learningSnapshot(state(remote));
    assert.deepEqual(snapshot.data.time_entries.map(e => e.id), ['visible']);
    assert.equal(snapshot.data.time_entries[0].task_ref.source_id, target.id);
    assert.equal(snapshot.tasks[0].ref.source_type, 'collaboration');
    assert.equal(snapshot.data.daily_reviews[0].fact, '分享者复盘');
    assert.deepEqual(remote, before);
    assert.equal(snapshot.readOnly, true);
});

it('跨来源重叠在学习汇总、任务汇总、时间线和导出中均保持零时长', () => {
    const snapshot = learningSnapshot(state(owner()));
    const resolved = resolveLearningEntries(snapshot.data.time_entries, snapshot.tasks);
    const day = new Date(start), date = '2026-10-06';
    const summary = summarizeLearning(resolved, date, '2026-10-07', undefined, snapshot.conflicts);
    assert.equal(summary.duration, 0);
    assert.equal(summary.pending, 1);
    assert.equal(summary.parts.filter(p => p.entry.task_ref.todo_id === 'task').length, 0);
    assert.equal(collectTimerArcs(resolved, { type: 'collaboration', id: target.id }, 'day', day, snapshot.conflicts).length, 0);
    const exported = exportReviews(snapshot.data, 'day', day, true, snapshot.tasks, snapshot.conflicts).content;
    assert.match(exported, /合计：0 秒/);
    assert.match(exported, /1 条待核对/);
    assert.doesNotMatch(exported, /旧任务|hidden/);
    // 复现过滤后重算的错误口径，确保本例确实能够识别退化。
    assert.equal(summarizeLearning(resolved, date, '2026-10-07').duration, 3600000);
});

it('完整冲突集合随隐藏来源删除而更新，并覆盖逐日及范围导出', () => {
    const remote = owner(); remote.time_entries[1].deleted = true;
    const snapshot = learningSnapshot(state(remote));
    const resolved = resolveLearningEntries(snapshot.data.time_entries, snapshot.tasks);
    assert.equal(snapshot.conflicts.size, 0);
    assert.equal(summarizeLearning(resolved, '2026-10-06', '2026-10-07', undefined, snapshot.conflicts).duration, 3600000);
    assert.match(exportReviews(snapshot.data, 'week', new Date(start), true, snapshot.tasks, snapshot.conflicts).content, /合计：1 小时/);
});

it('历史缺失任务、运行记录与旧文件保留兼容，空协作源不回退本机记录', () => {
    const remote = owner(); remote.todos = []; remote.time_entries = [entry('visible', 'personal', null)];
    const snapshot = learningSnapshot(state(remote));
    assert.equal(resolveLearningEntries(snapshot.data.time_entries, snapshot.tasks)[0].task_unavailable, true);
    assert.equal(summarizeLearning(snapshot.data.time_entries, '2026-10-06', '2026-10-07', undefined, snapshot.conflicts).running, 1);
    for (const data of [null, { todos: [] }]) assert.deepEqual(learningSnapshot(state(data)).data.time_entries, []);
    const personal = state(remote); personal.activeSource = { type: 'personal' };
    assert.equal(learningSnapshot(personal).data.time_entries[0].id, 'personal-only');
});

it('固定提交在服务器保存后超时重试不会重复，也不会覆盖已修改或软删除的任务', async () => {
    const remote = owner(), preserved = structuredClone(remote), payloads = [];
    let loseResponse = true;
    const queue = createCollaborationSubmissions({ getSource: () => target, refresh: async () => {}, write: async (id, json) => {
        const todo = JSON.parse(json); payloads.push([id, json]);
        if (!remote.todos.some(t => t.id === todo.id)) remote.todos.push(todo);
        if (loseResponse) { loseResponse = false; throw new Error('响应丢失'); }
    } });
    const todo = createTodo('新任务', null);
    queue.create(target, todo); todo.content = '输入已修改';
    await assert.rejects(queue.send(target.id), /响应丢失/);
    assert.throws(() => queue.create(target, createTodo('第二次', null)), /待确认/);
    remote.todos.find(t => t.id === todo.id).deleted = true;
    await queue.send(target.id);
    assert.deepEqual(payloads[0], payloads[1]);
    assert.equal(remote.todos.filter(t => t.id === todo.id).length, 1);
    assert.equal(remote.todos.find(t => t.id === todo.id).deleted, true);
    assert.deepEqual(remote.time_entries, preserved.time_entries);
    assert.deepEqual(remote.daily_reviews, preserved.daily_reviews);
    assert.equal(queue.list().length, 0);
});

it('未写入失败可以重试；原目标改变或移除时禁止发送', async () => {
    let source = target, calls = 0;
    const queue = createCollaborationSubmissions({ getSource: () => source, refresh: async () => {}, write: async () => { if (++calls === 1) throw Error('未发送'); } });
    queue.create(target, createTodo('任务', null));
    await assert.rejects(queue.send(target.id));
    source = { ...target, webdav_filepath: 'another.json' };
    await assert.rejects(queue.send(target.id), /目标/);
    source = null;
    await assert.rejects(queue.send(target.id), /目标/);
    assert.equal(calls, 1);
    source = target;
    await queue.send(target.id);
    assert.equal(calls, 2);
});

it('写入确认后的刷新失败只需重新读取，不再保留待写入负载', async () => {
    let writes = 0;
    const queue = createCollaborationSubmissions({ getSource: () => target, write: async () => { writes++; }, refresh: async () => { throw Error('刷新失败'); } });
    queue.create(target, createTodo('任务', null));
    await assert.rejects(queue.send(target.id), /刷新失败/);
    assert.equal(queue.list().length, 0);
    assert.equal(await queue.send(target.id), false);
    assert.equal(writes, 1);
});

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const ast = parse(main, { ecmaVersion: 'latest', sourceType: 'module' });
function declarations(names) {
    return ast.body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => main.slice(node.start, node.end)).join('\n');
}

it('实际新增入口失败后不会再生成 UUID，重试仍使用第一次的完整负载', async () => {
    const shared = owner(), appState = state(shared); appState.appConfig = {}; appState.collaborations = [target];
    const sent = []; let creates = 0;
    const queue = createCollaborationSubmissions({ getSource: () => target, refresh: async () => {}, write: async (_, json) => {
        const todo = JSON.parse(json); sent.push(json);
        if (!shared.todos.some(t => t.id === todo.id)) shared.todos.push(todo);
        if (sent.length === 1) throw Error('响应超时');
    } });
    const context = { appState, collaborationSubmissions: queue, parseInputSyntax, createTodo: (...args) => { creates++; return createTodo(...args); },
        renderPendingSubmissions() {}, showToast() {}, Date, console };
    runInNewContext(declarations(['createAndAddTodo', 'applyTaskType']) + '\nthis.add = createAndAddTodo;', context);
    assert.equal(await context.add('新增任务'), false);
    assert.equal(await context.add('改变后的输入'), false);
    assert.equal(creates, 1);
    await queue.send(target.id);
    assert.equal(sent[0], sent[1]);
});

it('实际个人保存队列按目标判断权限，接受的保存不因切换到协作页面而被阻断', async () => {
    const appState = state(owner()); appState.activeSource = { type: 'personal' };
    let release, saves = 0;
    const queue = new Promise(resolve => { release = resolve; });
    const context = { appState, requirePersonalTarget, normalizeLearningData, structuredClone, _saveQueue: queue,
        _doSaveData: async () => { saves++; return true; }, _lastRenderedHash: '', render() {}, learningUI: { refresh() {} } };
    runInNewContext(declarations(['commitLearning']) + '\nthis.commit = commitLearning;', context);
    const accepted = context.commit(data => { data.daily_reviews = [{ id: 'mine', date: '2026-10-06', fact: '个人复盘' }]; });
    appState.activeSource = { type: 'collaboration', id: target.id };
    release(); await accepted;
    assert.equal(appState.todoData.daily_reviews[0].fact, '个人复盘');
    assert.equal(appState.collabData.daily_reviews[0].fact, '分享者复盘');
    assert.throws(() => context.commit(() => {}), /仅允许/);
    await context.commit(() => {}, { type: 'personal' });
    assert.equal(saves, 2);
});
