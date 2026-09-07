package com.todo.app.data.model

import java.time.LocalDate
import java.time.LocalTime

/** 全局提醒规则的纯计算结果，供设置页预览和通知执行共同使用。 */
data class ReminderRuleEvaluation(
    val shouldTrigger: Boolean,
    val remainingCount: Int,
    val completedCount: Int,
    val totalCount: Int,
    val overdueCount: Int,
    val completionRate: Int,
    val date: LocalDate
)

/** 判断任务是否属于提醒规则中的循环/打卡任务。 */
fun Todo.isCheckinOrRecurring(): Boolean =
    recurring == RecurringType.DAILY_REPEAT ||
        taskType == TaskType.WEEKLY_CHECKIN ||
        taskType == TaskType.MONTHLY_CHECKIN

/** 判断循环或打卡任务是否属于指定日期。 */
fun Todo.isRecurringFor(date: LocalDate): Boolean {
    val dateStr = date.toString()
    return when {
        recurring == RecurringType.DAILY_REPEAT -> {
            this.date == null || this.date == dateStr || (!completed && this.date!! < dateStr)
        }
        taskType == TaskType.WEEKLY_CHECKIN -> this.date == null || this.date == weekStringOf(date)
        taskType == TaskType.MONTHLY_CHECKIN -> this.date == null || this.date == monthStringOf(date)
        else -> false
    }
}

/** 判断任务在指定日期是否应视为已完成。 */
fun Todo.isCompletedOn(date: LocalDate): Boolean =
    completed || (
        (taskType == TaskType.WEEKLY_CHECKIN || taskType == TaskType.MONTHLY_CHECKIN) &&
            completedDates.any { it.startsWith(date.toString()) }
        )

/**
 * 计算全局提醒规则。此函数不读取系统时间，也不依赖 Android Context，便于预览、通知和测试复用。
 */
fun evaluateReminderRule(
    rule: GlobalReminderRule,
    todos: List<Todo>,
    date: LocalDate = LocalDate.now()
): ReminderRuleEvaluation {
    val dateStr = date.toString()
    val activeTodos = todos.filterNot { it.deleted }
    val scopedTodos = activeTodos.filter { todo ->
        val isTodayNormalTask = !todo.isCheckinOrRecurring() &&
            (todo.date == dateStr || todo.isOverdue(dateStr))
        when (rule.taskScope) {
            "today_only" -> isTodayNormalTask
            "recurring_only" -> todo.isRecurringFor(date)
            else -> isTodayNormalTask || todo.isRecurringFor(date)
        }
    }

    val completedCount = scopedTodos.count { it.isCompletedOn(date) }
    val totalCount = scopedTodos.size
    val remainingCount = totalCount - completedCount
    val overdueCount = if (rule.taskScope == "recurring_only") {
        0
    } else {
        scopedTodos.count { it.isOverdue(dateStr) }
    }
    val completionRate = if (totalCount == 0) {
        0
    } else {
        Math.round(completedCount.toDouble() / totalCount * 100).toInt()
    }
    val shouldTrigger = when (rule.condition) {
        "none_completed" -> completedCount == 0
        "any_remaining" -> remainingCount > 0
        "unconditional" -> true
        else -> false
    }

    return ReminderRuleEvaluation(
        shouldTrigger = shouldTrigger,
        remainingCount = remainingCount,
        completedCount = completedCount,
        totalCount = totalCount,
        overdueCount = overdueCount,
        completionRate = completionRate,
        date = date
    )
}

/** 使用提醒规则计算结果替换通知模板变量。 */
fun renderReminderTemplate(
    template: String,
    evaluation: ReminderRuleEvaluation,
    time: LocalTime = LocalTime.now()
): String {
    val timeText = String.format("%02d:%02d", time.hour, time.minute)
    val date = evaluation.date
    val dateText = String.format("%02d月%02d日", date.monthValue, date.dayOfMonth)
    val weekdays = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
    val weekdayText = weekdays[date.dayOfWeek.value % 7]

    return template
        .replace("{remaining_count}", evaluation.remainingCount.toString())
        .replace("{completed_count}", evaluation.completedCount.toString())
        .replace("{total_count}", evaluation.totalCount.toString())
        .replace("{overdue_count}", evaluation.overdueCount.toString())
        .replace("{completion_rate}", "${evaluation.completionRate}%")
        .replace("{time}", timeText)
        .replace("{now_time}", timeText)
        .replace("{date}", dateText)
        .replace("{today_date}", dateText)
        .replace("{weekday}", weekdayText)
}
