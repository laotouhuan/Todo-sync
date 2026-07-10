package com.todo.app.data.repository

import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Test

class SerializationTest {

    private val jsonFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
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
            )
        )

        val jsonString = jsonFormat.encodeToString(original)
        val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)

        assertEquals(original, parsed)
        
        // Verify specific field
        assertEquals(5, parsed.todos[0].targetCount)
        assertTrue(parsed.todos[0].deleted)
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
}
