package com.todo.app.data.repository

import com.todo.app.data.model.*
import com.todo.app.widget.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class PersonalDataStoreTest {
    @get:Rule val folder = TemporaryFolder()
    private val start = "2026-09-22T08:00:00Z"
    private val end = "2026-09-22T08:10:00Z"
    private val todo = Todo.create("阅读", "2026-09-22").copy(label = "学习")
    private val entry = TimeEntry(id = "entry", task_ref = TaskReference(todo.id), started_at = start,
        created_at = start, updated_at = start, task_content_snapshot = "阅读", label_snapshot = "学习")
    private val data get() = TodoData(1, start, listOf(todo),
        reminderSettings = ReminderSettings(privacyMode = true),
        dailyReviews = listOf(DailyReview("review", "2026-09-22", start, start, fact = "已复习")))
    private fun encode(data: TodoData) = Json.encodeToString(data)
    private fun file() = folder.newFile("todo_data.json")

    @Test fun partialTemporaryWriteNeverTruncatesOriginal() {
        val file = file().apply { writeText(encode(data)) }
        val original = file.readBytes()
        val writer = AtomicJsonFile(file, writeTemporary = { temporary, _ ->
            temporary.writeText("半截内容")
            throw IOException("模拟磁盘满或刷盘失败")
        })
        assertTrue(runCatching { writer.write("新内容") }.isFailure)
        assertArrayEquals(original, file.readBytes())
        assertEquals(todo.id, Json.decodeFromString<TodoData>(file.readText()).todos.single().id)
    }

    @Test fun replacementFailureKeepsOriginalAndRemovesTemporary() {
        val file = file().apply { writeText(encode(data)) }
        val original = file.readBytes()
        val writer = AtomicJsonFile(file, replace = { _, _ -> throw IOException("替换失败") })
        assertTrue(runCatching { writer.write(encode(data.copy(todos = emptyList()))) }.isFailure)
        assertArrayEquals(original, file.readBytes())
        assertEquals(listOf(file.name), file.parentFile!!.listFiles()!!.map { it.name })
    }

    @Test fun failedLoadCanRetryAndDoesNotCreateOrUploadEmptyData() = runBlocking {
        val file = file().apply { writeText("{损坏") }
        var writes = 0
        val store = PersonalDataStore(file) { writes++; AtomicJsonFile(file).write(it) }
        assertTrue(runCatching { store.ensureLoaded() }.isFailure)
        assertNotNull(store.loadError.value)
        assertTrue(runCatching { store.start(todo, TaskReference(todo.id), { true }, start) }.isFailure)
        assertEquals(0, writes)
        assertEquals("{损坏", file.readText())
        file.writeText(encode(data))
        assertEquals(todo.id, store.ensureLoaded().todos.single().id)
        assertNull(store.loadError.value)
        store.start(todo, TaskReference(todo.id), { true }, start)
        assertEquals(1, writes)
    }

    @Test fun missingFileLoadsAsEmptyButUnreadableExistingFileFails() = runBlocking {
        val absent = File(folder.root, "missing.json")
        assertTrue(PersonalDataStore(absent).ensureLoaded().todos.isEmpty())
        val directory = folder.newFolder("unreadable.json")
        assertTrue(runCatching { PersonalDataStore(directory).ensureLoaded() }.isFailure)
    }

    @Test fun restoreFromBadFileClearsErrorWithoutRestartAndPreservesExtensions() = runBlocking {
        val file = file().apply { writeText("bad json") }
        val store = PersonalDataStore(file)
        assertTrue(runCatching { store.ensureLoaded() }.isFailure)
        assertTrue(runCatching { store.restore("also bad") }.isFailure)
        assertEquals("bad json", file.readText())
        assertNotNull(store.loadError.value)
        store.restore(encode(data))
        assertNull(store.loadError.value)
        store.start(todo, TaskReference(todo.id), { true }, start)
        val result = store.ensureLoaded()
        assertEquals(data.reminderSettings, result.reminderSettings)
        assertEquals(data.dailyReviews, result.dailyReviews)
        assertEquals(1, result.timeEntries.size)
    }

    @Test fun failedRestoreRetainsFileAndLoadError() = runBlocking {
        val file = file().apply { writeText("bad json") }
        val store = PersonalDataStore(file) { throw IOException("写入失败") }
        runCatching { store.ensureLoaded() }
        assertTrue(runCatching { store.restore(encode(data)) }.isFailure)
        assertNotNull(store.loadError.value)
        assertEquals("bad json", file.readText())
    }

    @Test fun failedCommitDoesNotPublishAndCanRetry() = runBlocking {
        val file = file().apply { writeText(encode(data)) }
        var fail = true
        val store = PersonalDataStore(file) {
            if (fail) throw IOException("写入失败")
            AtomicJsonFile(file).write(it)
        }
        val previous = store.ensureLoaded()
        assertTrue(runCatching { store.start(todo, TaskReference(todo.id), { true }, start) }.isFailure)
        assertSame(previous, store.data.value)
        assertTrue(Json.decodeFromString<TodoData>(file.readText()).timeEntries.isEmpty())
        fail = false
        store.start(todo, TaskReference(todo.id), { true }, start)
        assertEquals(1, store.data.value.timeEntries.size)
    }

    @Test fun startUsesLatestPersonalTaskAndRejectsDeletedMissingOrWrongReference() = runBlocking {
        val store = PersonalDataStore(file())
        store.restore(encode(data.copy(todos = listOf(todo.copy(content = "新版", label = "新标签")))))
        store.start(todo, TaskReference(todo.id), { true }, start)
        assertEquals("新版", store.data.value.timeEntries.single().task_content_snapshot)
        assertEquals("新标签", store.data.value.timeEntries.single().label_snapshot)
        store.restore(encode(data.copy(todos = listOf(todo.copy(deleted = true)))))
        assertTrue(runCatching { store.start(todo, TaskReference(todo.id), { true }, start) }.isFailure)
        store.restore(encode(data.copy(todos = emptyList())))
        assertTrue(runCatching { store.start(todo, TaskReference(todo.id), { true }, start) }.isFailure)
        assertTrue(runCatching { store.start(todo, TaskReference("wrong"), { true }, start) }.isFailure)
    }

    @Test fun concurrentStartsCreateOnlyOneRecord() = runBlocking {
        val store = PersonalDataStore(file())
        store.restore(encode(data))
        store.mutex.lock()
        val first = async(start = CoroutineStart.UNDISPATCHED) { runCatching { store.start(todo, TaskReference(todo.id), { true }, start) } }
        val second = async(start = CoroutineStart.UNDISPATCHED) { runCatching { store.start(todo, TaskReference(todo.id), { true }, start) } }
        store.mutex.unlock()
        assertTrue(first.await().isSuccess)
        assertTrue(second.await().isFailure)
        assertEquals(1, store.data.value.timeEntries.size)
    }

    @Test fun staleStopLeavesNewTimerAndRecomputesLatestWidgetState() = runBlocking {
        val store = PersonalDataStore(file())
        val other = entry.copy(id = "other", task_content_snapshot = "另一任务")
        store.restore(encode(data.copy(timeEntries = listOf(entry, other))))
        assertTrue(widgetTimerState(store.data.value, true, Instant.parse(end)) is WidgetTimerState.Attention)
        store.stop(entry.id, { true }, end)
        assertEquals("other", (widgetTimerState(store.data.value, true, Instant.parse(end)) as WidgetTimerState.Running).entry.id)
        store.stop(entry.id, { true }, end)
        assertNull(store.data.value.timeEntries.single { it.id == "other" }.ended_at)
        store.stop("other", { true }, end)
        assertEquals(WidgetTimerState.Idle, widgetTimerState(store.data.value, true))
        assertFalse(store.data.value.todos.single().completed)
    }

    @Test fun shortTimerUsesTombstoneAndKeepsReviewAndReminder() = runBlocking {
        val store = PersonalDataStore(file())
        store.restore(encode(data.copy(timeEntries = listOf(entry))))
        assertEquals(1, store.stop(entry.id, { true }, "2026-09-22T08:00:30Z"))
        assertTrue(store.data.value.timeEntries.single().deleted)
        assertEquals(data.reminderSettings, store.data.value.reminderSettings)
        assertEquals(data.dailyReviews, store.data.value.dailyReviews)
    }

    @Test fun closingHoldsLockAcrossRecordWriteAndSettingsSave() = runBlocking {
        val file = file()
        val pause = AtomicBoolean(false)
        val written = CountDownLatch(1)
        val release = CountDownLatch(1)
        val store = PersonalDataStore(file) {
            AtomicJsonFile(file).write(it)
            if (pause.get()) {
                written.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
        }
        store.restore(encode(data.copy(timeEntries = listOf(entry))))
        val enabled = AtomicBoolean(true)
        pause.set(true)
        val closing = async(Dispatchers.IO) { store.saveTimingPreferences(listOf(entry), { enabled.set(false) }, end) }
        try {
            assertTrue(written.await(5, TimeUnit.SECONDS))
            val starting = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { store.start(todo, TaskReference(todo.id), enabled::get, end) }
            }
            assertFalse(starting.isCompleted)
            release.countDown()
            closing.await()
            assertTrue(starting.await().isFailure)
            assertFalse(enabled.get())
            assertTrue(store.data.value.timeEntries.none { it.ended_at == null })
        } finally { release.countDown() }
    }

    @Test fun startBeforeClosingInvalidatesConfirmation() = runBlocking {
        val store = PersonalDataStore(file())
        store.restore(encode(data))
        var enabled = true
        store.start(todo, TaskReference(todo.id), { enabled }, start)
        val result = runCatching { store.saveTimingPreferences(emptyList(), { enabled = false }, end) }
        assertTrue(result.isFailure)
        assertTrue(enabled)
        assertNull(store.data.value.timeEntries.single().ended_at)
    }

    @Test fun emptyConfirmationDoesNotWriteDataOrClaimRecordsFinished() = runBlocking {
        val file = file().apply { writeText(encode(data)) }
        val store = PersonalDataStore(file) { error("无运行记录时不应写入数据") }
        var saved = false
        store.saveTimingPreferences(emptyList(), { saved = true }, end)
        assertTrue(saved)
        val result = runCatching { store.saveTimingPreferences(emptyList(), { throw IOException("设置失败") }, end) }
        assertEquals("设置失败", result.exceptionOrNull()!!.message)
    }

    @Test fun settingsFailureKeepsFinishedRecordAndEnabledState() = runBlocking {
        val store = PersonalDataStore(file())
        store.restore(encode(data.copy(timeEntries = listOf(entry))))
        val result = runCatching { store.saveTimingPreferences(listOf(entry), { throw IOException("设置失败") }, end) }
        assertTrue(result.exceptionOrNull()!!.message!!.contains("记录已结束"))
        assertEquals(end, store.data.value.timeEntries.single().ended_at)
    }

    @Test fun failedFinishDoesNotSaveSettingsAndDisableOnlyKeepsRecords() = runBlocking {
        val file = file().apply { writeText(encode(data.copy(timeEntries = listOf(entry)))) }
        var settingsCalled = false
        val store = PersonalDataStore(file) { throw IOException("写盘失败") }
        assertTrue(runCatching { store.saveTimingPreferences(listOf(entry), { settingsCalled = true }, end) }.isFailure)
        assertFalse(settingsCalled)
        store.saveTimingPreferences(null, { settingsCalled = true }, end)
        assertTrue(settingsCalled)
        assertNull(store.data.value.timeEntries.single().ended_at)
    }
}
