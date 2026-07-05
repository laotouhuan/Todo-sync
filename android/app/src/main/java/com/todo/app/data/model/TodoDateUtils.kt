package com.todo.app.data.model

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.IsoFields
import java.time.temporal.WeekFields
import java.util.Locale

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

// ====== Timestamp ======

/** Shared ISO-8601 timestamp with offset (e.g. "2026-06-15T12:00:00+08:00"). */
fun nowIso(): String =
    OffsetDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

/** ISO-8601 instant timestamp (e.g. "2026-06-15T04:00:00Z"). Use [nowIso] for offset-based timestamps. */
fun nowInstant(): String = Instant.now().toString()

// ====== Sorting ======

/** Standard comparator for Todo lists: incomplete first, then by order, then by created_at desc. */
val TodoComparator = Comparator<Todo> { a, b ->
    if (a.completed != b.completed) return@Comparator if (a.completed) 1 else -1
    if (a.order != b.order) return@Comparator a.order.compareTo(b.order)
    b.created_at.compareTo(a.created_at)
}

// ====== Date Type Checks ======

/** Check if a date string represents a weekly period (e.g. "2026-W03"). */
fun isWeekDate(dateStr: String?): Boolean =
    dateStr != null && dateStr.contains("-W")

/** Check if a date string represents a monthly period (e.g. "2026-06"). */
private const val MONTH_DATE_LENGTH = 7 // "YYYY-MM"

fun isMonthDate(dateStr: String?): Boolean =
    dateStr != null && dateStr.length == MONTH_DATE_LENGTH && !dateStr.contains("-W")

// ====== Todo Extension Functions ======

/**
 * Check if a todo is overdue.
 * A todo is overdue when its specific date (not week/month) is before today and it's not completed.
 */
fun Todo.isOverdue(todayStr: String): Boolean {
    val d = date ?: return false
    if (completed) return false
    // Exclude week and month tasks — they don't have a specific due date
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
    val ca = completed_at ?: return null
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
    val dateStr = this.date ?: return 0
    if (!isWeekDate(dateStr)) return 0
    return this.completed_dates.count { dStr ->
        try {
            val checkDate = LocalDate.parse(dStr)
            weekStringOf(checkDate) == dateStr
        } catch (e: Exception) { false }
    }
}

fun Todo.getMonthlyCompletedCount(): Int {
    val dateStr = this.date ?: return 0
    if (!isMonthDate(dateStr)) return 0
    return this.completed_dates.count { it.startsWith(dateStr) }
}

/**
 * Toggle a checkin date and return an updated Todo with recalculated completion status.
 * Handles: add/remove date, sort, compute completed count, check target.
 */
fun Todo.withToggledCheckinDate(dateStr: String): Todo {
    val dates = completed_dates.toMutableList()
    if (dates.contains(dateStr)) dates.remove(dateStr) else dates.add(dateStr)
    dates.sort()
    val tempTodo = copy(completed_dates = dates)
    val completedCount = when (task_type) {
        TaskType.WEEKLY_CHECKIN -> tempTodo.getWeeklyCompletedCount()
        TaskType.MONTHLY_CHECKIN -> tempTodo.getMonthlyCompletedCount()
        else -> dates.size
    }
    val isCompletedNow = target_count != null && completedCount >= target_count!!
    return copy(
        completed_dates = dates,
        completed = isCompletedNow,
        completed_at = if (isCompletedNow) (completed_at ?: nowIso()) else null,
        updated_at = nowIso()
    )
}

// ====== Date Strings Helper ======

/**
 * Precomputed date strings for the current day, used for filtering and display.
 */
data class DateStrings(
    val today: String,
    val tomorrow: String,
    val thisWeek: String,
    val thisMonth: String
) {
    companion object {
        fun now(): DateStrings {
            val today = LocalDate.now()
            return DateStrings(
                today = today.toString(),
                tomorrow = today.plusDays(1).toString(),
                thisWeek = weekStringOf(today),
                thisMonth = monthStringOf(today)
            )
        }
    }
}

// ====== Input Parsing ======

private val DATE_REGEX = Regex("""(?:\s+|^)@(today|tomorrow|week|month|day|daily|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:[*/:](\d*))?$""", RegexOption.IGNORE_CASE)
private val FULL_DATE_REGEX = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val SHORT_DATE_REGEX = Regex("""^\d{2}-\d{2}$""")

data class ParsedSyntax(
    val content: String,
    val date: String?,
    val taskType: String = "normal",
    val targetCount: Int? = null
)

/**
 * Parse @date syntax from raw input text.
 * Supports: @today, @tomorrow, @week, @month, @YYYY-MM-DD, @MM-DD
 * Returns a ParsedSyntax object.
 */
