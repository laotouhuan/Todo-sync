package com.todo.app.data.repository

import com.todo.app.data.model.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TodoCompletionTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun sharedCompletionLogicNeverClonesAndRoundTripPreservesHistory() = runBlocking {
        for (completeSubtasks in listOf(true, false)) {
            val original = Todo.create("背单词", "2026-10-01").copy(recurring = RecurringType.DAILY_REPEAT,
                subtasks = listOf(Subtask("sub", "子任务", false)), reminder = Reminder("2026-10-01", "09:00", true))
            val copy = original.copy(id = "existing-copy", date = "2026-10-09")
            val data = TodoData(1, "2026-10-01T00:00:00Z", listOf(original, copy),
                reminderSettings = ReminderSettings(privacyMode = true),
                timeEntries = listOf(TimeEntry(id = "history", task_ref = TaskReference(original.id), started_at = "2026-10-01T00:00:00Z",
                    created_at = "2026-10-01T00:00:00Z", updated_at = "2026-10-01T00:00:00Z", ended_at = "2026-10-01T00:01:00Z")),
                dailyReviews = listOf(DailyReview("review", "2026-10-01", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", fact = "保留复盘")))
            val file = folder.newFile("$completeSubtasks.json").apply { writeText(Json.encodeToString(data)) }
            val store = PersonalDataStore(file)
            for ((index, completed) in listOf(true, false, true).withIndex()) {
                val current = store.ensureLoaded()
                val updated = current.copy(todos = toggleNormalTodos(current.todos, original.id, completeSubtasks,
                    "2026-10-08T08:00:0${index}Z"))
                store.commitLocked(updated)
                val saved = Json.decodeFromString<TodoData>(file.readText())
                assertEquals(listOf(original.id, copy.id), saved.todos.map { it.id })
                val task = saved.todos.first()
                assertEquals(completed, task.completed)
                assertEquals(completed, task.completedAt != null)
                assertEquals(original.date, task.date)
                assertEquals(original.recurring, task.recurring)
                assertEquals(original.reminder, task.reminder)
                assertEquals("sub", task.subtasks.single().id)
                assertEquals(completeSubtasks, task.subtasks.single().completed)
                assertEquals(copy, saved.todos.last())
                assertEquals(data.timeEntries, saved.timeEntries)
                assertEquals(data.dailyReviews, saved.dailyReviews)
                assertEquals(data.reminderSettings, saved.reminderSettings)
                assertEquals(completed, !Learning.canTimeTodo(task))
                assertEquals(if (completed) 0 else 1, Learning.recentTimingTasks(saved.todos, saved.timeEntries).size)
            }
        }
    }
}
