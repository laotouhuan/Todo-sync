package com.todo.app.data.model

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class CollaborationLearningTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val date = LocalDate.of(2026, 10, 6)
    private val time = "2026-10-06T09:00:00+08:00"
    private val source = CollaborationSource("shared", "分享者", "https://example.test/dav/", "user", "fake", "todo.json")
    private fun entry(id: String, type: String = "personal", end: String? = "2026-10-06T10:00:00+08:00") = TimeEntry(
        id, TaskReference("task", type, if (type == "personal") null else "other"), time, time, time, "旧任务", "旧标签", end)
    private fun owner() = TodoData(1, time, listOf(Todo(id = "task", content = "分享者任务", label = "数学", createdAt = time)),
        timeEntries = listOf(entry("visible"), entry("hidden", "collaboration")),
        dailyReviews = listOf(DailyReview("review", date.toString(), time, time, fact = "分享者复盘")))

    @Test fun referencesAreCopiedAndPersonalDataIsNotMixed() {
        val data = owner()
        val serialized = Json.encodeToString(data)
        val view = learningViewData(data, source.id)
        assertEquals(listOf("visible"), view.data.timeEntries.map { it.id })
        assertEquals(TaskReference("task", "collaboration", source.id), view.data.timeEntries.single().task_ref)
        assertTrue(view.readOnly)
        assertEquals("分享者复盘", view.data.dailyReviews.single().fact)
        assertEquals(serialized, Json.encodeToString(data))
        assertEquals("personal", data.timeEntries.first().task_ref.source_type)
    }

    @Test fun hiddenSourceOverlapStaysExcludedFromSummaryTimelineAndExport() {
        val view = learningViewData(owner(), source.id)
        val resolved = Learning.resolveEntries(view.data.timeEntries, view.tasks)
        val summary = Learning.summary(resolved, date, date.plusDays(1), zone, conflicts = view.conflicts)
        assertEquals(0L, summary.duration)
        assertEquals(1, summary.pending)
        assertEquals(listOf("visible"), view.pendingIds(date, date.plusDays(1), zone))
        assertTrue(view.pendingIds(date.plusDays(1), date.plusDays(2), zone).isEmpty())
        assertTrue(StatsTimeline.arcs(resolved, TaskReference("", "collaboration", source.id), "day", date, zone, view.conflicts).isEmpty())
        val exported = Learning.export(view.data, "week", date, zone = zone, tasks = view.tasks, conflicts = view.conflicts).second
        assertTrue(exported.contains("合计：0 秒"))
        assertTrue(exported.contains("1 条待核对"))
        assertFalse(exported.contains("hidden"))
        assertEquals(3_600_000L, Learning.summary(resolved, date, date.plusDays(1), zone).duration)
    }

    @Test fun conflictsRefreshWhenHiddenRecordIsDeletedAndRespectRunningOverlap() {
        val data = owner()
        val deleted = learningViewData(data.copy(timeEntries = listOf(entry("visible"), entry("hidden", "collaboration").copy(deleted = true))), source.id)
        assertTrue(deleted.conflicts.isEmpty())
        assertEquals(3_600_000L, Learning.summary(deleted.data.timeEntries, date, date.plusDays(1), zone, conflicts = deleted.conflicts).duration)
        val running = learningViewData(data.copy(timeEntries = listOf(entry("visible"), entry("hidden", "collaboration", null))), source.id)
        assertEquals(0L, Learning.summary(running.data.timeEntries, date, date.plusDays(1), zone, conflicts = running.conflicts).duration)
    }

    @Test fun oldFilesAndUnavailableTasksStayReadable() {
        val old = Json.decodeFromString<TodoData>("""{"version":1,"last_updated":"","todos":[]}""")
        assertTrue(learningViewData(old, source.id).data.timeEntries.isEmpty())
        assertTrue(learningViewData(old, source.id).data.dailyReviews.isEmpty())
        val missing = learningViewData(owner().copy(todos = emptyList(), timeEntries = listOf(entry("visible", end = null))), source.id)
        assertEquals("旧标签", Learning.resolveEntries(missing.data.timeEntries, missing.tasks).single().label_snapshot)
        assertEquals(1, Learning.summary(missing.data.timeEntries, date, date.plusDays(1), zone, conflicts = missing.conflicts).running)
        assertFalse(learningViewData(owner()).readOnly)
    }

    @Test fun savedButLostResponseRetryKeepsIdPayloadAndAllExtensions() = runBlocking {
        var remote = owner()
        val before = remote
        val todo = Todo.create("新增任务")
        val submitter = CollaborationSubmitter()
        val sent = mutableListOf<String>()
        submitter.create(source, todo)
        todo.content = "输入已修改"
        suspend fun send(): Boolean = submitter.send(source.id, { source }) { _, payload ->
            sent.add(Json.encodeToString(payload))
            remote = appendCollaborationTodo(remote, payload, time)
            if (sent.size == 1) throw IllegalStateException("响应丢失")
        }
        try { send(); fail("首次应超时") } catch (_: IllegalStateException) { }
        remote = remote.copy(todos = remote.todos.map { if (it.id == todo.id) it.copy(content = "分享者已修改", deleted = true) else it })
        assertTrue(send())
        assertEquals(sent[0], sent[1])
        assertEquals(1, remote.todos.count { it.id == todo.id })
        assertEquals("分享者已修改", remote.todos.last().content)
        assertTrue(remote.todos.last().deleted)
        assertEquals(before.timeEntries, remote.timeEntries)
        assertEquals(before.dailyReviews, remote.dailyReviews)
        assertEquals(before.reminderSettings, remote.reminderSettings)
        assertTrue(submitter.pending.value.isEmpty())
    }

    @Test fun retriesCannotChangeTargetAndMissingTargetIsRejected() = runBlocking {
        val submitter = CollaborationSubmitter()
        submitter.create(source, Todo.create("新增"))
        var writes = 0
        try {
            submitter.send(source.id, { source }) { _, _ -> writes++; throw IllegalStateException("未发送") }
            fail("应失败")
        } catch (_: IllegalStateException) { }
        for (target in listOf(null, source.copy(webdavFilepath = "another.json"))) {
            try { submitter.send(source.id, { target }) { _, _ -> writes++ }; fail("不能重定向") }
            catch (_: IllegalStateException) { }
        }
        assertEquals(1, writes)
        assertTrue(submitter.send(source.id, { source.copy(webdavPassword = "new-fake") }) { _, _ -> writes++ })
        assertEquals(2, writes)
    }

    @Test fun doubleClicksDoNotSendTwiceAndPersonalTargetRemainsAllowed() = runBlocking {
        val submitter = CollaborationSubmitter()
        val todo = Todo.create("新增")
        submitter.create(source, todo)
        var writes = 0
        submitter.send(source.id, { source }) { _, _ ->
            writes++
            assertFalse(submitter.send(source.id, { source }) { _, _ -> writes++ })
        }
        assertEquals(1, writes)
        // 权限针对目标判断，本机设置及个人保存不依赖当前展示页。
        requirePersonalTarget(false)
        try { requirePersonalTarget(true); fail("协作目标应拒绝修改") } catch (_: IllegalStateException) { }
    }
}
