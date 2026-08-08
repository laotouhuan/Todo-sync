package com.todo.app.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.todo.app.data.model.RecurringType
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.data.model.isOverdue
import com.todo.app.data.model.weekStringOf
import com.todo.app.data.model.monthStringOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import android.os.PowerManager
import android.util.Log
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDate

class ReminderReceiver : BroadcastReceiver() {

    private val TAG = "ReminderReceiver"

    // 独立 Json 实例：不依赖 Application，BroadcastReceiver 进程中直接使用
    private val jsonFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Todo:ReminderWakeLock")
        wakeLock?.acquire(10000)

        val targetId = intent.getStringExtra("target_id") ?: run {
            try { if (wakeLock?.isHeld == true) wakeLock.release() } catch (_: Exception) {}
            pendingResult.finish()
            return
        }
        val type = intent.getStringExtra("type") ?: run {
            try { if (wakeLock?.isHeld == true) wakeLock.release() } catch (_: Exception) {}
            pendingResult.finish()
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                // ★ 核心修复：直接从磁盘读取数据，完全不依赖 TodoApplication 进程状态
                // 即使 App 被系统杀死，闹钟唤醒后也能独立读取文件并发出通知
                val todoData = readTodoDataFromDisk(context) ?: run {
                    Log.w(TAG, "无法从磁盘读取数据，跳过通知 (targetId=$targetId)")
                    return@launch
                }

                if (!todoData.reminderSettings.enabled) return@launch

                when (type) {
                    "task" -> handleTaskReminder(context, todoData, targetId)
                    "global" -> handleGlobalReminder(context, todoData, targetId)
                }

                // 触发后重新调度以更新下个周期
                ReminderScheduler(context).rescheduleAll(todoData)
            } catch (e: Exception) {
                Log.e(TAG, "onReceive 处理异常 (targetId=$targetId, type=$type)", e)
            } finally {
                try { if (wakeLock?.isHeld == true) wakeLock.release() } catch (_: Exception) {}
                pendingResult.finish()
            }
        }
    }

    /**
     * 直接从 App 内部存储读取 todo_data.json，无需 Application 初始化完成。
     * 这是通知能在 App 被杀死后仍然可靠触发的关键。
     */
    private fun readTodoDataFromDisk(context: Context): TodoData? {
        return try {
            val file = File(context.filesDir, "todo_data.json")
            if (!file.exists()) {
                Log.d(TAG, "todo_data.json 不存在，返回 null")
                return null
            }
            val content = file.readText(Charsets.UTF_8)
            val parsed = jsonFormat.decodeFromString<TodoData>(content)
            com.todo.app.data.model.MergeUtils.normalizeData(parsed)
        } catch (e: Exception) {
            Log.e(TAG, "readTodoDataFromDisk 失败", e)
            null
        }
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

        val today = LocalDate.now()
        val todayStr = today.toString()
        val thisWeekStr = com.todo.app.data.model.weekStringOf(today)
        val thisMonthStr = com.todo.app.data.model.monthStringOf(today)

        val activeTodos = todoData.todos.filter { !it.deleted }
        val isRecurringTask = { t: Todo ->
            if (t.recurring == RecurringType.DAILY_REPEAT) {
                val d = t.date
                d == null || d == todayStr
            } else if (t.taskType == TaskType.WEEKLY_CHECKIN) {
                t.date == thisWeekStr || t.date == null
            } else if (t.taskType == TaskType.MONTHLY_CHECKIN) {
                t.date == thisMonthStr || t.date == null
            } else {
                false
            }
        }

        val scopedTodos = activeTodos.filter {
            when (rule.taskScope) {
                "today_only" -> !isRecurringTask(it) && (it.date == todayStr || it.isOverdue(todayStr))
                "recurring_only" -> isRecurringTask(it)
                else -> it.date == todayStr || it.isOverdue(todayStr) || isRecurringTask(it)
            }
        }

        val isTaskCompletedToday = { t: Todo ->
            if (t.completed) {
                true
            } else if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
                t.completedDates.any { it.startsWith(todayStr) }
            } else {
                false
            }
        }

        val shouldTrigger = when (rule.condition) {
            "none_completed" -> scopedTodos.none { isTaskCompletedToday(it) }
            "any_remaining" -> scopedTodos.any { !isTaskCompletedToday(it) }
            "unconditional" -> true
            else -> false
        }
        if (!shouldTrigger) return

        val remainingCount = scopedTodos.count { !isTaskCompletedToday(it) }
        val completedCount = scopedTodos.count { isTaskCompletedToday(it) }
        val totalCount = scopedTodos.size
        val overdueCount = if (rule.taskScope == "recurring_only") 0 else scopedTodos.count { it.isOverdue(todayStr) }
        val rateVal = if (totalCount > 0) Math.round((completedCount.toDouble() / totalCount) * 100).toInt() else 0

        val now = java.time.LocalTime.now()
        val nowTimeStr = String.format("%02d:%02d", now.hour, now.minute)

        val todayDate = java.time.LocalDate.now()
        val todayDateStr = String.format("%02d月%02d日", todayDate.monthValue, todayDate.dayOfMonth)
        val weekdays = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
        val weekdayStr = weekdays[todayDate.dayOfWeek.value % 7]

        val resolvedBody = rule.body
            .replace("{time}", nowTimeStr)
            .replace("{now_time}", nowTimeStr)
            .replace("{date}", todayDateStr)
            .replace("{today_date}", todayDateStr)
            .replace("{remaining_count}", remainingCount.toString())
            .replace("{completed_count}", completedCount.toString())
            .replace("{total_count}", totalCount.toString())
            .replace("{overdue_count}", overdueCount.toString())
            .replace("{completion_rate}", "$rateVal%")
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
