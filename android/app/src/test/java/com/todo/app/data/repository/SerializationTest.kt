package com.todo.app.data.repository

import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.data.model.ReminderSettings
import com.todo.app.data.model.CollaborationData
import com.todo.app.data.model.MergeUtils
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.time.OffsetDateTime

class SerializationTest {

    private val jsonFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }

    private fun contractFixture(name: String): String = requireNotNull(
        javaClass.classLoader?.getResourceAsStream("contract/$name")
    ) { "共享数据样例不存在：$name" }.bufferedReader().use { it.readText() }

    @Test
    fun sharedLegacyFixtureKeepsOldDefaultsAndMigratesRecurringValue() {
        val decoded = jsonFormat.decodeFromString<TodoData>(contractFixture("legacy-personal.json"))
        val normalized = MergeUtils.normalizeData(decoded)
        val todo = normalized.todos.single()

        assertEquals("daily_repeat", todo.recurring)
        assertEquals("normal", todo.taskType)
        assertFalse(todo.completed)
        assertFalse(todo.deleted)
        assertEquals(emptyList<String>(), todo.completedDates)
        assertEquals(null, todo.reminder)
        assertEquals(null, todo.subtasks.single().completedAt)
        assertEquals(null, normalized.reminderSettings.updatedAt)
        assertTrue(normalized.reminderSettings.globalRules.isEmpty())
        assertTrue(normalized.timeEntries.isEmpty())
        assertTrue(normalized.dailyReviews.isEmpty())
    }

    @Test
    fun sharedCurrentFixtureRoundTripPreservesPersonalExtensions() {
        val current = MergeUtils.normalizeData(
            jsonFormat.decodeFromString<TodoData>(contractFixture("current-personal.json"))
        )
        val restored = jsonFormat.decodeFromString<TodoData>(jsonFormat.encodeToString(current))

        assertEquals(current.todos, restored.todos)
        assertEquals("学习", restored.todos.first().label)
        assertEquals(listOf("2026-09-09", "2026-09-10T11:30:00Z"), restored.todos[1].completedDates)
        assertEquals(current.reminderSettings, restored.reminderSettings)
        assertEquals(current.timeEntries, restored.timeEntries)
        assertEquals(current.dailyReviews, restored.dailyReviews)
    }

    @Test
    fun sharedCurrentFixtureMergePreservesPersonalExtensionsInBothDirections() {
        val current = jsonFormat.decodeFromString<TodoData>(contractFixture("current-personal.json"))
        // 文件更新时间较新，但提醒、计时和同日异 ID 复盘仍是旧版本。
        val other = TodoData(
            version = 1,
            last_updated = "2026-09-11T12:00:00Z",
            todos = emptyList(),
            reminderSettings = current.reminderSettings.copy(
                updatedAt = "2026-09-10T09:00:00Z",
                globalRules = emptyList()
            ),
            timeEntries = listOf(current.timeEntries.single().copy(
                updated_at = "2026-09-10T10:00:00Z",
                ended_at = null,
                label_snapshot = "旧分类"
            )),
            dailyReviews = listOf(current.dailyReviews.single().copy(
                id = "1b2c3d4e-5f60-4a71-8b92-000000000042",
                updated_at = "2026-09-10T11:00:00Z",
                fact = "旧复盘"
            ))
        )

        val results = listOf(
            MergeUtils.mergeTodoData(current, other),
            MergeUtils.mergeTodoData(other, current)
        )
        for (merged in results) {
            assertEquals(current.todos.associateBy { it.id }, merged.todos.associateBy { it.id })
            assertEquals(current.reminderSettings, merged.reminderSettings)
            assertEquals(current.timeEntries, merged.timeEntries)
            assertEquals(current.dailyReviews, merged.dailyReviews)
            assertEquals(1, merged.version)
            assertNotNull(OffsetDateTime.parse(merged.last_updated))
        }
    }

    @Test
    fun sharedCollaborationFixtureRoundTripPreservesDeletedSource() {
        val fixture = contractFixture("current-collaboration.json")
        val decoded = jsonFormat.decodeFromString<CollaborationData>(fixture)
        val restored = jsonFormat.decodeFromString<CollaborationData>(jsonFormat.encodeToString(decoded))

        assertEquals(2, restored.collaborations.size)
        assertFalse(restored.collaborations.first().deleted)
        assertTrue(restored.collaborations.last().deleted)
        assertEquals("NOT_A_REAL_PASSWORD", restored.collaborations.first().webdavPassword)
    }

    @Test
    fun testDeserializeOldJson() {
        // Simulates an older version of JSON without new fields like 'deleted' or 'task_type'
        val oldJson = """
        {
            "version": 1,
            "last_updated": "2026-06-15T12:00:00Z",
            "todos": [
                {
                    "id": "123",
                    "content": "Old Todo",
                    "created_at": "2026-06-15T12:00:00Z"
                }
            ]
        }
        """.trimIndent()

        val parsed = jsonFormat.decodeFromString<TodoData>(oldJson)
        
        assertEquals(1, parsed.todos.size)
        val todo = parsed.todos[0]
        assertEquals("123", todo.id)
        assertEquals("Old Todo", todo.content)
        
        // Assert defaults were applied
        assertFalse(todo.completed)
        assertFalse(todo.deleted)
        assertEquals("normal", todo.taskType)
        assertEquals("none", todo.recurring)
        assertEquals(0.0, todo.order, 0.0)
        assertEquals(null, parsed.reminderSettings.updatedAt)
    }

    @Test
    fun testDeserializeWithUnknownFields() {
        // Simulates future JSON format with unknown fields
        val futureJson = """
        {
            "version": 2,
            "last_updated": "2026-06-15T12:00:00Z",
            "future_field": "unknown_value",
            "todos": [
                {
                    "id": "123",
                    "content": "Todo",
                    "created_at": "2026-06-15T12:00:00Z",
                    "future_todo_field": true
                }
            ]
        }
        """.trimIndent()

        // Should not throw an exception because ignoreUnknownKeys = true
        val parsed = jsonFormat.decodeFromString<TodoData>(futureJson)
        assertEquals(1, parsed.todos.size)
    }

    @Test
    fun testSerializeDeserializeRoundTrip() {
        val original = TodoData(
            version = 1,
            last_updated = "2026-06-15T12:00:00Z",
            todos = listOf(
                Todo.create("Round Trip").copy(
                    deleted = true,
                    completedDates = listOf("2026-06-15"),
                    targetCount = 5
                )
            ),
            reminderSettings = ReminderSettings(updatedAt = "2026-06-15T12:30:00Z")
        )

        val jsonString = jsonFormat.encodeToString(original)
        val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)

        assertEquals(original, parsed)
        
        // Verify specific field
        assertEquals(5, parsed.todos[0].targetCount)
        assertTrue(parsed.todos[0].deleted)
        assertEquals("2026-06-15T12:30:00Z", parsed.reminderSettings.updatedAt)
    }

    @Test
    fun testDeserializeLegacyReminderSettingsWithoutUpdatedAt() {
        val legacyJson = """
        {
            "version": 1,
            "last_updated": "2026-06-15T12:00:00Z",
            "todos": [],
            "reminder_settings": {
                "enabled": true,
                "privacy_mode": false,
                "global_rules": []
            }
        }
        """.trimIndent()

        val parsed = jsonFormat.decodeFromString<TodoData>(legacyJson)

        assertEquals(null, parsed.reminderSettings.updatedAt)
        assertTrue(parsed.reminderSettings.enabled)
    }

    @Test
    fun testCreateOutputHasAllRequiredFields() {
        val todo = Todo.create("New Todo")
        val jsonString = jsonFormat.encodeToString(todo)
        
        // Assert jsonString contains the standard expected snake_case fields as dictated by @SerialName
        assertTrue(jsonString.contains("\"id\""))
        assertTrue(jsonString.contains("\"content\""))
        assertTrue(jsonString.contains("\"created_at\""))
        assertTrue(jsonString.contains("\"updated_at\""))
        assertTrue(jsonString.contains("\"task_type\""))
        assertTrue(jsonString.contains("\"completed_dates\""))
    }

    @Test fun oldDataDefaultsAndLabelRoundTrip() {
        val old = jsonFormat.decodeFromString<TodoData>("""{"version":1,"last_updated":"2026-09-10T00:00:00Z","todos":[]}""")
        assertTrue(old.timeEntries.isEmpty())
        assertTrue(old.dailyReviews.isEmpty())
        val updated = old.copy(todos = listOf(Todo.create("证明").copy(label = "数学")))
        val encoded = jsonFormat.encodeToString(updated)
        assertTrue(encoded.contains("time_entries"))
        assertTrue(encoded.contains("daily_reviews"))
        assertEquals("数学", jsonFormat.decodeFromString<TodoData>(encoded).todos.single().label)
    }

}
