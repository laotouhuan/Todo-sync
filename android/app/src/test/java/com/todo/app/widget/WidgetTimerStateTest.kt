package com.todo.app.widget

import com.todo.app.data.model.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class WidgetTimerStateTest {
    private val now = Instant.parse("2026-09-22T08:00:00Z")
    private val entry = TimeEntry(id = "entry", task_ref = TaskReference("task"), started_at = "2026-09-21T08:00:00Z",
        created_at = now.toString(), updated_at = now.toString(), task_content_snapshot = "旧快照")
    private fun data(vararg entries: TimeEntry) = TodoData(1, "", emptyList(), timeEntries = entries.toList())

    @Test fun runningTimerDoesNotDependOnVisibleTasksAndKeepsSnapshot() {
        val state = widgetTimerState(data(entry), true, now) as WidgetTimerState.Running
        assertEquals("旧快照", widgetTimerTitle(state.entry))
        assertTrue(isWidgetTimingTodo(state, "task"))
        assertEquals("未命名任务", widgetTimerTitle(entry.copy(task_content_snapshot = " ")))
        val collaboration = WidgetTimerState.Running(entry.copy(task_ref = TaskReference("task", "collaboration", "source")))
        assertFalse(isWidgetTimingTodo(collaboration, "task"))
    }

    @Test fun disabledHidesConflictsAndInvalidRecords() {
        assertEquals(WidgetTimerState.Disabled, widgetTimerState(data(entry, entry.copy(id = "second")), false, now))
        assertTrue(widgetTimerState(data(entry, entry.copy(id = "second")), true, now) is WidgetTimerState.Attention)
        assertTrue(widgetTimerState(data(entry.copy(started_at = "bad")), true, now) is WidgetTimerState.Attention)
        assertTrue(widgetTimerState(data(entry.copy(started_at = now.plusSeconds(1).toString())), true, now) is WidgetTimerState.Attention)
        assertEquals(WidgetTimerState.Idle, widgetTimerState(data(entry.copy(deleted = true), entry.copy(ended_at = now.toString())), true, now))
    }

    @Test fun pickerUsesOnlyRecentFiveRegardlessOfFocusDateOrWidgetDisplayLimit() {
        val todos = (1..8).map { Todo.create("任务 $it", null).copy(id = it.toString()) }
        val records = todos.mapIndexed { index, todo ->
            val start = now.minusSeconds((8L - index) * 120)
            entry.copy(id = "entry-$index", task_ref = TaskReference(todo.id), started_at = start.toString(), ended_at = start.plusSeconds(60).toString())
        }
        val data = TodoData(1, "", todos, timeEntries = records)
        val result = widgetTimerCandidates(data)
        assertEquals(listOf("8", "7", "6", "5", "4"), result.map { it.todo.id })
        assertEquals(Learning.recentTimingTasks(todos, records), result)
        assertTrue(widgetTimerCandidates(data.copy(timeEntries = emptyList())).isEmpty())
        assertTrue(widgetTimerCandidates(data.copy(timeEntries = records + entry)).isEmpty())
    }
}
