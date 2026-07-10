package com.todo.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.OffsetDateTime

class StatsUtilsTest {

    @Test
    fun testCalcTaskAgeDays() {
        val now = OffsetDateTime.parse("2026-06-15T12:00:00Z")
        
        // Exactly 5 days ago
        val age = calcTaskAgeDays("2026-06-10T12:00:00Z", now)
        assertEquals(5L, age)

        // Future -> 0
        val futureAge = calcTaskAgeDays("2026-06-20T12:00:00Z", now)
        assertEquals(0L, futureAge)

        // Invalid or null -> -1
        assertEquals(-1L, calcTaskAgeDays(null, now))
        assertEquals(-1L, calcTaskAgeDays("", now))
        assertEquals(-1L, calcTaskAgeDays("invalid", now))
    }

    @Test
    fun testGetHealthGrade() {
        assertEquals("A", getHealthGrade(Double.NaN).grade)
        assertEquals("A", getHealthGrade(0.0).grade)
        assertEquals("A", getHealthGrade(2.5).grade)
        assertEquals("B", getHealthGrade(5.0).grade)
        assertEquals("C", getHealthGrade(10.0).grade)
    }

    @Test
    fun testCalculateStreak() {
        val todos = listOf(
            Todo.create("A").apply { completed = true; completedAt = "2026-06-15T10:00:00Z" },
            Todo.create("B").apply { completed = true; completedAt = "2026-06-14T10:00:00Z" },
            Todo.create("C").apply { completed = true; completedAt = "2026-06-13T10:00:00Z" },
            Todo.create("D").apply { completed = true; completedAt = "2026-06-11T10:00:00Z" } // Gap on 12th
        )

        // Streak counting from 15th (today is 15th) -> 13, 14, 15 -> 3 days
        assertEquals(3, calculateStreak(todos, "2026-06-15"))

        // Streak counting from 16th (today is 16th, missed today but completed yesterday) -> 13, 14, 15 -> 3 days
        assertEquals(3, calculateStreak(todos, "2026-06-16"))

        // Streak counting from 17th (today is 17th, missed today and yesterday) -> 0
        assertEquals(0, calculateStreak(todos, "2026-06-17"))
    }

    @Test
    fun testCalculateBestStreak() {
        val todos = listOf(
            Todo.create("A").apply { completed = true; completedAt = "2026-06-15T10:00:00Z" },
            Todo.create("B").apply { completed = true; completedAt = "2026-06-14T10:00:00Z" },
            Todo.create("C").apply { completed = true; completedAt = "2026-06-13T10:00:00Z" },
            
            Todo.create("D").apply { completed = true; completedAt = "2026-06-10T10:00:00Z" },
            Todo.create("E").apply { completed = true; completedAt = "2026-06-09T10:00:00Z" },
            Todo.create("F").apply { completed = true; completedAt = "2026-06-08T10:00:00Z" },
            Todo.create("G").apply { completed = true; completedAt = "2026-06-07T10:00:00Z" } // Longest streak is 4
        )

        assertEquals(4, calculateBestStreak(todos))
    }

    @Test
    fun testCalculateCompletionStats() {
        val todayStr = "2026-06-15"
        val todos = listOf(
            Todo.create("Today 1", date = todayStr).apply { completed = true },
            Todo.create("Today 2", date = todayStr).apply { completed = false },
            Todo.create("Overdue", date = "2026-06-10").apply { completed = false }, // Overdue counts for today
            Todo.create("Future", date = "2026-06-20").apply { completed = false },  // Ignored
            Todo.create("Deleted", date = todayStr).apply { deleted = true }         // Ignored
        )

        val stats = calculateCompletionStats(todos, todayStr)
        assertEquals(1, stats.first) // completed
        assertEquals(3, stats.second) // total (Today 1, Today 2, Overdue)
    }
}
