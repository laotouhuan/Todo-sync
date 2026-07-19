package com.todo.app.data.model

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.IsoFields

/**
 * Centralized date utility functions for Todo-related date operations.
 * Eliminates duplicated date logic across ListView, StatsView, and ViewModel.
 */

// ====== Task Type Constants ======

object TaskType {
    const val NORMAL = "normal"
    const val DAILY_REPEAT = "daily_repeat"
    const val WEEKLY_CHECKIN = "weekly_checkin"
    const val MONTHLY_CHECKIN = "monthly_checkin"
}

object RecurringType {
    const val NONE = "none"
    const val DAILY_REPEAT = "daily_repeat"
}

const val DEFAULT_TASK_TYPE = TaskType.NORMAL

// ====== Health Grade Data Class ======

data class HealthGrade(
    val grade: String,
    val text: String,
    val color: Long
)

// ====== Timestamp ======

/** Shared ISO-8601 timestamp with offset (e.g. "2026-06-15T12:00:00+08:00"). */
fun nowIso(): String =
    OffsetDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

/** ISO-8601 instant timestamp (e.g. "2026-06-15T04:00:00Z"). Use [nowIso] for offset-based timestamps. */
fun nowInstant(): String = Instant.now().toString()

/** Format an Instant as ISO-8601 offset datetime string. */
fun formatIso(instant: Instant): String =
    OffsetDateTime.ofInstant(instant, ZoneId.systemDefault())
        .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

/** Parse an ISO-8601 timestamp (with offset or Z) into local LocalDateTime. */
fun parseIsoToLocalDateTime(isoStr: String): java.time.LocalDateTime {
    return try {
        OffsetDateTime.parse(isoStr)
            .atZoneSameInstant(ZoneId.systemDefault())
            .toLocalDateTime()
    } catch (e: Exception) {
        val instant = Instant.parse(isoStr)
        OffsetDateTime.ofInstant(instant, ZoneId.systemDefault())
            .toLocalDateTime()
    }
}

// ====== Sorting ======

/** Standard comparator for Todo lists: incomplete first, then by order, then by createdAt desc. */
val TodoComparator = Comparator<Todo> { a, b ->
    if (a.completed != b.completed) return@Comparator if (a.completed) 1 else -1
    if (a.order != b.order) return@Comparator a.order.compareTo(b.order)
    b.createdAt.compareTo(a.createdAt)
}

// ====== Date Type Checks ======

private const val MONTH_DATE_LENGTH = 7 // "YYYY-MM"

/** Check if a date string represents a weekly period (e.g. "2026-W03"). */
fun isWeekDate(dateStr: String?): Boolean =
    dateStr != null && dateRegexWeek.containsMatchIn(dateStr)

private val dateRegexWeek = Regex("""^\d{4}-W\d{2}$""")

/** Check if a date string represents a monthly period (e.g. "2026-06"). */
fun isMonthDate(dateStr: String?): Boolean =
    dateStr != null && dateRegexMonth.containsMatchIn(dateStr)

private val dateRegexMonth = Regex("""^\d{4}-\d{2}$""")

// ====== Time Slot Helpers ======

/** Map an hour (0-23) to a time slot string. */
private fun hourToSlot(hour: Int): String = when (hour) {
    in 6..11 -> "morning"
    in 12..17 -> "afternoon"
    in 18..23 -> "evening"
    else -> "night"
}

fun categorizeTimeSlot(isoTimestamp: String?): String {
    if (isoTimestamp.isNullOrEmpty()) return "unknown"
    return try {
        val ldt = parseIsoToLocalDateTime(isoTimestamp)
        hourToSlot(ldt.hour)
    } catch (e: Exception) {
        "unknown"
    }
}

// ====== Todo Extension Functions ======

/**
 * Check if a todo is overdue.
 * A todo is overdue when its specific date (not week/month) is before today and it's not completed.
 */
fun Todo.isOverdue(todayStr: String): Boolean {
    val d = date ?: return false
    if (completed) return false
    // Exclude week and month tasks -- they don't have a specific due date
    if (isWeekDate(d) || isMonthDate(d)) return false
    return d < todayStr
}

/**
 * Get a human-readable label for the todo's date.
 */
fun Todo.getDateLabel(todayStr: String, tomorrowStr: String): String {
    val d = date ?: return ""
    return when {
        d == todayStr -> "今天"
        d == tomorrowStr -> "明天"
        isWeekDate(d) -> "周任务"
        isMonthDate(d) -> "月任务"
        else -> if (d.length >= 10) d.substring(5, 10) else d // show MM-DD
    }
}

/**
 * Get completion status label relative to due date.
 * Returns null if not applicable, or one of: '逾期完成', '提前完成', '按时完成'
 */
fun Todo.getCompletionStatusLabel(): String? {
    if (!completed) return null
    val ca = completedAt ?: return null
    val d = date ?: return null
    if (isWeekDate(d) || isMonthDate(d)) return null
    if (ca.length < 10) return null
    val completedDateStr = ca.take(10)
    return when {
        completedDateStr > d -> "逾期完成"
        completedDateStr < d -> "提前完成"
        else -> "按时完成"
    }
}