fun parseDateSyntax(rawContent: String): ParsedSyntax {
    var content = rawContent.trim()
    var taskDate: String? = null
    var taskType = "normal"
    var targetCount: Int? = null

    val dateMatch = DATE_REGEX.find(content)
    if (dateMatch != null) {
        val dateVal = dateMatch.groupValues[1].lowercase()
        taskDate = when (dateVal) {
            "today" -> LocalDate.now().toString()
            "tomorrow" -> LocalDate.now().plusDays(1).toString()
            "day", "daily" -> {
                taskType = "daily_repeat"
                LocalDate.now().toString()
            }
            "week" -> {
                taskType = "weekly_checkin"
                targetCount = dateMatch.groupValues.getOrNull(2)?.toIntOrNull()
                weekStringOf(LocalDate.now())
            }
            "month" -> {
                taskType = "monthly_checkin"
                targetCount = dateMatch.groupValues.getOrNull(2)?.toIntOrNull()
                monthStringOf(LocalDate.now())
            }
            else -> when {
                FULL_DATE_REGEX.matches(dateVal) -> dateVal
                SHORT_DATE_REGEX.matches(dateVal) -> "${LocalDate.now().year}-$dateVal"
                else -> null
            }
        }
        content = content.removeRange(dateMatch.range).trim()
    }

    return ParsedSyntax(content, taskDate, taskType, targetCount)
}

// ====== Todo Grouping ======

/**
 * Group todos by date category for the "all tasks" view.
 */
data class TodoDateGroups(
    val today: List<Todo>,
    val noDate: List<Todo>,
    val week: List<Todo>,
    val month: List<Todo>,
    val future: List<Todo>,
    val past: List<Todo>
)

fun groupTodosByDate(todos: List<Todo>, todayStr: String): TodoDateGroups {
    val parsedToday = try {
        LocalDate.parse(todayStr)
    } catch (e: Exception) {
        LocalDate.now()
    }
    val thisWeekStr = weekStringOf(parsedToday)
    val thisMonthStr = monthStringOf(parsedToday)

    val todayGroup = mutableListOf<Todo>()
    val noDateGroup = mutableListOf<Todo>()
    val weekGroup = mutableListOf<Todo>()
    val monthGroup = mutableListOf<Todo>()
    val futureGroup = mutableListOf<Todo>()
    val pastGroup = mutableListOf<Todo>()

    todos.forEach { todo ->
        val d = todo.date
        when {
            todo.task_type == "weekly_checkin" || isWeekDate(d) -> {
                val weekVal = d ?: thisWeekStr
                when {
                    weekVal == thisWeekStr -> weekGroup.add(todo)
                    weekVal < thisWeekStr -> pastGroup.add(todo)
                    else -> futureGroup.add(todo)
                }
            }
            todo.task_type == "monthly_checkin" || isMonthDate(d) -> {
                val monthVal = d ?: thisMonthStr
                when {
                    monthVal == thisMonthStr -> monthGroup.add(todo)
                    monthVal < thisMonthStr -> pastGroup.add(todo)
                    else -> futureGroup.add(todo)
                }
            }
            d.isNullOrEmpty() -> noDateGroup.add(todo)
            d == todayStr -> todayGroup.add(todo)
            d > todayStr -> futureGroup.add(todo)
            else -> pastGroup.add(todo)
        }
    }

    return TodoDateGroups(todayGroup, noDateGroup, weekGroup, monthGroup, futureGroup, pastGroup)
}

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

// ====== Today Focus Classification ======

/**
 * Pre-classified groups for the "today focus" view.
 * Used by both ListView and TodoWidget to avoid duplicating filter/classify logic.
 */
data class FocusGroups(
    val todayTasks: List<Todo>,
    val noDateTasks: List<Todo>,
    val weekTasks: List<Todo>,
    val monthTasks: List<Todo>
)

/**
 * Filter and classify todos into today-focus groups.
 * Shared between ListView and TodoWidget to ensure consistent behavior.
 */
fun classifyForTodayFocus(todos: List<Todo>, todayStr: String, thisWeekStr: String, thisMonthStr: String): FocusGroups {
    val filtered = todos.filter { t ->
        !t.deleted && (
            t.date == todayStr
            || t.isOverdue(todayStr)
            || t.date == thisWeekStr
            || t.date == thisMonthStr
            || (t.completed && t.completed_at?.startsWith(todayStr) == true)
        )
    }
    return FocusGroups(
        todayTasks = filtered.filter {
            it.task_type != TaskType.WEEKLY_CHECKIN && it.task_type != TaskType.MONTHLY_CHECKIN
                && it.date != null && !isWeekDate(it.date ?: "") && !isMonthDate(it.date ?: "")
        }.sortedWith(TodoComparator),
        noDateTasks = emptyList(),
        weekTasks = filtered.filter {
            it.task_type == TaskType.WEEKLY_CHECKIN || isWeekDate(it.date ?: "")
        }.sortedWith(TodoComparator),
        monthTasks = filtered.filter {
            it.task_type == TaskType.MONTHLY_CHECKIN || isMonthDate(it.date ?: "")
        }.sortedWith(TodoComparator)
    )
}

