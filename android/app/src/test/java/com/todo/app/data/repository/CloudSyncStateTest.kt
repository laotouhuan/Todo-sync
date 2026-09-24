package com.todo.app.data.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CloudSyncStateTest {
    @Test fun unconfiguredSkipsNetworkAndClearsStaleProgress() = runBlocking {
        val state = CloudSyncState()
        state.status.value = 1
        state.syncing.value = true
        var called = false
        assertTrue(state.run(false) { called = true }.isSuccess)
        assertFalse(called)
        assertFalse(state.syncing.value)
        assertEquals(0, state.status.value)
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
    }
}
