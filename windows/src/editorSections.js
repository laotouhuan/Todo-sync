import { sameTask } from './timeTracking.js';

// 只在打开编辑页时决定位置；后续内容刷新不重新分区。
export function editorProgressSections(todo, entries, ref, timingEnabled = true) {
    const sections = [];
    if (todo.subtasks?.length) sections.push('subtasks');
    if (timingEnabled && entries.some(e => !e.deleted && sameTask(e.task_ref, ref))) sections.push('timing');
    if (['weekly_checkin', 'monthly_checkin'].includes(todo.task_type) && todo.completed_dates?.length) sections.push('checkins');
    return sections;
}
