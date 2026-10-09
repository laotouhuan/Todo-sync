package com.todo.app.widget

import androidx.work.ListenableWorker
import com.todo.app.data.model.SyncOutcome
import com.todo.app.data.model.SyncPhase
import kotlinx.coroutines.CancellationException

/** 两个刷新入口共用；本地刷新完成不能代表云同步完成。 */
internal suspend fun refreshAroundSync(
    load: suspend () -> Unit,
    refresh: suspend () -> Unit,
    sync: suspend () -> SyncOutcome,
    notifyFailure: suspend (String) -> Unit = {}
): SyncOutcome {
    load()
    refresh()
    return try {
        sync().also {
            if (it.phase == SyncPhase.CANCELLED) throw CancellationException("同步已取消")
            if (it.isFailure) notifyFailure("同步失败：${it.error?.message ?: "请重试"}")
        }
    } finally { refresh() }
}

internal fun widgetWorkResult(outcome: SyncOutcome): ListenableWorker.Result = when (outcome.phase) {
    SyncPhase.SUCCEEDED, SyncPhase.SKIPPED -> ListenableWorker.Result.success()
    SyncPhase.CANCELLED -> throw CancellationException("同步已取消")
    else -> ListenableWorker.Result.failure()
}
