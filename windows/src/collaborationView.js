import { normalizeLearningData, overlappingEntries, taskReference } from './timeTracking.js';

export function learningSnapshot(state) {
    const source = state.activeSource;
    const readOnly = source.type === 'collaboration';
    const raw = readOnly ? state.collabData : state.todoData;
    const data = normalizeLearningData(structuredClone(raw || { todos: [] }));
    // 隐藏其他来源之前判定冲突，防止隐藏使异常记录重新计入。
    const conflicts = overlappingEntries(data.time_entries);
    if (readOnly) data.time_entries = data.time_entries.filter(e => e.task_ref.source_type === 'personal')
        .map(e => ({ ...e, task_ref: { ...e.task_ref, source_type: 'collaboration', source_id: source.id } }));
    return { data, conflicts, readOnly, tasks: (data.todos || []).map(todo => ({ todo, ref: taskReference(todo, source) })) };
}

export function requirePersonalTarget(source) {
    if (source.type !== 'personal') throw new Error('协作清单仅允许查看和新增任务');
}

function targetIdentity(source) {
    return JSON.stringify([source.id, source.webdav_url, source.webdav_username, source.webdav_filepath]);
}

// 提交保留到确认或明确放弃；重试从不重新创建任务或切换目标文件。
export function createCollaborationSubmissions({ write, getSource, refresh }) {
    const pending = new Map();
    function create(source, todo) {
        if (pending.has(source.id)) throw new Error('此清单还有待确认的新增，请先重试或放弃');
        const submission = { sourceId: source.id, name: source.name, identity: targetIdentity(source),
            todoJson: JSON.stringify(structuredClone(todo)), status: 'pending' };
        pending.set(source.id, submission);
        return submission;
    }
    async function send(id) {
        const submission = pending.get(id);
        if (!submission || submission.status === 'sending') return false;
        const source = getSource(id);
        if (!source || source.deleted || targetIdentity(source) !== submission.identity) throw new Error('原目标已移除或改变，请停止重试');
        submission.status = 'sending';
        try {
            await write(id, submission.todoJson);
        } catch (error) {
            submission.status = 'pending';
            throw error;
        }
        pending.delete(id);
        // 写入已确认；读取失败只能重试读取，不能恢复为待写入提交。
        await refresh(id);
        return true;
    }
    return { create, send, list: () => [...pending.values()], has: id => pending.has(id),
        discard: id => { if (pending.get(id)?.status !== 'sending') pending.delete(id); } };
}
