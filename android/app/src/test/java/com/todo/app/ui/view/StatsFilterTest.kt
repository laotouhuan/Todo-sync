package com.todo.app.ui.view

import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StatsFilterTest {
    private val allTypes = setOf("normal", "daily", "weekly", "monthly")

    private fun todo(
        id: String,
        taskType: String = TaskType.NORMAL,
        recurring: String = "none"
    ) = Todo(
        id = id,
        content = id,
        createdAt = "2026-09-01T00:00:00Z",
        taskType = taskType,
        recurring = recurring
    )

    @Test
    fun eachTaskTypeMatchesOnlyItsSelectedFilter() {
        assertTrue(matchesStatsTypeFilter(todo("normal"), setOf("normal")))
        assertTrue(matchesStatsTypeFilter(todo("daily", recurring = "daily_repeat"), setOf("daily")))
        assertTrue(matchesStatsTypeFilter(todo("weekly", taskType = TaskType.WEEKLY_CHECKIN), setOf("weekly")))
        assertTrue(matchesStatsTypeFilter(todo("monthly", taskType = TaskType.MONTHLY_CHECKIN), setOf("monthly")))

        assertFalse(matchesStatsTypeFilter(todo("normal"), setOf("daily")))
        assertFalse(matchesStatsTypeFilter(todo("daily", recurring = "daily_repeat"), setOf("normal")))
        assertFalse(matchesStatsTypeFilter(todo("unknown", taskType = "unknown"), allTypes))
    }

    @Test
    fun emptyAndCompleteSelectionsKeepTheirExistingMeaning() {
        val tasks = listOf(
            todo("normal"),
            todo("daily", recurring = "daily_repeat"),
            todo("weekly", taskType = TaskType.WEEKLY_CHECKIN),
            todo("monthly", taskType = TaskType.MONTHLY_CHECKIN)
        )

        assertTrue(tasks.none { matchesStatsTypeFilter(it, emptySet()) })
        assertTrue(tasks.all { matchesStatsTypeFilter(it, allTypes) })
    }

    @Test
    fun legacyMixedMarkersMatchEitherSelectedType() {
        val legacy = todo("mixed", taskType = TaskType.WEEKLY_CHECKIN, recurring = "daily_repeat")

        assertTrue(matchesStatsTypeFilter(legacy, setOf("daily")))
        assertTrue(matchesStatsTypeFilter(legacy, setOf("weekly")))
        assertFalse(matchesStatsTypeFilter(legacy, setOf("normal")))
    }
}
