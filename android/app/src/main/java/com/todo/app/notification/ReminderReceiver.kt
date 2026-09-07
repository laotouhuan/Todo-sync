package com.todo.app.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.todo.app.data.model.TodoData
import com.todo.app.data.model.evaluateReminderRule
import com.todo.app.data.model.renderReminderTemplate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import android.os.PowerManager
import android.util.Log
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDate
import java.time.LocalTime

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

        val evaluation = evaluateReminderRule(rule, todoData.todos, LocalDate.now())
        if (!evaluation.shouldTrigger) return

        val resolvedBody = renderReminderTemplate(rule.body, evaluation, LocalTime.now())

        val notification = NotificationHelper.buildGlobalNotification(context, rule, resolvedBody)
        val requestCode = "global_$ruleId".hashCode()
        try {
            NotificationManagerCompat.from(context).notify(requestCode, notification)
        } catch (_: SecurityException) {}
    }

}
