package com.todo.app.data.model

import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId

// ====== Stats Helpers ======

/**
 * Categorize completed task by local time.
 * @param isoTimestamp ISO 8601 timestamp string
 * @returns 'morning' | 'afternoon' | 'evening' | 'night' | 'unknown'
 */
fun categorizeByTimeSlot(isoTimestamp: String?): String {
    return categorizeTimeSlot(isoTimestamp)
}

/**
 * Calculate the number of days a task has existed.
 * @param createdAt ISO timestamp
 * @param now Current date reference
 * @returns Age in days, or -1 if invalid
 */
fun calcTaskAgeDays(createdAt: String?, now: OffsetDateTime = OffsetDateTime.now()): Long {
    if (createdAt.isNullOrEmpty()) return -1
    return try {
        val createdDateTime = try {
            OffsetDateTime.parse(createdAt)
        } catch (e: Exception) {
            OffsetDateTime.ofInstant(Instant.parse(createdAt), ZoneId.systemDefault())
        }
        val duration = Duration.between(createdDateTime, now)
        val days = duration.toDays()
        if (days < 0) 0 else days
    } catch (e: Exception) {
        -1
    }
}

/**
 * Get health grade based on average age of incomplete tasks.
 * @param avgAgeDays Average age in days
 * @returns HealthGrade data class
 */
fun getHealthGrade(avgAgeDays: Double): HealthGrade {
    return when {
        avgAgeDays.isNaN() || avgAgeDays <= 0.0 -> HealthGrade("A", "清单已清空，太棒了！", 0xFF22C55E)
        avgAgeDays < 3.0 -> HealthGrade("A", "你的清单代谢非常健康！", 0xFF22C55E)
        avgAgeDays < 7.0 -> HealthGrade("B", "清单状态良好，继续保持", 0xFFF59E0B)
        else -> HealthGrade("C", "清单有些积压，试试清理一下？", 0xFFEF4444)
    }
}

/**
 * Calculate completion statistics for a list of todos.
 * @param todos All todos to analyze
 * @param todayStr Today's date string (YYYY-MM-DD)
 * @return Pair of (completed count, total count)
 */
fun calculateCompletionStats(todos: List<Todo>, todayStr: String): Pair<Int, Int> {
    val todayTodos = todos.filter {
        !it.deleted && (it.date == todayStr || it.isOverdue(todayStr))
    }
    val completed = todayTodos.count { it.completed }
    return completed to todayTodos.size
}

/**
 * Calculate current streak of consecutive days with at least one completed task.
 * @param todos All todos
 * @param todayStr Today's date string
 * @return Number of consecutive days with completions
 */
fun calculateStreak(todos: List<Todo>, todayStr: String): Int {
    val completedDates = todos
        .filter { !it.deleted && it.completed && it.completedAt != null }
        .mapNotNull { it.completedAt?.take(10) }
        .toSortedSet()
        .reversed()

    if (completedDates.isEmpty()) return 0

    var streak = 0
    var currentDate = java.time.LocalDate.parse(todayStr)

    for (dateStr in completedDates) {
        val date = try { java.time.LocalDate.parse(dateStr) } catch (_: Exception) { continue }
        if (date == currentDate || date == currentDate.minusDays(1)) {
            streak++
            currentDate = date.minusDays(1)
        } else {
            break
        }
    }
    return streak
}

/**
 * Calculate the best (longest) streak of consecutive days with completions.
 * @param todos All todos
 * @return The longest streak in days
 */
fun calculateBestStreak(todos: List<Todo>): Int {
    val completedDates = todos
        .filter { !it.deleted && it.completed && it.completedAt != null }
        .mapNotNull { it.completedAt?.take(10) }
        .toSortedSet()

    if (completedDates.isEmpty()) return 0

    var bestStreak = 1
    var currentStreak = 1
    val dateList = completedDates.toList()

    for (i in 1 until dateList.size) {
        val prev = try { java.time.LocalDate.parse(dateList[i - 1]) } catch (_: Exception) { continue }
        val curr = try { java.time.LocalDate.parse(dateList[i]) } catch (_: Exception) { continue }
        if (Duration.between(prev.atStartOfDay(), curr.atStartOfDay()).toDays() == 1L) {
            currentStreak++
            if (currentStreak > bestStreak) bestStreak = currentStreak
        } else {
            currentStreak = 1
        }
    }
    return bestStreak
}
