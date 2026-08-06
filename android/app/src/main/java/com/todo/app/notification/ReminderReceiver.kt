package com.todo.app.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.todo.app.TodoApplication
import com.todo.app.data.model.RecurringType
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import java.time.LocalDate

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val targetId = intent.getStringExtra("target_id") ?: return
        val type = intent.getStringExtra("type") ?: return

        val app = context.applicationContext as? TodoApplication ?: return
        val repo = app.repository
        val todoData = repo.getCurrentData()

        if (!todoData.reminderSettings.enabled) {
            return
        }

        when (type) {
            "task" -> handleTaskReminder(context, todoData, targetId)
            "global" -> handleGlobalReminder(context, todoData, targetId)
        }

        // 触发后重新调度以更新下个周期
        ReminderScheduler(context).rescheduleAll(todoData)
    }

    private fun handleTaskReminder(context: Context, todoData: TodoData, todoId: String) {
        val todo = todoData.todos.find { it.id == todoId } ?: return
        if (todo.completed || todo.deleted) return

        val notification = NotificationHelper.buildTaskNotification(
            context, todo, todoData.reminderSettings.privacyMode
        )
        val requestCode = "task_$todoId".hashCode()
        try {
            NotificationManagerCompat.from(context).notify(requestCode, notification)
        } catch (_: SecurityException) {}
    }

    private fun handleGlobalReminder(context: Context, todoData: TodoData, ruleId: String) {
        val rule = todoData.reminderSettings.globalRules.find { it.id == ruleId } ?: return
        if (!rule.enabled) return

        val todayStr = LocalDate.now().toString()
        val todayTodos = todoData.todos.filter { !it.deleted && (it.date == todayStr || isCheckinTask(it)) }
        val scopedTodos = filterByScope(todayTodos, rule.taskScope)

        val shouldTrigger = when (rule.condition) {
            "none_completed" -> scopedTodos.none { it.completed }
            "any_remaining" -> scopedTodos.any { !it.completed }
            "unconditional" -> true
            else -> false
        }

        if (!shouldTrigger) return

        val remainingCount = scopedTodos.count { !it.completed }
        val completedCount = scopedTodos.count { it.completed }
        val totalCount = scopedTodos.size
        val overdueCount = scopedTodos.count { !it.completed && (it.date?.let { d -> d < todayStr } == true) }
        val rateVal = if (totalCount > 0) Math.round((completedCount.toDouble() / totalCount) * 100).toInt() else 0

        val now = java.time.LocalTime.now()
        val nowTimeStr = String.format("%02d:%02d", now.hour, now.minute)

        val todayDate = java.time.LocalDate.now()
        val todayDateStr = String.format("%02d月%02d日", todayDate.monthValue, todayDate.dayOfMonth)
        val weekdays = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
        val weekdayStr = weekdays[todayDate.dayOfWeek.value % 7]

        val resolvedBody = rule.body
            .replace("{time}", rule.time)
            .replace("{now_time}", nowTimeStr)
            .replace("{remaining_count}", remainingCount.toString())
            .replace("{completed_count}", completedCount.toString())
            .replace("{total_count}", totalCount.toString())
            .replace("{overdue_count}", overdueCount.toString())
            .replace("{completion_rate}", "$rateVal%")
            .replace("{today_date}", todayDateStr)
            .replace("{weekday}", weekdayStr)

        val notification = NotificationHelper.buildGlobalNotification(context, rule, resolvedBody)
        val requestCode = "global_$ruleId".hashCode()
        try {
            NotificationManagerCompat.from(context).notify(requestCode, notification)
        } catch (_: SecurityException) {}
    }

    private fun isCheckinTask(todo: Todo): Boolean {
        return todo.recurring == RecurringType.DAILY_REPEAT ||
               todo.taskType == TaskType.WEEKLY_CHECKIN ||
               todo.taskType == TaskType.MONTHLY_CHECKIN
    }

    private fun filterByScope(todos: List<Todo>, scope: String): List<Todo> {
        return when (scope) {
            "today_only" -> todos.filter { !isCheckinTask(it) }
            "recurring_only" -> todos.filter { isCheckinTask(it) }
            else -> todos
        }
    }
}
