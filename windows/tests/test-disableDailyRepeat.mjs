import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import * as dates from '../src/dateUtils.js';
import * as data from '../src/dataMerge.js';
import * as learning from '../src/timeTracking.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declaration = name => {
    const node = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    return source.slice(node.start, node.end);
};
function findTypeChange(node, kind = "ArrowFunctionExpression", content = "updateEditModalFields(taskTypeSelect.value)") {
    if (node.type === kind && source.slice(node.start, node.end).includes(content)) return node;
    for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
            if (child && typeof child === 'object' && child.type) {
                const found = findTypeChange(child, kind, content);
                if (found) return found;
            }
        }
    }
}
const typeChange = findTypeChange(tree);
const dragEnd = findTypeChange(tree, "FunctionExpression", "const originalTaskType = t?.task_type;");

// 调用真实的列表完成回调、编辑打开/关闭/保存和类型切换，只替换 DOM 和磁盘。
function harness(todos, completeSubtasks = true) {
    function element() {
        const selectors = new Map(), classes = new Set(), events = new Map();
        return { value: '', checked: false, style: {}, dataset: {}, children: [], scrollHeight: 30,
            classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
            querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, element()); return selectors.get(selector); },
            appendChild(node) { this.children.push(node); }, focus() {},
            addEventListener(event, action) { events.set(event, action); }, events
        };
    }
    const fields = new Map();
    const document = { createElement: element, querySelectorAll: () => [], getElementById(id) {
        if (!fields.has(id)) fields.set(id, element()); return fields.get(id);
    } };
    const state = { todoData: { todos: structuredClone(todos), time_entries: [{ id: 'history', task_ref: { todo_id: todos[0].id, source_type: 'personal' }, started_at: '2026-10-01T08:00:00Z', ended_at: '2026-10-01T08:01:00Z' }],
        daily_reviews: [{ id: 'review', fact: '保留复盘' }], reminder_settings: { enabled: true } },
        appConfig: { complete_subtasks_with_parent: completeSubtasks }, expandedTaskIds: new Set(),
        activeSource: { type: 'personal' }, currentEditingSubtasks: [], dateFilter: 'today' };
    let writes = 0;
    const scheduled = [];
    const names = ['createTodoItemElement', 'saveEditModal', 'openEditModal', 'closeEditModal', 'updateEditModalFields', 'getMetaHtml', 'getMondayFromWeek', 'applyTaskType', 'createAndAddTodo'];
    const api = runInNewContext('let _saveQueue=Promise.resolve(),_lastRenderedHash="",activeCheckinDropdown=null,_pendingMidnightRefresh=false,pendingAnimations=0,_currentlyDraggedTodoId=null,_currentlyHoveredHeaderType=null;' +
        names.map(declaration).join('\n') + `;({${names.join(',')}, changeType:${source.slice(typeChange.start, typeChange.end)}, dragHeader:(evt,header)=>{_currentlyHoveredHeaderType=header;return (${source.slice(dragEnd.start,dragEnd.end)})(evt);}})`, {
        ...dates, ...data, ...learning, appState: state, structuredClone, document, Date,
        todayStr: dates.getTodayString(), thisWeekStr: dates.getThisWeekString(), thisMonthStr: dates.getThisMonthString(),
        taskTypeSelect: document.getElementById('edit-task-type'),
        deepClone: structuredClone, extractCollaborator: content => ({ cleanContent: content, nickname: null }),
        escapeHtml: value => value, isReminderOverdue: () => false, renderMonthCalendar() {},
        renderEditSubtasks() {}, renderEditCheckinGrid() {}, render() {},
        learningUI: { editTask() {}, compactEditor() {}, attachTimer() {} },
        saveData: async () => { writes++; }, _doSaveData: async () => { writes++; return true; },
        showToast: message => { throw new Error(message); }, console,
        setTimeout: callback => { scheduled.push(Promise.resolve(callback())); }
    });
    return { api, state, field: id => document.getElementById(id), writes: () => writes,
        async toggle(id) {
            const row = api.createTodoItemElement(state.todoData.todos.find(t => t.id === id), dates.getTodayString(), dates.getTomorrowString());
            await row.querySelector('.checkbox').events.get('click')({ stopPropagation() {} });
            await Promise.all(scheduled.splice(0));
        }
    };
}
function legacy(id = 'legacy') {
    return { ...dates.createTodo('旧任务', '2026-01-01'), id, recurring: 'daily_repeat',
        updated_at: '2026-01-01T00:00:00Z',
        subtasks: [{ id: 'sub', content: '子任务', completed: false, completed_at: null }],
        reminder: { reminder_date: '2026-01-01', reminder_time: '09:00', repeat_daily: true } };
}

it('真实完成入口反复完成旧任务不新增 ID，保留已有副本、子任务、提醒与学习数据', async () => {
    for (const completeSubtasks of [true, false]) {
        const h = harness([legacy(), { ...legacy('existing-copy'), date: dates.getTomorrowString() }], completeSubtasks);
        const original = structuredClone(h.state.todoData);
        for (const completed of [true, false, true]) {
            await h.toggle('legacy');
            assert.deepEqual(h.state.todoData.todos.map(t => t.id), ['legacy', 'existing-copy']);
            assert.equal(learning.recentTimingTasks(h.state.todoData.todos, h.state.todoData.time_entries).length, completed ? 0 : 1);
            const task = h.state.todoData.todos[0];
            assert.equal(task.completed, completed);
            assert.equal(Boolean(task.completed_at), completed);
            assert.equal(task.recurring, 'daily_repeat');
            assert.equal(task.date, original.todos[0].date);
            assert.equal(task.subtasks[0].id, 'sub');
            assert.equal(task.subtasks[0].completed, completeSubtasks);
            assert.deepEqual(task.reminder, original.todos[0].reminder);
        }
        assert.equal(h.writes(), 3);
        assert.deepEqual(h.state.todoData.time_entries, original.time_entries);
        assert.deepEqual(h.state.todoData.daily_reviews, original.daily_reviews);
        assert.deepEqual(h.state.todoData.todos[1], original.todos[1]);
    }
});

