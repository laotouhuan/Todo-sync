package com.todo.app.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.todo.app.TodoApplication

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
                Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED)) {
            val app = context.applicationContext as? TodoApplication ?: return
            val repo = app.repository
            com.todo.app.widget.WidgetDailySync.schedule(context, replace = true)

            val pendingResult = goAsync()
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val data = repo.ensureDataLoaded()
                    NotificationHelper.createChannels(context)
                    ReminderScheduler(context).rescheduleAll(data)
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    android.util.Log.e("BootReceiver", "数据未就绪，等待用户重试或恢复", e)
                } finally {
                    try {
                        com.todo.app.widget.refreshAllWidgets(context)
                    } finally {
                        pendingResult.finish()
                    }
                }
            }
        }
    }
}
