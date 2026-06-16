package com.todo.app.data.model

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.WeekFields
import java.util.Locale

/**
 * Centralized date utility functions for Todo-related date operations.
 * Eliminates duplicated date logic across ListView, StatsView, and ViewModel.
 */

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
fun isMonthDate(dateStr: String?): Boolean =
    dateStr != null && dateStr.length == 7 && !dateStr.contains("-W")

// ====== Todo Extension Functions ======

/**
 * Check if a todo is overdue.
 * A todo is overdue when its specific date (not week/month) is before today and it's not completed.
 */
fun Todo.isOverdue(todayStr: String): Boolean {
    if (date == null || completed) return false
    // Exclude week and month tasks — they don't have a specific due date
    if (isWeekDate(date) || isMonthDate(date)) return false
    return date!! < todayStr
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
        else -> d.substring(5) // show MM-DD
    }
}

/**
 * Get completion status label relative to due date.
 * Returns null if not applicable, or one of: '逾期完成', '提前完成', '按时完成'
 */
fun Todo.getCompletionStatusLabel(): String? {
    if (!completed || completed_at == null || date == null || isWeekDate(date) || isMonthDate(date)) return null
    val completedDateStr = completed_at!!.substring(0, 10)
    return when {
        completedDateStr > date!! -> "逾期完成"
        completedDateStr < date!! -> "提前完成"
        else -> "按时完成"
    }
}

// ====== Date Formatting Helpers ======

/** Format a LocalDate as ISO week string (e.g. "2026-W03"). */
fun weekStringOf(date: LocalDate): String {
    val week = date.get(WeekFields.of(Locale.getDefault()).weekOfYear())
    return "${date.year}-W${week.toString().padStart(2, '0')}"
}

/** Format a LocalDate as month string (e.g. "2026-06"). */
fun monthStringOf(date: LocalDate): String =
    "${date.year}-${date.monthValue.toString().padStart(2, '0')}"

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

private val DATE_REGEX = Regex("""(?:\s+|^)@(today|tomorrow|week|month|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$""", RegexOption.IGNORE_CASE)
private val FULL_DATE_REGEX = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val SHORT_DATE_REGEX = Regex("""^\d{2}-\d{2}$""")

/**
 * Parse @date syntax from raw input text.
 * Supports: @today, @tomorrow, @week, @month, @YYYY-MM-DD, @MM-DD
 * Returns a Pair of (cleaned content, parsed date string or null).
 */
fun parseDateSyntax(rawContent: String): Pair<String, String?> {
    var content = rawContent.trim()
    var taskDate: String? = null

    val dateMatch = DATE_REGEX.find(content)
    if (dateMatch != null) {
        val dateVal = dateMatch.groupValues[1].lowercase()
        taskDate = when (dateVal) {
            "today" -> LocalDate.now().toString()
            "tomorrow" -> LocalDate.now().plusDays(1).toString()
            "week" -> weekStringOf(LocalDate.now())
            "month" -> monthStringOf(LocalDate.now())
            else -> when {
                FULL_DATE_REGEX.matches(dateVal) -> dateVal
                SHORT_DATE_REGEX.matches(dateVal) -> "${LocalDate.now().year}-$dateVal"
                else -> null
            }
        }
        content = content.removeRange(dateMatch.range).trim()
    }

    return content to taskDate
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
    val todayGroup = mutableListOf<Todo>()
    val noDateGroup = mutableListOf<Todo>()
    val weekGroup = mutableListOf<Todo>()
    val monthGroup = mutableListOf<Todo>()
    val futureGroup = mutableListOf<Todo>()
    val pastGroup = mutableListOf<Todo>()

    todos.forEach { todo ->
        val d = todo.date
        when {
            d.isNullOrEmpty() -> noDateGroup.add(todo)
            d == todayStr -> todayGroup.add(todo)
            isWeekDate(d) -> weekGroup.add(todo)
            isMonthDate(d) -> monthGroup.add(todo)
            d > todayStr -> futureGroup.add(todo)
            else -> pastGroup.add(todo)
        }
    }

    return TodoDateGroups(todayGroup, noDateGroup, weekGroup, monthGroup, futureGroup, pastGroup)
}