// ====== Date Formatting Helpers ======

/** Get all dates (Mon-Sun) of the current week. */
fun getThisWeekDates(): List<LocalDate> {
    val today = LocalDate.now()
    val monday = today.minusDays((today.dayOfWeek.value - 1).toLong())
    return (0..6).map { monday.plusDays(it.toLong()) }
}

/** Get all dates of the current month. */
fun getThisMonthDates(): List<LocalDate> {
    val today = LocalDate.now()
    val firstDay = today.withDayOfMonth(1)
    return (0 until today.lengthOfMonth()).map { firstDay.plusDays(it.toLong()) }
}

/** Format a LocalDate as ISO week string (e.g. "2026-W03"). */
fun weekStringOf(date: LocalDate): String {
    val week = date.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
    val year = date.get(IsoFields.WEEK_BASED_YEAR)
    return "$year-W${week.toString().padStart(2, '0')}"
}

/** Format a LocalDate as month string (e.g. "2026-06"). */
fun monthStringOf(date: LocalDate): String =
    "${date.year}-${date.monthValue.toString().padStart(2, '0')}"

fun Todo.getWeeklyCompletedCount(): Int {
    val dateStr = this.date?.takeIf { isWeekDate(it) } ?: return 0
    return this.completedDates.count { dStr ->
        runCatching { weekStringOf(LocalDate.parse(dStr)) == dateStr }.getOrDefault(false)
    }
}

fun Todo.getMonthlyCompletedCount(): Int {
    val dateStr = this.date?.takeIf { isMonthDate(it) } ?: return 0
    return this.completedDates.count { it.startsWith(dateStr) }
}

/**
 * Toggle a checkin date and return an updated Todo with recalculated completion status.
 * Handles: add/remove date, sort, compute completed count, check target.
 */
fun Todo.withToggledCheckinDate(dateStr: String): Todo {
    val dates = completedDates.toMutableList()
    val existingIndex = dates.indexOfFirst { it.startsWith(dateStr) }
    if (existingIndex > -1) {
        dates.removeAt(existingIndex)
    } else {
        val todayStr = java.time.LocalDate.now().toString()
        if (dateStr == todayStr) {
            dates.add(nowIso())
        } else {
            dates.add(dateStr)
        }
    }
    dates.sort()
    val tempTodo = copy(completedDates = dates)
    val completedCount = when (taskType) {
        TaskType.WEEKLY_CHECKIN -> tempTodo.getWeeklyCompletedCount()
        TaskType.MONTHLY_CHECKIN -> tempTodo.getMonthlyCompletedCount()
        else -> dates.size
    }
    val isCompletedNow = targetCount != null && completedCount >= targetCount!!
    return copy(
        completedDates = dates,
        completed = isCompletedNow,
        completedAt = if (isCompletedNow) (completedAt ?: nowIso()) else null,
        updatedAt = nowIso()
    )
}

// ====== Calendar Helpers ======

/**
 * Compute the week-aligned (Monday to Sunday) dates for the target month period.
 * Includes padded dates from previous and next months to ensure perfect grid alignment.
 */
fun getMonthCalendarDates(todoDate: String?): List<LocalDate> {
    val now = LocalDate.now()
    var targetDate = now
    if (todoDate != null && isMonthDate(todoDate)) {
        try {
            val parts = todoDate.split("-")
            val year = parts[0].toInt()
            val month = parts[1].toInt()
            targetDate = LocalDate.of(year, month, 1)
        } catch (_: Exception) {
            // 解析失败时使用当前日期作为后备
        }
    }

    val firstDay = targetDate.withDayOfMonth(1)
    val length = targetDate.lengthOfMonth()

    // Day of week: 1 (Mon) - 7 (Sun)
    val startDay = firstDay.dayOfWeek.value
    val offset = startDay - 1

    val list = mutableListOf<LocalDate>()

    // Previous month tail
    val prevMonth = firstDay.minusMonths(1)
    val prevLength = prevMonth.lengthOfMonth()
    for (i in offset - 1 downTo 0) {
        list.add(prevMonth.withDayOfMonth(prevLength - i))
    }

    // Current month days
    for (d in 1..length) {
        list.add(firstDay.withDayOfMonth(d))
    }

    // Next month head
    val totalCells = offset + length
    val remaining = (7 - (totalCells % 7)) % 7
    val nextMonth = firstDay.plusMonths(1)
    for (d in 1..remaining) {
        list.add(nextMonth.withDayOfMonth(d))
    }

    return list
}

data class ParsedCollaboratorContent(val cleanContent: String, val nickname: String?)

fun Todo.extractCollaboratorContent(): ParsedCollaboratorContent {
    val regex = Regex("""\s+\(由\s+\[(.+?)\]\s+添加\)$""")
    val match = regex.find(this.content)
    return if (match != null) {
        val nickname = match.groupValues[1]
        val cleanContent = this.content.substring(0, match.range.first)
        ParsedCollaboratorContent(cleanContent, nickname)
    } else {
        ParsedCollaboratorContent(this.content, null)
    }
}