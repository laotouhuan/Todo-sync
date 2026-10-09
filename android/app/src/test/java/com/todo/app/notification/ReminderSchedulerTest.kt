package com.todo.app.notification

import com.todo.app.data.model.*
import org.junit.Assert.*
import org.junit.Test

class ReminderSchedulerTest {
    private val day = 24 * 60 * 60 * 1000L
    private val trigger = 100000L

    @Test fun dailyReminderReschedulesForAllTypesAndLegacyMarkers() {
        for (type in listOf(TaskType.NORMAL, TaskType.WEEKLY_CHECKIN, TaskType.MONTHLY_CHECKIN)) {
            for (marker in listOf(RecurringType.NONE, RecurringType.DAILY_REPEAT)) {
                val task = Todo.create("任务").copy(taskType = type, recurring = marker, reminder = Reminder(reminderTime = "09:00", repeatDaily = true))
                assertEquals(trigger, taskReminderTrigger(task, trigger - 1, trigger))
                assertEquals(trigger + day, taskReminderTrigger(task, trigger, trigger))
                assertEquals(trigger + day * 2, taskReminderTrigger(task, trigger + day, trigger + day))
                // 完成任务仍按原规则排到明日，由接收器抑制通知；删除任务不调度。
                assertEquals(trigger + day, taskReminderTrigger(task.copy(completed = true), trigger - 1, trigger))
                assertNull(taskReminderTrigger(task.copy(deleted = true), trigger - 1, trigger))
            }
        }
    }

    @Test fun disablingDailyReminderKeepsSingleReminderRules() {
        val task = Todo.create("旧任务").copy(recurring = RecurringType.DAILY_REPEAT, reminder = Reminder(reminderTime = "09:00"))
        assertEquals(trigger, taskReminderTrigger(task, trigger - 1, trigger))
        assertNull(taskReminderTrigger(task, trigger, trigger))
        assertNull(taskReminderTrigger(task.copy(completed = true), trigger - 1, trigger))
        assertNull(taskReminderTrigger(task.copy(deleted = true), trigger - 1, trigger))
        assertNull(taskReminderTrigger(task.copy(reminder = null), trigger - 1, trigger))
    }
}
