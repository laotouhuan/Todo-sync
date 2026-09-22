import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { labelGroups, planLabelChange, applyLabelChange } from '../src/labelUtils.js';
import { resolveLearningEntries } from '../src/timeTracking.js';

const todo = (id, label, extra = {}) => ({ id, label, content: id, completed: false, updated_at: '2026-09-01T00:00:00Z', ...extra });
const now = '2026-09-17T00:00:00Z';
describe('个人标签批量操作', () => {
    it('包含完成任务、排除软删除并归一化未分类', () => {
        assert.deepEqual(labelGroups([todo('1', ' 学习 '), todo('2', '学习', { completed: true }), todo('3', '旧', { deleted: true }), todo('4', '未分类')]),
            [{ label: null, count: 1 }, { label: '学习', count: 2 }]);
    });
    it('只改选中标签与时间戳，保留最新内容及原始对象', () => {
        const old = [todo('1', '学习'), todo('2', '学习')];
        const plan = planLabelChange(old, '学习', ['1']);
        const latest = [{ ...old[0], content: '刚同步的内容', subtasks: [{ id: 's' }] }, old[1]];
        const result = applyLabelChange(latest, plan, ' 英语 ', now);
        assert.equal(result.count, 1);
        assert.deepEqual(result.todos[0], { ...latest[0], label: '英语', updated_at: now });
        assert.equal(result.todos[1], old[1]); assert.equal(latest[0].label, '学习');
    });
    it('同标签不写时间戳；移除保存 null', () => {
        const tasks = [todo('1', '学习')], plan = planLabelChange(tasks, '学习');
        assert.equal(applyLabelChange(tasks, plan, ' 学习 ', now).count, 0);
        assert.equal(applyLabelChange(tasks, plan, null, now).todos[0].label, null);
    });
    it('并发删除或标签变化时拒绝旧计划', () => {
        const tasks = [todo('1', '学习')], plan = planLabelChange(tasks, '学习', ['1']);
        assert.throws(() => applyLabelChange([], plan, '英语', now));
        assert.throws(() => applyLabelChange([todo('1', '学习', { deleted: true })], plan, '英语', now));
        assert.throws(() => applyLabelChange([todo('1', '工作')], plan, '英语', now));
    });
    it('标签级操作检查完整集合，批量勾选不影响新任务', () => {
        const tasks = [todo('1', '学习')], latest = [...tasks, todo('2', '学习')];
        assert.throws(() => applyLabelChange(latest, planLabelChange(tasks, '学习'), '英语', now));
        assert.equal(applyLabelChange(latest, planLabelChange(tasks, '学习', ['1']), '英语', now).todos[1].label, '学习');
    });
    it('合并不改目标任务，历史快照保留而统计按当前标签归类', () => {
        const tasks = [todo('1', '学习'), todo('2', '英语')];
        const result = applyLabelChange(tasks, planLabelChange(tasks, '学习'), '英语', now);
        assert.equal(result.todos[1], tasks[1]);
        const entry = { id: 'e', task_ref: { todo_id: '1', source_type: 'personal', source_id: null }, label_snapshot: '学习', updated_at: now };
        const display = resolveLearningEntries([entry], [{ todo: result.todos[0], ref: entry.task_ref }]);
        assert.equal(display[0].label_snapshot, '英语'); assert.equal(entry.label_snapshot, '学习');
    });
});
