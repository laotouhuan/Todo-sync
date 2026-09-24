package com.todo.app.data.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow

/** 调用方持有仓库锁；无配置不执行网络操作，所有退出路径都结束进行中状态。 */
internal class CloudSyncState {
    val syncing = MutableStateFlow(false)
    val status = MutableStateFlow(0)

    suspend fun run(configured: Boolean, operation: suspend () -> Unit): Result<Unit> {
        if (!configured) {
            syncing.value = false
            status.value = 0
            return Result.success(Unit)
        }
        syncing.value = true
        status.value = 1
        return try {
            operation()
            status.value = 0
            Result.success(Unit)
        } catch (e: Exception) {
            status.value = 2
            if (e is CancellationException) throw e
            Result.failure(e)
        } finally {
            syncing.value = false
        }
    }
}
