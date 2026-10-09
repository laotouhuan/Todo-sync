package com.todo.app.data.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import com.todo.app.data.model.SyncPhase
import org.junit.Assert.*
import org.junit.Test

class CloudSyncStateTest {
    @Test fun unconfiguredSkipsNetworkAndClearsStaleProgress() = runBlocking {
        val state = CloudSyncState()
        state.status.value = 1
        state.syncing.value = true
        var called = false
        assertFalse(state.run(false) { called = true }.isSuccess)
        assertFalse(called)
        assertFalse(state.syncing.value)
        assertEquals(0, state.status.value)
        assertEquals(SyncPhase.SKIPPED, state.outcome.value.phase)
        assertFalse(state.outcome.value.showsSuccess("personal"))
    }

    @Test fun missingClientFailureAndEarlyReturnCannotLeaveProgress() = runBlocking {
        val state = CloudSyncState()
        assertTrue(state.run(true) { error("客户端不可用") }.isFailure)
        assertFalse(state.syncing.value)
        assertEquals(2, state.status.value)
        state.run(true) {
            assertTrue(state.syncing.value)
            assertEquals(1, state.status.value)
            return@run
        }
        assertFalse(state.syncing.value)
        assertEquals(0, state.status.value)
    }

    @Test fun cancellationPropagatesAndClearsProgress() = runBlocking {
        val state = CloudSyncState()
        assertTrue(runCatching { state.run(true) { throw CancellationException() } }.exceptionOrNull() is CancellationException)
        assertFalse(state.syncing.value)
        assertNotEquals(1, state.status.value)
        assertEquals(SyncPhase.CANCELLED, state.outcome.value.phase)
        assertFalse(state.outcome.value.showsSuccess("personal"))
    }

    @Test fun staleCompletionCannotReplaceNewTargetOrConfiguration() = runBlocking {
        val state = CloudSyncState()
        val entered = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val old = async {
            state.run(true, "old") { entered.complete(Unit); finish.await() }
        }
        entered.await()
        val latest = state.run(true, "new") { }
        finish.complete(Unit)
        old.await()
        assertEquals(latest, state.outcome.value)
        assertFalse(latest.showsSuccess("old", latest.completedAt))
        assertTrue(latest.showsSuccess("new", latest.completedAt))
        assertFalse(latest.showsSuccess("new", latest.completedAt + 1500))
        val configuration = state.configurationId()
        state.reset()
        state.run(true, configurationId = configuration) { }
        assertEquals(SyncPhase.IDLE, state.outcome.value.phase)
        assertFalse(state.syncing.value)
    }

    @Test fun quickSuccessRetryAndFailureNeedNoObservedLoadingTransition() = runBlocking {
        val state = CloudSyncState()
        val failure = state.run(true) { error("失败") }
        assertFalse(failure.showsSuccess("personal"))
        val success = state.run(true) { }
        assertTrue(success.showsSuccess("personal", success.completedAt))
        assertTrue(success.operationId > failure.operationId)
        assertNull(state.outcome.value.error)
    }
}
