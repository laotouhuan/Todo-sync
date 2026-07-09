package com.todo.app.data.model

import java.time.LocalDate

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
            todo.taskType == TaskType.WEEKLY_CHECKIN || isWeekDate(d) -> {
                val weekVal = d ?: thisWeekStr
                when {
                    weekVal == thisWeekStr -> weekGroup.add(todo)
                    weekVal < thisWeekStr -> pastGroup.add(todo)
                    else -> futureGroup.add(todo)
                }
            }
            todo.taskType == TaskType.MONTHLY_CHECKIN || isMonthDate(d) -> {
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
            || (t.completed && t.completedAt?.startsWith(todayStr) == true)
        )
    }
    return FocusGroups(
        todayTasks = filtered.filter {
            it.taskType != TaskType.WEEKLY_CHECKIN && it.taskType != TaskType.MONTHLY_CHECKIN
                && it.date != null && !isWeekDate(it.date ?: "") && !isMonthDate(it.date ?: "")
        }.sortedWith(TodoComparator),
        noDateTasks = emptyList(),
        weekTasks = filtered.filter {
            it.taskType == TaskType.WEEKLY_CHECKIN || isWeekDate(it.date ?: "")
        }.sortedWith(TodoComparator),
        monthTasks = filtered.filter {
            it.taskType == TaskType.MONTHLY_CHECKIN || isMonthDate(it.date ?: "")
        }.sortedWith(TodoComparator)
    )
}

// ====== Time-Based Grouping ======

/**
 * Group a list of todos by their time slot (morning/afternoon/evening/night).
 * Todos without a time are placed in "unknown".
 */
fun groupByTime(todos: List<Todo>): Map<String, List<Todo>> {
    return todos.groupBy { categorizeTimeSlot(it.completedAt) }
}
