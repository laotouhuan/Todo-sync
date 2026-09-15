package com.todo.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

class ReminderRuleEvaluatorTest {

    private val targetDate = LocalDate.of(2026, 9, 6)
    private val zone = ZoneId.of("Asia/Shanghai")
    private val noonRule = GlobalReminderRule(
        id = "noon", time = "12:00", condition = "none_completed", taskScope = "all"
    )

    private fun todo(
        id: String,
        date: String? = null,
        completed: Boolean = false,
        completedAt: String? = if (completed) "2026-09-06T08:30:00+08:00" else null,
        deleted: Boolean = false,
        recurring: String = RecurringType.NONE,
        taskType: String = TaskType.NORMAL,
        completedDates: List<String> = emptyList()
    ) = Todo(
        id = id,
        content = id,
        date = date,
        completed = completed,
        completedAt = completedAt,
        createdAt = "2026-09-01T00:00:00Z",
        updatedAt = "2026-09-01T00:00:00Z",
        deleted = deleted,
        recurring = recurring,
        taskType = taskType,
        completedDates = completedDates
    )

    @Test
    fun todayScopeOnlyIncludesTodayAndOverdueNormalTasks() {
        val rule = GlobalReminderRule("rule", time = "09:00", taskScope = "today_only")
        val result = evaluateReminderRule(
            rule,
            listOf(
                todo("today", date = "2026-09-06", completed = true),
                todo("overdue", date = "2026-09-05"),
                todo("future", date = "2026-09-07"),
                todo("daily", date = "2026-09-06", recurring = RecurringType.DAILY_REPEAT),
                todo("deleted", date = "2026-09-06", deleted = true)
            ),
            targetDate, zone
        )

        assertEquals(2, result.totalCount)
        assertEquals(1, result.completedCount)
        assertEquals(1, result.remainingCount)
        assertEquals(1, result.overdueCount)
    }

    @Test
    fun recurringScopeUsesTodayCheckinState() {
        val rule = GlobalReminderRule(
            id = "rule",
            time = "09:00",
            condition = "any_remaining",
            taskScope = "recurring_only"
        )
        val result = evaluateReminderRule(
            rule,
            listOf(
                todo("daily", date = "2026-09-01", recurring = RecurringType.DAILY_REPEAT),
                todo(
                    "weekly",
                    date = weekStringOf(targetDate),
                    taskType = TaskType.WEEKLY_CHECKIN,
                    completedDates = listOf("2026-09-06T08:30:00Z")
                ),
                todo("old-month", date = "2026-08", taskType = TaskType.MONTHLY_CHECKIN)
            ),
            targetDate, zone
        )

        assertEquals(2, result.totalCount)
        assertEquals(1, result.completedCount)
        assertEquals(1, result.remainingCount)
        assertEquals(0, result.overdueCount)
        assertTrue(result.shouldTrigger)
    }

    @Test
    fun conditionEvaluationMatchesCounts() {
        val completedTodo = todo("done", date = "2026-09-06", completed = true)
        val noneCompleted = GlobalReminderRule(
            id = "none",
            time = "09:00",
            condition = "none_completed",
            taskScope = "today_only"
        )
        val anyRemaining = noneCompleted.copy(id = "remaining", condition = "any_remaining")

        assertFalse(evaluateReminderRule(noneCompleted, listOf(completedTodo), targetDate, zone).shouldTrigger)
        assertFalse(evaluateReminderRule(anyRemaining, listOf(completedTodo), targetDate, zone).shouldTrigger)
        assertTrue(evaluateReminderRule(noneCompleted, emptyList(), targetDate, zone).shouldTrigger)
    }

    @Test
    fun monthlyMorningCheckinSuppressesNoonReminderBeforeMonthlyTargetIsReached() {
        for (record in listOf("2026-09-05T23:30:00Z", "2026-09-06T07:30:00+08:00", "2026-09-06")) {
            val monthly = todo("monthly", date = "2026-09", taskType = TaskType.MONTHLY_CHECKIN,
                completedDates = listOf(record)).copy(targetCount = 20)
            val result = evaluateReminderRule(noonRule, listOf(monthly), targetDate, zone)
            assertFalse(record, result.shouldTrigger)
            assertEquals(1, result.completedCount)
            assertEquals(0, result.remainingCount)
            assertEquals(100, result.completionRate)
        }
    }

