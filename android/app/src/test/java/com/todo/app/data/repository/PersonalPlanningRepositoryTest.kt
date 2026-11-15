package com.todo.app.data.repository

import com.todo.app.data.model.SyncPhase
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PersonalPlanningRepositoryTest {
    @get:Rule val folder = TemporaryFolder()
    private val target = RecordSandboxTarget("10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002", "2026-11-15T00:00:00Z")
    private fun settings(key: String = "A"): PlanningSettings = key to
        PlanningCloudConnection("https://example.test/dav/", "example", "fake", "$key/todo_data.json")

    private suspend fun initial() = RecordSandbox(folder.root, target, localOnly = true).open()

    private class Session(var result: RecordSandboxView, override val connectedCloud: Boolean = true,
        override val retainedLocal: Boolean = false) : PersonalPlanningSession {
        var syncCalls = 0
        var writes = 0
        var closed = false
        var failure: Exception? = null
        var syncResult: RecordSandboxView? = null
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun open() = result
        override suspend fun sync(): RecordSandboxView {
            syncCalls++
            gate?.await()
            failure?.let { throw it }
            return syncResult ?: result
        }
        override suspend fun change(action: JsonObject, revision: String?): RecordSandboxView {
            writes++
            return result.copy(revision = "saved").also { result = it }
        }
        override suspend fun retry() = result to false
        override suspend fun close() { closed = true }
    }

    @Test fun coldSyncWithoutStatisticsCreatesAndSyncsPlanningSession() = runBlocking {
        val session = Session(initial())
        var opens = 0
        val repository = PersonalPlanningRepository({ settings() }) { opens++; session }
        assertNull(repository.state.value.data)
        assertTrue(repository.sync())
        assertEquals(1, opens)
        assertEquals(1, session.syncCalls)
        assertNotNull(repository.state.value.data?.preview?.view)
        assertEquals(SyncPhase.IDLE, repository.state.value.phase)
        assertTrue(repository.sync())
        assertEquals(1, opens)
        assertEquals(2, session.syncCalls)
    }

    @Test fun syncWaitsForPlanningAndFailedRequestsCanRetryWithoutOpeningPage() = runBlocking {
        val session = Session(initial()).apply { gate = CompletableDeferred(); failure = IOException("模拟网络失败") }
        val repository = PersonalPlanningRepository({ settings() }) { session }
        val syncing = async { repository.sync() }
        while (session.syncCalls == 0) yield()
        assertFalse(syncing.isCompleted)
        assertEquals(SyncPhase.RUNNING, repository.state.value.phase)
        session.gate!!.complete(Unit)
        assertFalse(syncing.await())
        assertEquals(SyncPhase.FAILED, repository.state.value.phase)
        assertTrue(repository.state.value.syncError!!.contains("模拟网络失败"))
        session.failure = null
        assertTrue(repository.sync())
        assertNull(repository.state.value.syncError)
    }

    @Test fun loadFailurePreservesReasonAndNextManualSyncReopens() = runBlocking {
        val session = Session(initial())
        var attempts = 0
        val repository = PersonalPlanningRepository({ settings() }) {
            if (++attempts == 1) throw IOException("模拟读取失败")
            session
        }
        assertFalse(repository.sync())
        assertTrue(repository.state.value.loadError!!.contains("模拟读取失败"))
        assertTrue(repository.sync())
        assertEquals(2, attempts)
        assertNull(repository.state.value.loadError)
    }

    @Test fun changedTargetDiscardsOldResultAndRejectsOldDraftWrites() = runBlocking {
        var selected = settings()
        val old = Session(initial()).apply { gate = CompletableDeferred() }
        val next = Session(initial())
        val repository = PersonalPlanningRepository({ selected }) { if (it.first == "A") old else next }
        val syncing = async { repository.sync() }
        while (old.syncCalls == 0) yield()
        selected = settings("B")
        old.gate!!.complete(Unit)
        assertFalse(syncing.await())
        assertFalse(repository.state.value.settings == selected)
        assertTrue(repository.sync())
        assertTrue(old.closed)
        assertEquals(selected, repository.state.value.settings)
        assertTrue(runCatching { repository.change(settings(), JsonObject(emptyMap()), null) }.isFailure)
        assertEquals(0, next.writes)
    }

    @Test fun writesAndManualSyncReuseOneSessionAndSerialize() = runBlocking {
        val session = Session(initial()).apply { gate = CompletableDeferred() }
        var opens = 0
        val repository = PersonalPlanningRepository({ settings() }) { opens++; session }
        val syncing = async { repository.sync() }
        while (session.syncCalls == 0) yield()
        val writing = async { repository.change(settings(), JsonObject(emptyMap()), null) }
        yield()
        assertEquals(0, session.writes)
        session.gate!!.complete(Unit)
        assertTrue(syncing.await())
        writing.await()
        assertEquals(1, opens)
        assertEquals("saved", repository.state.value.data?.revision)
    }

    @Test fun independentLocalPlanningIsRetainedAndNeverReportedAsCloudSuccess() = runBlocking {
        val session = Session(initial(), connectedCloud = false, retainedLocal = true)
        val repository = PersonalPlanningRepository({ settings() }) { session }
        assertFalse(repository.sync())
        assertEquals(0, session.syncCalls)
        assertEquals(SyncPhase.FAILED, repository.state.value.phase)
        assertTrue(repository.state.value.syncError!!.contains("保留在本机"))
        assertNotNull(repository.state.value.data)
    }

    @Test fun cancellationDoesNotLeavePermanentRunningState() = runBlocking {
        val session = Session(initial())
        val repository = PersonalPlanningRepository({ settings() }) { session }
        assertTrue(repository.sync())
        session.gate = CompletableDeferred()
        val syncing = async { repository.sync() }
        while (session.syncCalls < 2) yield()
        syncing.cancelAndJoin()
        assertEquals(SyncPhase.IDLE, repository.state.value.phase)
        assertNotNull(repository.state.value.data)
        session.gate!!.complete(Unit)
        assertTrue(repository.sync())
    }

    @Test fun incompleteCloudViewKeepsReadableLocalSnapshot() = runBlocking {
        val initial = initial()
        val session = Session(initial).apply {
            syncResult = initial.copy(preview = initial.preview.copy(view = null), syncIncomplete = true)
        }
        val repository = PersonalPlanningRepository({ settings() }) { session }
        assertFalse(repository.sync())
        assertEquals(initial.preview.view, repository.state.value.data?.preview?.view)
        assertEquals(SyncPhase.FAILED, repository.state.value.phase)
    }
}
