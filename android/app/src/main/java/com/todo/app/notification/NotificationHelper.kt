package com.todo.app.notification

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.todo.app.MainActivity
import com.todo.app.data.model.GlobalReminderRule
import com.todo.app.data.model.Todo

object NotificationHelper {
    const val CHANNEL_TASK = "task_reminder"
    const val CHANNEL_GLOBAL = "global_reminder"

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val taskChannel = NotificationChannel(
                CHANNEL_TASK, "任务提醒",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "单项任务到期提醒"
                enableVibration(true)
                enableLights(true)
                setShowBadge(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }

            val globalChannel = NotificationChannel(
                CHANNEL_GLOBAL, "全局提醒",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "全局定时提醒"
                enableVibration(true)
                enableLights(true)
                setShowBadge(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }

            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannels(listOf(taskChannel, globalChannel))
        }
    }

    fun buildTaskNotification(context: Context, todo: Todo, privacyMode: Boolean): Notification {
        val title = "Todo"
        val body = if (privacyMode) {
            "您有一条待办任务提醒"
        } else {
            val progress = if (todo.subtasks.isNotEmpty()) {
                val done = todo.subtasks.count { it.completed }
                " (已完成 ${done}/${todo.subtasks.size})"
            } else ""
            "${todo.content}$progress"
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra("highlight_todo_id", todo.id)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val requestCode = "task_${todo.id}".hashCode()
        val pi = PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(context, CHANNEL_TASK)
            .setSmallIcon(com.todo.app.R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    fun buildGlobalNotification(context: Context, rule: GlobalReminderRule, resolvedBody: String): Notification {
        val title = rule.title.ifEmpty { "Todo" }

        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra("show_today", true)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val requestCode = "global_${rule.id}".hashCode()
        val pi = PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(context, CHANNEL_GLOBAL)
            .setSmallIcon(com.todo.app.R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(resolvedBody)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }
}