it('编辑打开/取消不写数据；切换再切回按打开时基准保存标记和重复提醒', async () => {
    const h = harness([legacy(), { ...legacy('second'), recurring: 'none' }]);
    const original = structuredClone(h.state.todoData);
    h.api.openEditModal(h.state.todoData.todos[0]);
    assert.equal(h.field('edit-task-type').value, 'normal');
    assert.equal(h.field('edit-reminder-repeat-row').style.display, 'block');
    assert.equal(h.field('edit-reminder-repeat-daily').checked, true);
    h.api.closeEditModal();
    assert.equal(h.state.currentEditingOriginalType, null);
    assert.equal(h.writes(), 0);
    assert.deepEqual(h.state.todoData, original);
    h.api.openEditModal(h.state.todoData.todos[0]);
    h.field('edit-task-type').value = 'weekly_checkin'; h.api.changeType();
    h.field('edit-task-type').value = 'normal'; h.api.changeType();
    h.field('edit-content').value = '改正文';
    await h.api.saveEditModal();
    assert.equal(h.state.todoData.todos[0].recurring, 'daily_repeat');
    assert.deepEqual(structuredClone(h.state.todoData.todos[0].reminder), original.todos[0].reminder);
    assert.notEqual(h.state.todoData.todos[0].updated_at, original.todos[0].updated_at);
    h.api.openEditModal(h.state.todoData.todos[1]);
    await h.api.saveEditModal();
    assert.equal(h.state.todoData.todos[1].recurring, 'none');
});

it('实际保存按截止日期推导后的最终类型清标记，完成日期不改变任务类型', async () => {
    for (const [selected, date, finalType] of [['weekly_checkin', '', 'weekly_checkin'], ['normal', '2026-W40', 'weekly_checkin'], ['normal', '2026-10', 'monthly_checkin']]) {
        const h = harness([legacy()]); h.api.openEditModal(h.state.todoData.todos[0]);
        h.field('edit-task-type').value = selected;
        h.field('edit-date').value = date; h.field('edit-has-date-switch').checked = true;
        await h.api.saveEditModal();
        assert.equal(h.state.todoData.todos[0].task_type, finalType);
        assert.equal(h.state.todoData.todos[0].recurring, 'none');
        assert.equal(h.state.todoData.todos[0].reminder.repeat_daily, true);
    }
    const h = harness([{ ...legacy(), completed: true }]); h.api.openEditModal(h.state.todoData.todos[0]);
    h.field('edit-completed-date').value = '2026-10-08'; h.field('edit-completed-time').value = '10:00';
    await h.api.saveEditModal();
    assert.equal(h.state.todoData.todos[0].task_type, 'normal');
    assert.equal(h.state.todoData.todos[0].recurring, 'daily_repeat');
});

it('快捷创建保留退休语法正文，沿用默认日期且新任务不带重复标记', async () => {
    for (const pref of ['today', 'tomorrow', 'none']) {
        const h = harness([legacy()]); h.state.appConfig.default_due_date = pref;
        await h.api.createAndAddTodo('背单词 @daily');
        const task = h.state.todoData.todos.at(-1);
        assert.equal(task.content, '背单词 @daily');
        assert.equal(task.task_type, 'normal'); assert.equal(task.recurring, 'none');
        assert.equal(task.date, pref === 'today' ? dates.getTodayString() : pref === 'tomorrow' ? dates.getTomorrowString() : null);
    }
});

it('混合旧标记的周/月任务仍走打卡完成入口，不生成副本', async () => {
    for (const type of ['weekly_checkin', 'monthly_checkin']) {
        const task = { ...legacy(), task_type: type, target_count: 2,
            date: type === 'weekly_checkin' ? dates.getThisWeekString() : dates.getThisMonthString() };
        const h = harness([task]); await h.toggle(task.id);
        assert.equal(h.state.todoData.todos.length, 1);
        assert.equal(h.state.todoData.todos[0].completed, false);
        assert.equal(h.state.todoData.todos[0].completed_dates.length, 1);
        h.api.openEditModal(h.state.todoData.todos[0]);
        assert.equal(h.field('edit-task-type').value, type);
        h.field('edit-reminder-repeat-daily').checked = false;
        await h.api.saveEditModal();
        assert.equal(h.state.todoData.todos[0].recurring, 'daily_repeat');
        assert.equal(h.state.todoData.todos[0].reminder.repeat_daily, false);
    }
});


it('实际拖动改日期保留旧标记，仅改变最终类型时清除', async () => {
    for (const [type, header, finalType] of [
        ['normal', 'today', 'normal'], ['normal', 'weekly', 'weekly_checkin'],
        ['weekly_checkin', 'weekly', 'weekly_checkin'], ['monthly_checkin', 'monthly', 'monthly_checkin']
    ]) {
        const h = harness([{ ...legacy(), task_type: type }]);
        await h.api.dragHeader({ item: { dataset: { id: 'legacy' } } }, header);
        const saved = h.state.todoData.todos[0];
        assert.equal(saved.task_type, finalType);
        assert.equal(saved.recurring, type === finalType ? 'daily_repeat' : 'none');
    }
});
