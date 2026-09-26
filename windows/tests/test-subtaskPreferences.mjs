import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';

// 执行真实事件处理器中的联动分支，避免复制实现掩盖入口遗漏。
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const branches = [];
function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'IfStatement' && source.slice(node.test.start, node.test.end).startsWith('appState.appConfig.complete_')) {
        branches.push(source.slice(node.start, node.end));
    }
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
    }
}
visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));

test('列表与编辑入口均遵守子步骤联动偏好', () => {
    assert.equal(branches.length, 3);
    for (const enabled of [undefined, false, true]) {
        for (const branch of branches) {
            const task = { completed: false, completed_at: null, subtasks: [
                { completed: true, completed_at: '2026-09-20T01:00:00Z' },
                { completed: false, completed_at: null }
            ] };
            const originalTime = task.subtasks[0].completed_at;
            const appState = { appConfig: {
                complete_subtasks_with_parent: enabled,
                complete_parent_with_subtasks: enabled
            } };
            runInNewContext(branch, { appState, t: task, todo: task, draft: task, allCompleted: true });
            if (branch.includes('complete_subtasks_with_parent')) {
                assert.equal(task.subtasks[1].completed, enabled === true);
                assert.equal(task.subtasks[0].completed_at, originalTime);
                assert.equal(task.completed, false);
            } else {
                assert.equal(task.completed, enabled === true);
                if (enabled) assert.ok(task.completed_at);
                task.completed = false;
                runInNewContext(branch, { appState, todo: task, draft: task, allCompleted: false });
                assert.equal(task.completed, false);
            }
        }
    }
});