    @Test
    fun completionDatesRespectLocalMidnightAndRejectInvalidRecords() {
        val monthly = todo("monthly", taskType = TaskType.MONTHLY_CHECKIN)
        for ((record, expected) in listOf(
            "2026-09-05T15:59:59Z" to false,
            "2026-09-05T16:00:00Z" to true,
            "2026-09-06T15:59:59Z" to true,
            "2026-09-06T16:00:00Z" to false,
            "2026-09-06T07:30:00" to true,
            "2026-09-06-invalid" to false,
            "" to false
        )) {
            assertEquals(record, expected,
                monthly.copy(completedDates = listOf(record)).hasCompletionOn(targetDate, zone))
        }
        assertFalse(monthly.copy(completedDates = listOf("2026-09-06T06:30:00Z"))
            .hasCompletionOn(targetDate, ZoneId.of("America/Los_Angeles")))
    }

    @Test
    fun yesterdayReachedTargetDoesNotCountAsTodayButIsNotPending() {
        val monthly = todo("monthly", date = "2026-09", taskType = TaskType.MONTHLY_CHECKIN,
            completed = true, completedAt = "2026-09-05T08:30:00+08:00",
            completedDates = listOf("2026-09-05T08:30:00+08:00"))
        val result = evaluateReminderRule(noonRule, listOf(monthly), targetDate, zone)
        assertTrue(result.shouldTrigger)
        assertEquals(0, result.completedCount)
        assertEquals(0, result.remainingCount)
        assertFalse(evaluateReminderRule(noonRule.copy(condition = "any_remaining"),
            listOf(monthly), targetDate, zone).shouldTrigger)
        // 整月达标时间不能代替实际打卡记录。
        assertFalse(monthly.copy(completedAt = "2026-09-06T08:30:00+08:00")
            .hasCompletionOn(targetDate, zone))
    }

    @Test
    fun actualCompletionsCountRegardlessOfDueDateOrCheckinPeriodForAllScope() {
        for (item in listOf(
            todo("overdue", date = "2026-09-01", completed = true),
            todo("undated", completed = true),
            todo("future", date = "2026-09-07", completed = true),
            todo("daily", date = "2026-09-05", completed = true, recurring = RecurringType.DAILY_REPEAT),
            todo("monthly", date = "2026-08", taskType = TaskType.MONTHLY_CHECKIN,
                completedDates = listOf("2026-09-06"))
        )) {
            assertFalse(item.id, evaluateReminderRule(noonRule, listOf(item), targetDate, zone).shouldTrigger)
        }
    }

    @Test
    fun scopesFilterCompletionRecordsAndOverdueCompletionDoesNotDisappear() {
        val items = listOf(
            todo("overdue", date = "2026-09-01", completed = true),
            todo("undated", completed = true),
            todo("future", date = "2026-09-07", completed = true),
            todo("monthly", date = "2026-09", taskType = TaskType.MONTHLY_CHECKIN,
                completedDates = listOf("2026-09-06", "2026-09-06T08:00:00+08:00")),
            todo("pending", date = "2026-09-05"),
            todo("deleted", date = "2026-09-06", completed = true, deleted = true)
        )
        val all = evaluateReminderRule(noonRule, items, targetDate, zone)
        assertEquals(4, all.completedCount)
        assertEquals(1, all.remainingCount)
        assertEquals(5, all.totalCount)
        assertEquals(80, all.completionRate)
        val today = evaluateReminderRule(noonRule.copy(taskScope = "today_only"), items, targetDate, zone)
        assertEquals(1, today.completedCount)
        assertEquals(1, today.overdueCount)
        val recurring = evaluateReminderRule(noonRule.copy(taskScope = "recurring_only"), items, targetDate, zone)
        assertEquals(1, recurring.completedCount)
        assertEquals(0, recurring.overdueCount)
    }

    @Test
    fun missingOldUndoneAndDeletedCompletionsDoNotSuppressNoonReminder() {
        for (item in listOf(
            todo("missing", date = "2026-09-06", completed = true, completedAt = null),
            todo("old", date = "2026-09-06", completed = true, completedAt = "2026-09-05T08:00:00+08:00"),
            todo("undone", date = "2026-09-06", completedAt = "2026-09-06T08:00:00+08:00"),
            todo("deleted", date = "2026-09-06", completed = true, deleted = true)
        )) {
            assertTrue(item.id, evaluateReminderRule(noonRule, listOf(item), targetDate, zone).shouldTrigger)
        }
    }

    @Test
    fun templateRendererUsesOneSetOfAliases() {
        val evaluation = ReminderRuleEvaluation(
            shouldTrigger = true,
            remainingCount = 2,
            completedCount = 3,
            totalCount = 5,
            overdueCount = 1,
            completionRate = 60,
            date = targetDate
        )

        val rendered = renderReminderTemplate(
            "{date}/{today_date} {time}/{now_time} {weekday} 剩{remaining_count} 完{completed_count} 共{total_count} 逾{overdue_count} {completion_rate}",
            evaluation,
            LocalTime.of(8, 5)
        )

        assertEquals("09月06日/09月06日 08:05/08:05 周日 剩2 完3 共5 逾1 60%", rendered)
    }
}
