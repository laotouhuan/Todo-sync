package com.todo.app.ui.view

import com.todo.app.data.model.*
import org.junit.Assert.*
import org.junit.Test

class EditTodoDialogTest {
    private fun legacy() = Todo.create("旧任务", "2026-10-01").copy(
        recurring = RecurringType.DAILY_REPEAT, updatedAt = "2026-01-01T00:00:00Z",
        reminder = Reminder("2026-10-01", "09:00", true), label = "学习",
        subtasks = listOf(Subtask("sub", "子任务", false))
    )

    private fun save(todo: Todo, type: String = todo.taskType, date: String = todo.date ?: "",
                     originalType: String = todo.taskType, originalRecurring: String = todo.recurring,
                     completedAt: String? = todo.completedAt) = buildUpdatedTodo(
        todo, "改正文", date, "", type, todo.targetCount, todo.completed, completedAt,
        todo.completedDates, todo.subtasks, todo.reminder, originalType, originalRecurring
    )

    @Test fun ordinaryEditPreservesLegacyFieldsAndRepeatReminder() {
        val original = legacy()
        val saved = save(original)
        assertEquals(original.id, saved.id)
        assertEquals(original.date, saved.date)
        assertEquals(original.recurring, saved.recurring)
        assertEquals(original.subtasks, saved.subtasks)
        assertEquals(original.reminder, saved.reminder)
        assertEquals(original.label, saved.label)
        assertNotEquals(original.updatedAt, saved.updatedAt)
        assertEquals("旧任务", original.content)
    }

    @Test fun finalTypeAndDeadlineInferenceDetermineWhetherMarkerIsCleared() {
        val original = legacy()
        for ((selected, date, finalType) in listOf(
            Triple(TaskType.WEEKLY_CHECKIN, "2026-W40", TaskType.WEEKLY_CHECKIN),
            Triple(TaskType.MONTHLY_CHECKIN, "2026-10", TaskType.MONTHLY_CHECKIN),
            Triple(TaskType.NORMAL, "2026-W40", TaskType.WEEKLY_CHECKIN),
            Triple(TaskType.NORMAL, "2026-10", TaskType.MONTHLY_CHECKIN)
        )) {
            val saved = save(original, selected, date)
            assertEquals(finalType, saved.taskType)
            assertEquals(RecurringType.NONE, saved.recurring)
            assertEquals(original.reminder, saved.reminder)
            assertNotEquals(original.updatedAt, saved.updatedAt)
        }
    }

    @Test fun changingAwayAndBackUsesOpeningBaselineAndNextTaskUsesItsOwn() {
        val original = legacy()
        val draft = original.copy(taskType = TaskType.WEEKLY_CHECKIN, recurring = RecurringType.NONE)
        assertEquals(RecurringType.DAILY_REPEAT,
            save(draft, TaskType.NORMAL, originalType = original.taskType, originalRecurring = original.recurring).recurring)
        val next = Todo.create("另一任务")
        assertEquals(RecurringType.NONE, save(next).recurring)
        val completed = original.copy(completed = true, completedAt = "2026-10-01T08:00:00Z")
        val saved = save(completed, completedAt = "2026-10-08T08:00:00Z")
        assertEquals(TaskType.NORMAL, saved.taskType)
        assertEquals(RecurringType.DAILY_REPEAT, saved.recurring)
        assertEquals("2026-10-08T08:00:00Z", saved.completedAt)
    }

    @Test fun mixedCheckinMarkerIsPreservedWhenFinalTypeIsUnchanged() {
        val mixed = legacy().copy(taskType = TaskType.WEEKLY_CHECKIN, date = "2026-W40")
        assertEquals(RecurringType.DAILY_REPEAT, save(mixed).recurring)
        assertEquals(RecurringType.NONE, save(mixed, TaskType.NORMAL, "2026-10-08").recurring)
    }
}
