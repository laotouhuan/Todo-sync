package com.todo.app.data.model

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.IsoFields

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

/** 判断日期或 ISO 时间戳是否落在统计页指定的日、周或月内。 */
fun isDateInStatsPeriod(dateValue: String?, period: String, targetDate: LocalDate): Boolean {
    if (dateValue.isNullOrBlank()) return false
    val dateText = dateValue.take(10)
    return when (period) {
        "day" -> dateText == targetDate.toString()
        "week" -> try {
            val date = LocalDate.parse(dateText)
            date.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) &&
                date.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
        } catch (_: Exception) {
            false
        }
        else -> dateText.startsWith(monthStringOf(targetDate))
    }
}

private fun isCompletionTimeInStatsPeriod(
    completedAt: String?,
    period: String,
    targetDate: LocalDate
): Boolean = isDateInStatsPeriod(getLocalDateStringFromISO(completedAt), period, targetDate)

/** 判断待办是否应出现在指定统计周期中。 */
fun Todo.isIncludedInStatsPeriod(period: String, targetDate: LocalDate): Boolean {
    val isCheckin = taskType == TaskType.WEEKLY_CHECKIN || taskType == TaskType.MONTHLY_CHECKIN
    if (isCheckin) {
        val hasCheckin = completedDates.any { isDateInStatsPeriod(it, period, targetDate) }
        return when (period) {
            "week" -> (
                taskType == TaskType.WEEKLY_CHECKIN &&
                    date == weekStringOf(targetDate) && targetCount != null
                ) || hasCheckin
            "month" -> (
                taskType == TaskType.MONTHLY_CHECKIN &&
                    date == monthStringOf(targetDate) && targetCount != null
                ) || hasCheckin
            else -> hasCheckin
        }
    }

    if (completed && !completedAt.isNullOrBlank()) {
        return isCompletionTimeInStatsPeriod(completedAt, period, targetDate)
    }

    val dueDate = date ?: return false
    return when (period) {
        "day" -> dueDate == targetDate.toString()
        "week" -> dueDate == weekStringOf(targetDate) ||
            (dueDate.length == 10 && isDateInStatsPeriod(dueDate, period, targetDate))
        else -> dueDate == monthStringOf(targetDate) ||
            (dueDate.length == 10 && isDateInStatsPeriod(dueDate, period, targetDate))
    }
}

/** 计算指定周期内的打卡次数。 */
fun Todo.getStatsPeriodCheckinCount(period: String, targetDate: LocalDate): Int =
    completedDates.count { isDateInStatsPeriod(it, period, targetDate) }

data class StatsPeriodProgress(val completed: Double, val total: Double) {
    val fraction: Float
        get() = if (total == 0.0) 0f else (completed / total).toFloat()
}

/** 计算统计页进度；有目标次数的打卡任务按目标作为分母。 */
fun calculateStatsPeriodProgress(
    todos: List<Todo>,
    period: String,
    targetDate: LocalDate
): StatsPeriodProgress {
    var completedValue = 0.0
    var totalValue = 0.0

    todos.forEach { todo ->
        if (todo.taskType == TaskType.WEEKLY_CHECKIN || todo.taskType == TaskType.MONTHLY_CHECKIN) {
            val checkinCount = todo.getStatsPeriodCheckinCount(period, targetDate)
            val target = todo.targetCount
            if (target != null) {
                completedValue += minOf(target, checkinCount).toDouble()
                totalValue += target.toDouble()
            } else {
                completedValue += checkinCount.toDouble()
                totalValue += checkinCount.toDouble()
            }
        } else {
            totalValue += 1.0
            if (todo.completed) completedValue += 1.0
        }
    }

    return StatsPeriodProgress(completed = completedValue, total = totalValue)
}

data class StatsCompletionEvent(val todo: Todo, val completedAt: String) {
    val hasExplicitTime: Boolean
        get() = completedAt.length > 10 && completedAt.contains('T')
}

/** 收集指定周期内普通任务和打卡任务的所有完成事件。 */
fun collectStatsCompletionEvents(
    todos: List<Todo>,
    period: String,
    targetDate: LocalDate
): List<StatsCompletionEvent> = buildList {
    todos.forEach { todo ->
        if (todo.taskType == TaskType.WEEKLY_CHECKIN || todo.taskType == TaskType.MONTHLY_CHECKIN) {
            todo.completedDates
                .filter { isDateInStatsPeriod(it, period, targetDate) }
                .forEach { add(StatsCompletionEvent(todo, it)) }
        } else if (todo.completed && !todo.completedAt.isNullOrBlank() &&
            isCompletionTimeInStatsPeriod(todo.completedAt, period, targetDate)
        ) {
            add(StatsCompletionEvent(todo, todo.completedAt!!))
        }
    }
}

/** 返回打卡任务在指定统计周期中最新的一次打卡记录。 */
fun Todo.latestCheckinInStatsPeriod(period: String, targetDate: LocalDate): String? =
    completedDates.filter { isDateInStatsPeriod(it, period, targetDate) }.maxOrNull()

/**
 * Calculate current streak of consecutive days with at least one completed task.
 * @param todos All todos
 * @param todayStr Today's date string
 * @return Number of consecutive days with completions
 */
fun calculateStreak(todos: List<Todo>, todayStr: String): Int {
    val completedDatesSet = todos
        .filter { !it.deleted && it.completed && it.completedAt != null }
        .mapNotNull { getLocalDateStringFromISO(it.completedAt) }
        .toSet()

    if (completedDatesSet.isEmpty()) return 0

    var currentDate = try {
        java.time.LocalDate.parse(todayStr)
    } catch (_: Exception) {
        return 0
    }
    var streak = 0

    if (completedDatesSet.contains(currentDate.toString())) {
        // Streak starts today
    } else if (completedDatesSet.contains(currentDate.minusDays(1).toString())) {
        // Streak starts yesterday
        currentDate = currentDate.minusDays(1)
    } else {
        return 0
    }

    while (completedDatesSet.contains(currentDate.toString())) {
        streak++
        currentDate = currentDate.minusDays(1)
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
        .mapNotNull { getLocalDateStringFromISO(it.completedAt) }
        .distinct()
        .sorted()

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
