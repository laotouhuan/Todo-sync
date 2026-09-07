package com.todo.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime

class ReminderRuleEvaluatorTest {

    private val targetDate = LocalDate.of(2026, 9, 6)

    private fun todo(
        id: String,
        date: String? = null,
        completed: Boolean = false,
        deleted: Boolean = false,
        recurring: String = RecurringType.NONE,
        taskType: String = TaskType.NORMAL,
        completedDates: List<String> = emptyList()
    ) = Todo(
        id = id,
        content = id,
        date = date,
        completed = completed,
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
            targetDate
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
            targetDate
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

        assertFalse(evaluateReminderRule(noneCompleted, listOf(completedTodo), targetDate).shouldTrigger)
        assertFalse(evaluateReminderRule(anyRemaining, listOf(completedTodo), targetDate).shouldTrigger)
        assertTrue(evaluateReminderRule(noneCompleted, emptyList(), targetDate).shouldTrigger)
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
