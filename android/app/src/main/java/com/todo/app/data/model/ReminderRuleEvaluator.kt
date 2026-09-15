package com.todo.app.data.model

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

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

/** 完成记录先转换为设备本地日期；兼容旧版纯日期和不带时区的本地时间。 */
private fun completionDate(value: String?, zone: ZoneId): LocalDate? {
    if (value.isNullOrBlank()) return null
    return try {
        if (value.length == 10) LocalDate.parse(value)
        else OffsetDateTime.parse(value).atZoneSameInstant(zone).toLocalDate()
    } catch (_: DateTimeParseException) {
        try {
            LocalDateTime.parse(value).toLocalDate()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/** 当天实际完成过：打卡看每次记录，普通/每日任务看完成时间，不用截止日期代替。 */
fun Todo.hasCompletionOn(date: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Boolean =
    if (taskType == TaskType.WEEKLY_CHECKIN || taskType == TaskType.MONTHLY_CHECKIN) {
        completedDates.any { completionDate(it, zone) == date }
    } else {
        completed && completionDate(completedAt, zone) == date
    }

/** 已完成或已达标的任务不再算待办；未达标的打卡任务当天打过卡也不再催。 */
fun Todo.isCompletedOn(date: LocalDate, zone: ZoneId = ZoneId.systemDefault()): Boolean =
    completed || hasCompletionOn(date, zone)

/**
 * 计算全局提醒规则。日期和时区可注入，不依赖 Android Context，供预览、通知和测试复用。
 * 已完成数按当天实际记录统计；剩余数仍按今日/逾期和当前周期的待办统计。
 */
fun evaluateReminderRule(
    rule: GlobalReminderRule,
    todos: List<Todo>,
    date: LocalDate = LocalDate.now(),
    zone: ZoneId = ZoneId.systemDefault()
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

    val completedCount = activeTodos.count { todo ->
        val matchesScope = when (rule.taskScope) {
            // 这里不能用 isOverdue：任务完成后该函数恒为 false，会漏掉今天完成的逾期任务。
            "today_only" -> !todo.isCheckinOrRecurring() &&
                todo.date?.let { it.length == 10 && it <= dateStr } == true
            "recurring_only" -> todo.isCheckinOrRecurring()
            else -> true
        }
        matchesScope && todo.hasCompletionOn(date, zone)
    }
    val remainingTodos = scopedTodos.filterNot { it.isCompletedOn(date, zone) }
    val remainingCount = remainingTodos.size
    val totalCount = completedCount + remainingCount
    val overdueCount = if (rule.taskScope == "recurring_only") {
        0
    } else {
        remainingTodos.count { it.isOverdue(dateStr) }
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
