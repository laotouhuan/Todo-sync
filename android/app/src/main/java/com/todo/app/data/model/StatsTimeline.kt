package com.todo.app.data.model

import java.time.*

data class SubtaskEvent(val todo: Todo, val subtask: Subtask, val date: LocalDate, val time: Instant?)
data class TimerArc(val part: LearningPart, val startMinute: Float, val endMinute: Float)

object StatsTimeline {
    // 任务与子步骤共用精确本地时间刻度，保留秒及小数秒。
    fun clockMinute(time: Instant, zone: ZoneId = ZoneId.systemDefault()): Double =
        time.atZone(zone).toLocalTime().toNanoOfDay() / 60_000_000_000.0

    fun subtasks(todos: List<Todo>, period: String, target: LocalDate, zone: ZoneId = ZoneId.systemDefault()): List<SubtaskEvent> {
        val (start, end) = Learning.range(period, target)
        return todos.filterNot { it.deleted }.flatMap { todo -> todo.subtasks.mapNotNull { s ->
            if (!s.completed || s.completedAt.isNullOrBlank()) return@mapNotNull null
            val time = Learning.instant(s.completedAt)
            val date = time?.atZone(zone)?.toLocalDate() ?: runCatching { LocalDate.parse(s.completedAt) }.getOrNull() ?: return@mapNotNull null
            if (date >= start && date < end) SubtaskEvent(todo, s, date, time) else null
        } }
    }
    fun arcs(entries: List<TimeEntry>, source: TaskReference, period: String, target: LocalDate, zone: ZoneId = ZoneId.systemDefault()): List<TimerArc> {
        val (start, end) = Learning.range(period, target)
        val conflicts = Learning.overlaps(entries)
        return entries.filter { it.id !in conflicts && it.task_ref.source_type == source.source_type && it.task_ref.source_id == source.source_id }
            .flatMap { Learning.split(it, zone) }.filter { it.date >= start && it.date < end }.flatMap { part ->
                val result = mutableListOf<TimerArc>(); var cursor = part.startedAt
                while (cursor < part.endedAt) {
                    val transition = zone.rules.nextTransition(cursor)?.instant
                    val next = if (transition != null && transition < part.endedAt) transition else part.endedAt
                    val minute = clockMinute(cursor, zone)
                    result.add(TimerArc(part, minute.toFloat(), minOf(1440.0, minute + Duration.between(cursor, next).toMillis() / 60000.0).toFloat()))
                    cursor = next
                }
                result
            }
    }
    fun hitArcs(arcs: List<TimerArc>, minute: Float, tolerance: Float = 0f): List<TimerArc> = arcs.filter { a ->
        listOf(minute, minute + 1440, minute - 1440).any { it >= a.startMinute - tolerance && it <= a.endMinute + tolerance }
    }
}
