package com.todo.app.data.repository

import com.todo.app.data.model.MergeUtils
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
}
