package com.todo.app.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.todo.app.TodoApplication
import kotlinx.coroutines.CancellationException
import java.time.ZonedDateTime

internal fun nextWidgetMidnight(now: ZonedDateTime): Long =
    now.toLocalDate().plusDays(1).atStartOfDay(now.zone).toInstant().toEpochMilli()

object WidgetDailySync {
    fun schedule(context: Context, replace: Boolean = false) {
        val intent = Intent(context, WidgetDailySyncReceiver::class.java)
        // 打开应用不推迟已经安排的任务；重启、修改时区时重新计算本地午夜。
        if (!replace && PendingIntent.getBroadcast(context, 0, intent,
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) != null) return
        val pending = PendingIntent.getBroadcast(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,
            nextWidgetMidnight(ZonedDateTime.now()), pending)
    }
}

class WidgetDailySyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        WidgetDailySync.schedule(context, replace = true)
        // 网络操作交给持久后台任务，避免广播接收器超时；不以联网作为刷新前提。
        val pending = goAsync()
        val operation = WorkManager.getInstance(context).enqueueUniqueWork(
            "widget-daily-sync", ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<WidgetDailySyncWorker>().build())
        operation.result.addListener({ pending.finish() }, java.util.concurrent.Executor { it.run() })
    }
}

class WidgetDailySyncWorker(context: Context, parameters: WorkerParameters) :
    CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        try {
            val repository = TodoApplication.instance.repository
            repository.ensureDataLoaded()
            // 先用本地数据跨天刷新，云同步失败也不会继续显示昨天的画面。
            refreshAllWidgets(applicationContext)
            repository.syncWithCloud()
            refreshAllWidgets(applicationContext)
            return Result.success()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Log.e("WidgetDailySync", "午夜同步失败", e)
            refreshAllWidgets(applicationContext)
            return Result.failure()
        }
    }
}
