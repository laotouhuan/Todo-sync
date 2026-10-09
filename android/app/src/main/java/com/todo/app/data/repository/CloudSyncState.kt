package com.todo.app.data.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import com.todo.app.data.model.SyncOutcome
import com.todo.app.data.model.SyncPhase

/** 最新操作才能发布结果；重置配置不会取消已经接受的数据保存。 */
internal class CloudSyncState {
    val syncing = MutableStateFlow(false)
    val status = MutableStateFlow(0)
    val outcome = MutableStateFlow(SyncOutcome())
    private var generation = 0L
    private var sequence = 0L
    @Volatile private var configuration = 0L
    fun configurationId(): Long = configuration

    @Synchronized fun reset() {
        configuration++
        generation = ++sequence
        publish(SyncOutcome())
    }

    @Synchronized private fun begin(configured: Boolean, target: String, configurationId: Long): SyncOutcome {
        val next = SyncOutcome(if (configured) SyncPhase.RUNNING else SyncPhase.SKIPPED,
            target, ++sequence)
        if (configurationId == configuration) {
            generation = next.operationId
            publish(next)
        }
        return next
    }

    @Synchronized private fun finish(result: SyncOutcome) {
        if (result.operationId == generation) publish(result)
    }

    private fun publish(result: SyncOutcome) {
        outcome.value = result
        syncing.value = result.phase == SyncPhase.RUNNING
        status.value = when (result.phase) {
            SyncPhase.RUNNING -> 1
            SyncPhase.FAILED -> 2
            else -> 0
        }
    }

    suspend fun run(configured: Boolean, target: String = "personal", configurationId: Long = configurationId(), operation: suspend () -> Unit): SyncOutcome {
        currentCoroutineContext().ensureActive()
        val started = begin(configured, target, configurationId)
        if (!configured) return started
        val result = try {
            operation()
            currentCoroutineContext().ensureActive()
            started.copy(phase = SyncPhase.SUCCEEDED, completedAt = System.currentTimeMillis())
        } catch (e: CancellationException) {
            finish(started.copy(phase = SyncPhase.CANCELLED))
            throw e
        } catch (e: Exception) {
            started.copy(phase = SyncPhase.FAILED, error = e)
        }
        finish(result)
        return result
    }
}
