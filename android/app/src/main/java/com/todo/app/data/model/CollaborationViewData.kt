package com.todo.app.data.model

import java.time.LocalDate
import java.time.ZoneId

data class LearningViewData(val data: TodoData, val conflicts: Set<String>, val sourceId: String? = null) {
    val readOnly: Boolean get() = sourceId != null
    fun display(entry: TimeEntry) = if (entry.task_ref.source_id == sourceId && entry.task_ref.source_type == (if (readOnly) "collaboration" else "personal")) TaskSeriesLogic.display(data, entry.task_ref.todo_id, entry.task_content_snapshot) else entry.task_content_snapshot
    fun pending(entry: TimeEntry): String? {
        if (!readOnly) return TaskSeriesLogic.pending(data, entry)
        if (entry.task_ref.source_type != "collaboration" || entry.task_ref.source_id != sourceId) return null
        return TaskSeriesLogic.pending(data, entry.copy(task_ref = TaskReference(entry.task_ref.todo_id)))
    }
    val tasks: Map<TaskReference, Todo> get() = data.todos.associateBy {
        TaskReference(it.id, if (readOnly) "collaboration" else "personal", sourceId)
    }

    fun pendingIds(start: LocalDate, end: LocalDate, zone: ZoneId = ZoneId.systemDefault()): List<String> =
        data.timeEntries.filter { !it.deleted && (it.id in conflicts || pending(it) != null) &&
            Learning.instant(it.started_at)?.isBefore(end.atStartOfDay(zone).toInstant()) == true &&
            (it.ended_at == null || Learning.instant(it.ended_at)?.isAfter(start.atStartOfDay(zone).toInstant()) == true)
        }.map { it.id }
}

fun learningViewData(data: TodoData, sourceId: String? = null): LearningViewData {
    // 完整记录先判定重叠，隐藏其他来源不能使异常记录重新计入。
    val normalized = if (sourceId == null) data else data.copy(
        timeEntries = Learning.mergeTimes(data.timeEntries), dailyReviews = Learning.mergeReviews(data.dailyReviews))
    val conflicts = Learning.overlaps(normalized.timeEntries)
    val visible = if (sourceId == null) normalized else normalized.copy(timeEntries = normalized.timeEntries
        .filter { it.task_ref.source_type == "personal" }
        .map { it.copy(task_ref = it.task_ref.copy(source_type = "collaboration", source_id = sourceId)) })
    return LearningViewData(visible, conflicts, sourceId)
}

fun requirePersonalTarget(collaboration: Boolean) {
    check(!collaboration) { "协作清单仅允许查看和新增任务" }
}
