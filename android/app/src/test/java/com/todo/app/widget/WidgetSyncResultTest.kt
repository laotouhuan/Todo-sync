package com.todo.app.widget

import androidx.work.ListenableWorker
import com.todo.app.data.model.SyncOutcome
import com.todo.app.data.model.SyncPhase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class WidgetSyncResultTest {
    @Test fun failedSyncRefreshesLocalViewAndNotifiesButWorkerFails() = runBlocking {
        val calls = mutableListOf<String>()
        val result = refreshAroundSync(
            load = { calls.add("load") }, refresh = { calls.add("refresh") },
            sync = { calls.add("sync"); SyncOutcome(SyncPhase.FAILED, error = java.io.IOException("401")) },
            notifyFailure = { calls.add(it) })
        assertEquals(listOf("load", "refresh", "sync", "同步失败：401", "refresh"), calls)
        assertTrue(widgetWorkResult(result) is ListenableWorker.Result.Failure)
        assertFalse(result.showsSuccess("personal"))
    }

    @Test fun unconfiguredRefreshWorksWithoutSuccessOrErrorPrompt() = runBlocking {
        var refreshes = 0
        val result = refreshAroundSync({}, { refreshes++ }, { SyncOutcome(SyncPhase.SKIPPED) },
            { fail("跳过不能报成功或失败") })
        assertEquals(2, refreshes)
        assertTrue(widgetWorkResult(result) is ListenableWorker.Result.Success)
        assertFalse(result.showsSuccess("personal"))
    }

    @Test fun cancellationPropagatesAndNeverReturnsWorkerSuccess() = runBlocking {
        var refreshes = 0
        val error = runCatching {
            refreshAroundSync({}, { refreshes++ }, { throw CancellationException() }, { fail("取消不提示网络失败") })
        }.exceptionOrNull()
        assertTrue(error is CancellationException)
        assertEquals(2, refreshes)
        assertTrue(runCatching { widgetWorkResult(SyncOutcome(SyncPhase.CANCELLED)) }.exceptionOrNull() is CancellationException)
    }

    @Test fun failedLocalLoadDoesNotStartNetworkOperation() = runBlocking {
        assertTrue(runCatching {
            refreshAroundSync({ error("本地文件损坏") }, {}, { fail("不得同步空数据"); SyncOutcome() })
        }.isFailure)
    }
}
