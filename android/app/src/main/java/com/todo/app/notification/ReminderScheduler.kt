package com.todo.app.notification

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.todo.app.data.model.RecurringType
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.TodoData
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

class ReminderScheduler(private val context: Context) {

    companion object {
        private const val ONE_DAY_MS = 24 * 60 * 60 * 1000L
    }

    private val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    fun rescheduleAll(todoData: TodoData) {
        if (!todoData.reminderSettings.enabled) {
            return
        }

        val now = System.currentTimeMillis()
        val todayStr = LocalDate.now().toString()

        // 1. 单项任务提醒
        todoData.todos
            .filter { !it.deleted && it.reminder != null }
            .forEach { todo ->
                val reminder = todo.reminder!!
                val isRecurring = todo.recurring == RecurringType.DAILY_REPEAT ||
                                  todo.taskType == TaskType.WEEKLY_CHECKIN ||
                                  todo.taskType == TaskType.MONTHLY_CHECKIN

                if (isRecurring && reminder.repeatDaily) {
                    val triggerMs = parseTodayTimeToMillis(reminder.reminderTime)
                    val finalTriggerMs = if (triggerMs <= now || todo.completed) {
                        triggerMs + ONE_DAY_MS
                    } else {
                        triggerMs
                    }
                    scheduleExact(makeTaskRequestCode(todo.id), finalTriggerMs, todo.id, "task")
                } else if (!todo.completed) {
                    val rDate = reminder.reminderDate ?: todo.date ?: todayStr
                    val triggerMs = parseToMillis(rDate, reminder.reminderTime)
                    if (triggerMs > now) {
                        scheduleExact(makeTaskRequestCode(todo.id), triggerMs, todo.id, "task")
                    }
                }
            }

        // 2. 全局规则
        todoData.reminderSettings.globalRules
            .filter { it.enabled }
            .forEach { rule ->
                val triggerMs = parseTodayTimeToMillis(rule.time)
                val finalTriggerMs = if (triggerMs <= now) {
                    triggerMs + ONE_DAY_MS
                } else {
                    triggerMs
                }
                scheduleExact(makeGlobalRequestCode(rule.id), finalTriggerMs, rule.id, "global")
            }
    }

    private fun scheduleExact(requestCode: Int, triggerMs: Long, targetId: String, type: String) {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra("target_id", targetId)
            putExtra("type", type)
        }
        val pi = PendingIntent.getBroadcast(
            context, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (alarmManager.canScheduleExactAlarms()) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi)
            } else {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi)
            }
        } else {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi)
        }
    }

    private fun makeTaskRequestCode(todoId: String): Int = "task_$todoId".hashCode()
    private fun makeGlobalRequestCode(ruleId: String): Int = "global_$ruleId".hashCode()

    private fun parseTodayTimeToMillis(timeStr: String): Long {
        val today = LocalDate.now()
        return parseToMillis(today.toString(), timeStr)
    }

    private fun parseToMillis(dateStr: String, timeStr: String): Long {
        return try {
            val parts = timeStr.split(":")
            val hh = parts[0].toInt()
            val mm = parts[1].toInt()
            val ldt = if (dateStr.length == 10) {
                val dParts = dateStr.split("-")
                LocalDateTime.of(dParts[0].toInt(), dParts[1].toInt(), dParts[2].toInt(), hh, mm)
            } else {
                LocalDateTime.of(LocalDate.now(), java.time.LocalTime.of(hh, mm))
            }
            ldt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        } catch (_: Exception) {
            System.currentTimeMillis() + 60000L
        }
    }
}
