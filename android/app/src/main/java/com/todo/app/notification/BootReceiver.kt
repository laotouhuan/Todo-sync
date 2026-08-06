package com.todo.app.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.todo.app.TodoApplication

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == "android.intent.action.MY_PACKAGE_REPLACED") {
            val app = context.applicationContext as? TodoApplication ?: return
            val repo = app.repository
            val data = repo.getCurrentData()
            NotificationHelper.createChannels(context)
            ReminderScheduler(context).rescheduleAll(data)
        }
    }
}
