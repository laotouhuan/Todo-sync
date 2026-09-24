package com.todo.app.widget

import com.todo.app.data.model.*
import java.time.Instant

internal sealed interface WidgetTimerState {
    data object Disabled : WidgetTimerState
    data object Idle : WidgetTimerState
    data class Running(val entry: TimeEntry) : WidgetTimerState
    data class Attention(val message: String) : WidgetTimerState
}

internal fun widgetTimerState(data: TodoData, enabled: Boolean, now: Instant = Instant.now()): WidgetTimerState {
    if (!enabled) return WidgetTimerState.Disabled
    val running = data.timeEntries.filter { !it.deleted && it.ended_at == null }
    if (running.isEmpty()) return WidgetTimerState.Idle
    if (running.size > 1) return WidgetTimerState.Attention("有 ${running.size} 条计时待处理")
    val start = Learning.instant(running.single().started_at)
    if (start == null || start > now) return WidgetTimerState.Attention("计时记录待核对")
    return WidgetTimerState.Running(running.single())
}

internal fun widgetTimerTitle(entry: TimeEntry): String =
    entry.task_content_snapshot.takeIf { it.isNotBlank() } ?: "未命名任务"

internal fun widgetTimerCandidates(data: TodoData, dates: DateStrings = DateStrings.now()): List<Todo> {
    val groups = classifyForTodayFocus(data.todos, dates.today, dates.thisWeek, dates.thisMonth)
    return groups.todayTasks + groups.weekTasks + groups.monthTasks
}

internal fun isWidgetTimingTodo(state: WidgetTimerState, todoId: String): Boolean =
    state is WidgetTimerState.Running && state.entry.task_ref == TaskReference(todoId)
