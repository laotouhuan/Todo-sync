import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as dateHelpers from '../src/dateUtils.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const statements = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
const openModal = statements.find(node => node.type === 'ExpressionStatement'
    && node.expression.left?.property?.name === 'openImportModal').expression.right;
function findNode(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of Object.values(node)) {
        const found = findNode(child, predicate);
        if (found) return found;
    }
    return null;
}
const confirm = findNode(statements, node => node.type === 'IfStatement'
    && node.test.name === 'importConfirmBtnEl').consequent.expression.arguments[1];

function element() {
    return {
        children: [], attributes: {}, classList: { add() {} },
        set innerHTML(value) { this.children = []; },
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener() {}
    };
}

for (const type of ['weekly', 'monthly']) {
    for (const selected of [[0, 1, 2], [0, 2]]) {
        it(`从上${type === 'weekly' ? '周' : '月'}导入 ${selected.length} 项保持原列表顺序`, async () => {
            const taskType = type === 'weekly' ? 'weekly_checkin' : 'monthly_checkin';
            const oldPeriod = type === 'weekly' ? dateHelpers.getLastWeekString() : dateHelpers.getLastMonthString();
            const currentPeriod = type === 'weekly' ? dateHelpers.getThisWeekString() : dateHelpers.getThisMonthString();
            // 文件存储顺序与拖拽排序不同，且上期完成状态也参与显示排序。
            const originals = [
                { content: '第二项', order: 20, completed: false },
                { content: '第三项', order: 5, completed: true },
                { content: '第一项', order: 10, completed: false }
            ].map(todo => ({ ...dateHelpers.createTodo(todo.content, oldPeriod), ...todo, task_type: taskType }));
            const before = JSON.stringify(originals);
            const state = { activeSource: { type: 'personal' }, todoData: { todos: [...originals] } };
            const list = element();
            const document = {
                getElementById: id => id === 'import-tasks-list' ? list : element(),
                querySelectorAll: () => list.children,
                createElement: element
            };
            const api = runInNewContext(`({ open: ${source.slice(openModal.start, openModal.end)}, confirm: ${source.slice(confirm.start, confirm.end)} })`, {
                ...dateHelpers, appState: state, document,
                deepClone: value => JSON.parse(JSON.stringify(value)),
                render() {}, saveData: async () => {}, closeImportModal() {}
            });
            api.open(type);
            const expected = originals.slice().sort(dateHelpers.sortFunc)
                .filter((_, index) => selected.includes(index)).map(todo => todo.content);
            list.children.forEach((item, index) => item.setAttribute('data-selected', String(selected.includes(index))));
            await api.confirm();
            const imported = state.todoData.todos.filter(todo => todo.date === currentPeriod).sort(dateHelpers.sortFunc);
            assert.deepEqual(imported.map(todo => todo.content), expected);
            assert.ok(imported.every(todo => !todo.completed && todo.completed_dates.length === 0));
            assert.equal(JSON.stringify(originals), before);
        });
    }
}

it('协作来源不能通过上期导入入口修改个人任务', async () => {
    const state = { activeSource: { type: 'collaboration', id: 'shared' }, todoData: { todos: [] } };
    const api = runInNewContext(`({ open: ${source.slice(openModal.start, openModal.end)}, confirm: ${source.slice(confirm.start, confirm.end)} })`, {
        appState: state, document: new Proxy({}, { get() { throw new Error('不应进入个人导入界面'); } })
    });
    api.open('weekly');
    await api.confirm();
    assert.deepEqual(state.todoData.todos, []);
});
