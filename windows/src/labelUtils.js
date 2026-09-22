import { normalizeLabel } from './timeTracking.js';

// 操作快照只包含标签与 ID，保存时在最新任务上修改，保留其他字段。
export function labelGroups(todos) {
    const groups = new Map([[null, 0]]);
    for (const todo of todos.filter(t => !t.deleted)) {
        const label = normalizeLabel(todo.label);
        groups.set(label, (groups.get(label) || 0) + 1);
    }
    return [...groups].sort(([a], [b]) => a === null ? -1 : b === null ? 1 : a.localeCompare(b))
        .map(([label, count]) => ({ label, count }));
}

export function planLabelChange(todos, label, selectedIds = null) {
    const members = todos.filter(t => !t.deleted && normalizeLabel(t.label) === normalizeLabel(label));
    return { wholeLabel: selectedIds === null, label: normalizeLabel(label),
        expected: members.filter(t => selectedIds === null || selectedIds.includes(t.id))
            .map(t => ({ id: t.id, label: normalizeLabel(t.label) })) };
}

export function applyLabelChange(todos, plan, target, now) {
    const expected = new Map(plan.expected.map(t => [t.id, t.label]));
    if (plan.wholeLabel) {
        const members = todos.filter(t => !t.deleted && normalizeLabel(t.label) === plan.label);
        if (members.length !== expected.size || members.some(t => !expected.has(t.id))) throw new Error('标签所属任务已变化，请重新确认');
    }
    for (const [id, label] of expected) {
        const todo = todos.find(t => t.id === id && !t.deleted);
        if (!todo || normalizeLabel(todo.label) !== label) throw new Error('任务标签已变化或任务已删除，请重新确认');
    }
    const label = normalizeLabel(target); let count = 0;
    const updated = todos.map(t => {
        if (!expected.has(t.id) || normalizeLabel(t.label) === label) return t;
        count++; return { ...t, label, updated_at: now };
    });
    return { todos: updated, count };
}
