package com.todo.app.data.repository

import com.todo.app.data.model.MergeUtils
import com.todo.app.data.model.GlobalReminderRule
import com.todo.app.data.model.ReminderSettings
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.OffsetDateTime
import java.util.UUID

class MergeLogicTest {

    @Test
    fun testMergeConflict_LastWriteWins() {
        val id = UUID.randomUUID().toString()
        val localTime = "2026-06-15T12:00:00Z"
        val cloudTime = "2026-06-15T13:00:00Z"

        val localTodo = Todo.create("Local", date = "2026-06-15").copy(
            id = id,
            updatedAt = localTime,
            completed = false
        )

        val cloudTodo = Todo.create("Cloud", date = "2026-06-15").copy(
            id = id,
            updatedAt = cloudTime,
            completed = true // Cloud changed it to completed later
        )

        val localData = TodoData(1, localTime, listOf(localTodo))
        val cloudData = TodoData(1, cloudTime, listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        // Should take the cloud version because it has a later updatedAt
        assertEquals(1, mergedData.todos.size)
        assertEquals(true, mergedData.todos[0].completed)
        assertEquals("Cloud", mergedData.todos[0].content)
    }

    @Test
    fun testMerge_NonOverlapping() {
        val localTodo = Todo.create("Local Only")
        val cloudTodo = Todo.create("Cloud Only")

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        // Both should exist
        assertEquals(2, mergedData.todos.size)
        assertTrue(mergedData.todos.any { it.content == "Local Only" })
        assertTrue(mergedData.todos.any { it.content == "Cloud Only" })
    }

    @Test
    fun testMerge_CompletedDatesUnion() {
        val id = UUID.randomUUID().toString()
        
        val localTodo = Todo.create("Task").copy(
            id = id,
            completedDates = listOf("2026-06-01", "2026-06-03"),
            updatedAt = "2026-06-15T12:00:00Z"
        )
        
        val cloudTodo = Todo.create("Task").copy(
            id = id,
            completedDates = listOf("2026-06-02", "2026-06-03"),
            updatedAt = "2026-06-15T11:00:00Z"
        )

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        // Should union and sort completedDates
        assertEquals(1, mergedData.todos.size)
        val mergedTodo = mergedData.todos[0]
        assertEquals(listOf("2026-06-01", "2026-06-02", "2026-06-03"), mergedTodo.completedDates)
    }

    @Test
    fun testMerge_CompletedDatesDeduplicationWithTimestamp() {
        val id = UUID.randomUUID().toString()

        val localTodo = Todo.create("Task").copy(
            id = id,
            completedDates = listOf("2026-06-02", "2026-06-03T10:00:00Z"),
            updatedAt = "2026-06-15T12:00:00Z"
        )

        val cloudTodo = Todo.create("Task").copy(
            id = id,
            completedDates = listOf("2026-06-02T12:00:00Z", "2026-06-03"),
            updatedAt = "2026-06-15T11:00:00Z"
        )

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(1, mergedData.todos.size)
        val mergedTodo = mergedData.todos[0]
        assertEquals(listOf("2026-06-02T12:00:00Z", "2026-06-03T10:00:00Z"), mergedTodo.completedDates)
    }

    @Test
    fun testMerge_WeeklyCheckinCompletionRecalculation() {
        val id = UUID.randomUUID().toString()
        val targetDateStr = "2026-W03" // Weekly task

        val localTodo = Todo.create("Weekly Task", date = targetDateStr).copy(
            id = id,
            taskType = TaskType.WEEKLY_CHECKIN,
            targetCount = 2,
            completed = false,
            // 2026-W03 usually starts around Jan 12-18, 2026
            completedDates = listOf("2026-01-13"), // One checkin locally
            updatedAt = "2026-01-13T12:00:00Z"
        )

        val cloudTodo = Todo.create("Weekly Task", date = targetDateStr).copy(
            id = id,
            taskType = TaskType.WEEKLY_CHECKIN,
            targetCount = 2,
            completed = false,
            completedDates = listOf("2026-01-14"), // Another checkin on cloud
            updatedAt = "2026-01-14T12:00:00Z"
        )

        val localData = TodoData(1, "2026-01-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-01-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        val mergedTodo = mergedData.todos[0]
        // The union makes it 2 checkins in that week, so completed must become true
        assertEquals(listOf("2026-01-13", "2026-01-14"), mergedTodo.completedDates)
        assertTrue(mergedTodo.completed)
    }

    @Test
    fun testMerge_CompletedDatesDeletionSync() {
        val id = UUID.randomUUID().toString()

        val localTodo = Todo.create("Task").copy(
            id = id,
            completedDates = listOf("2026-06-02T10:00:00Z"),
            updatedAt = "2026-06-02T10:00:00Z"
        )

        val cloudTodo = Todo.create("Task").copy(
            id = id,
            completedDates = emptyList(),
            updatedAt = "2026-06-02T12:00:00Z" // Cloud deleted it later
        )

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(1, mergedData.todos.size)
        val mergedTodo = mergedData.todos[0]
        assertEquals(emptyList<String>(), mergedTodo.completedDates)
    }

    @Test
    fun testNormalizeData_MigrateOldFormat() {
        val oldWeekly = Todo.create("Old Weekly", date = "2026-01-15").copy(
            recurring = "weekly",
            taskType = "normal"
        )

        val oldData = TodoData(1, "2026-06-15T12:00:00Z", listOf(oldWeekly))
        val normalized = MergeUtils.normalizeData(oldData)

        val migrated = normalized.todos[0]
        assertEquals("none", migrated.recurring)
        assertEquals(TaskType.WEEKLY_CHECKIN, migrated.taskType)
    }

    @Test
    fun testMergeReminderSettings_IgnoresNewerRootTimestampFromTodoChanges() {
        val localRule = GlobalReminderRule(
            id = "rule-1",
            time = "09:00",
            body = "提醒"
        )
        val localData = TodoData(
            version = 1,
            last_updated = "2026-09-07T08:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(
                updatedAt = "2026-09-07T07:00:00Z",
                globalRules = listOf(localRule)
            )
        )
        val cloudData = TodoData(
            version = 1,
            last_updated = "2026-09-07T12:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(updatedAt = "2026-09-07T06:00:00Z")
        )

        val merged = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(listOf(localRule), merged.reminderSettings.globalRules)
    }

    @Test
    fun testMergeReminderSettings_NewerEmptySettingsPropagateDeletion() {
        val localData = TodoData(
            version = 1,
            last_updated = "2026-09-07T07:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(
                updatedAt = "2026-09-07T07:00:00Z",
                globalRules = listOf(GlobalReminderRule(id = "rule-1", time = "09:00"))
            )
        )
        val cloudData = TodoData(
            version = 1,
            last_updated = "2026-09-07T08:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(updatedAt = "2026-09-07T08:00:00Z")
        )

        val merged = MergeUtils.mergeTodoData(localData, cloudData)

        assertTrue(merged.reminderSettings.globalRules.isEmpty())
    }

