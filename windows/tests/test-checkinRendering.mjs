import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as dateHelpers from '../src/dateUtils.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'createTodoItemElement');

// 轻量 DOM 替身运行实际列表渲染及展开事件，不启动整个应用。
function element() {
    return {
        children: [], style: {}, dataset: {}, listeners: {}, className: '',
        set innerHTML(html) {
            this.children = [...html.matchAll(/class="([^"]+)"/g)].map(match => {
                const child = element();
                child.className = match[1];
                return child;
            });
        },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        querySelector(selector) {
            for (const child of this.children) {
                if (child.className.split(' ').includes(selector.slice(1))) return child;
                const found = child.querySelector(selector);
                if (found) return found;
            }
            return null;
        }
    };
}

function renderTask(taskType, targetCount, expanded = false) {
    const todo = {
        id: 'checkin', content: '打卡任务', task_type: taskType,
        target_count: targetCount, completed_dates: [], subtasks: [],
        date: taskType === 'weekly_checkin' ? '2026-W40' : '2026-09'
    };
    const render = runInNewContext(source.slice(declaration.start, declaration.end) + ';createTodoItemElement', {
        ...dateHelpers,
        document: { createElement: element },
        appState: { expandedTaskIds: new Set(expanded ? [todo.id] : []), dateFilter: 'today' },
        getMetaHtml: () => '',
        extractCollaborator: content => ({ cleanContent: content }),
        getWeeklyCompletedCount: () => 0,
        getMonthlyCompletedCount: () => 0,
        getMondayFromWeek: () => new Date(2026, 8, 28),
        renderMonthCalendar: grid => grid.appendChild(Object.assign(element(), { className: 'checkin-grid-cell' })),
        learningUI: { attachTimer() {} }
    });
    return render(todo, '2026-09-30', '2026-10-01');
}

for (const taskType of ['weekly_checkin', 'monthly_checkin']) {
    it(`${taskType} 目标一次时首次渲染及展开均不显示方块`, () => {
        for (const expanded of [false, true]) {
            const item = renderTask(taskType, 1, expanded);
            assert.equal(item.querySelector('.compact-checkin-grid'), null);
            const info = item.querySelector('.todo-info');
            for (let i = 0; i < 2; i++) {
                info.listeners.click({ target: { closest: () => null } });
                assert.equal(item.querySelector('.compact-checkin-grid'), null);
            }
        }
    });

    it(`${taskType} 其他目标保留原有方块显示方式`, () => {
        for (const target of [null, 2]) {
            const item = renderTask(taskType, target);
            const grid = item.querySelector('.compact-checkin-grid');
            assert.ok(grid);
            if (taskType === 'monthly_checkin') {
                assert.equal(grid.style.display, 'none');
                const info = item.querySelector('.todo-info');
                info.listeners.click({ target: { closest: () => null } });
                assert.equal(grid.style.display, 'grid');
                info.listeners.click({ target: { closest: () => null } });
                assert.equal(grid.style.display, 'none');
            } else {
                assert.equal(grid.children.length, 7);
            }
        }
    });
}
