package com.todo.app.data.repository

import com.todo.app.data.model.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException

class OfflineLearningTest {
    @get:Rule val folder = TemporaryFolder()
    private val todo = Todo.create("本地任务")
    private fun store(write: ((String) -> Unit)? = null): PersonalDataStore {
        val file = folder.newFile().apply { writeText(Json.encodeToString(TodoData(1, nowIso(), listOf(todo)))) }
        return if (write == null) PersonalDataStore(file) else PersonalDataStore(file, write)
    }

    @Test fun failedPreSyncStillStartsLocalTimerAndRetainsFailure() = runBlocking {
        val store = store()
        val state = CloudSyncState()
        startLearningAfterSync(store, todo, TaskReference(todo.id), { true }) {
            state.run(true) { throw IOException("401") }
        }
        assertEquals(todo.id, store.data.value.timeEntries.single().task_ref.todo_id)
        assertEquals(SyncPhase.FAILED, state.outcome.value.phase)
        assertFalse(state.outcome.value.showsSuccess("personal"))
    }

    @Test fun skippedPreSyncAllowsLocalTimingWithoutCloudSuccess() = runBlocking {
        val store = store()
        val state = CloudSyncState()
        startLearningAfterSync(store, todo, TaskReference(todo.id), { true }) { state.run(false) { fail() } }
        assertEquals(1, store.data.value.timeEntries.size)
        assertEquals(SyncPhase.SKIPPED, state.outcome.value.phase)
    }

    @Test fun cancelledSyncNeverCreatesEntry() = runBlocking {
        val store = store()
        assertTrue(runCatching {
            startLearningAfterSync(store, todo, TaskReference(todo.id), { true }) {
                CloudSyncState().run(true) { throw CancellationException() }
            }
        }.exceptionOrNull() is CancellationException)
        assertTrue(store.data.value.timeEntries.isEmpty())
    }

    @Test fun localLoadValidationAndSaveFailuresStillPreventTiming() = runBlocking {
        val corrupt = PersonalDataStore(folder.newFile().apply { writeText("{损坏") })
        assertTrue(runCatching {
            startLearningAfterSync(corrupt, todo, TaskReference(todo.id), { true }) { fail("加载失败不能同步"); SyncOutcome() }
        }.isFailure)
        val invalid = store()
        assertTrue(runCatching {
            startLearningAfterSync(invalid, todo.copy(id = "不存在"), TaskReference("不存在"), { true }) { SyncOutcome(SyncPhase.SKIPPED) }
        }.isFailure)
        assertTrue(invalid.data.value.timeEntries.isEmpty())
        val unwritable = store { throw IOException("磁盘写入失败") }
        assertTrue(runCatching {
            startLearningAfterSync(unwritable, todo, TaskReference(todo.id), { true }) { SyncOutcome(SyncPhase.SKIPPED) }
        }.isFailure)
        assertTrue(unwritable.data.value.timeEntries.isEmpty())
    }
}
