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

    @Test fun pickerIncludesFullFocusListWithoutWidgetDisplayLimit() {
        val todos = (1..30).map { Todo.create("任务 $it", "2026-09-22") }
        val hidden = Todo.create("删除任务", "2026-09-22").copy(deleted = true)
        val result = widgetTimerCandidates(TodoData(1, "", todos + hidden),
            DateStrings("2026-09-22", "2026-09-23", "2026-W39", "2026-09"))
        assertEquals(30, result.size)
        assertFalse(result.any { it.deleted })
    }
}