    @Test
    fun testMergeReminderSettings_LegacyConflictPreservesNonEmptyRules() {
        val legacyRule = GlobalReminderRule(id = "legacy-rule", time = "18:00")
        val localData = TodoData(
            version = 1,
            last_updated = "2026-09-07T07:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(globalRules = listOf(legacyRule))
        )
        val cloudData = TodoData(
            version = 1,
            last_updated = "2026-09-07T12:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings()
        )

        val merged = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(listOf(legacyRule), merged.reminderSettings.globalRules)
    }

    @Test
    fun testHasContentChanges_IgnoresRootTimestampAndDetectsReminderChanges() {
        val base = TodoData(
            version = 1,
            last_updated = "2026-09-07T07:00:00Z",
            todos = emptyList()
        )
        val onlyRootChanged = base.copy(last_updated = "2026-09-07T08:00:00Z")
        val reminderChanged = onlyRootChanged.copy(
            reminderSettings = onlyRootChanged.reminderSettings.copy(privacyMode = true)
        )

        assertEquals(false, MergeUtils.hasContentChanges(base, onlyRootChanged))
        assertEquals(true, MergeUtils.hasContentChanges(base, reminderChanged))
    }

    @Test fun mergeLearningDataUsesDateAndPreservesTombstones() {
        val time = "2026-09-10T00:00:00Z"
        val review = com.todo.app.data.model.DailyReview("a", "2026-09-10", time, time, fact = "旧")
        val latest = review.copy(id = "b", updated_at = "2026-09-10T01:00:00Z", fact = "新")
        val entry = com.todo.app.data.model.TimeEntry("t", com.todo.app.data.model.TaskReference("task"), time, time, time)
        val local = TodoData(1, time, emptyList(), timeEntries = listOf(entry), dailyReviews = listOf(review))
        val cloud = local.copy(timeEntries = listOf(entry.copy(deleted = true)), dailyReviews = listOf(latest))
        val merged = MergeUtils.mergeTodoData(local, cloud)
        assertEquals(listOf(latest), merged.dailyReviews)
        assertTrue(merged.timeEntries.single().deleted)
        assertEquals(merged.dailyReviews, MergeUtils.mergeTodoData(cloud, local).dailyReviews)
        assertEquals(merged.timeEntries, MergeUtils.mergeTodoData(cloud, local).timeEntries)
    }

}
