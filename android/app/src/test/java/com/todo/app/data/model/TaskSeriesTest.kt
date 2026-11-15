package com.todo.app.data.model

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import java.time.*
import java.io.File

class TaskSeriesTest {
    private fun seriesConflictFixture(domain: String): JsonObject {
        val relative = "tests/fixtures/$domain/conflicts.json"
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, relative) }.first { it.isFile }
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test fun linkConflictsMatchWindowsAtMillisecondPrecision() {
        val fixture = seriesConflictFixture("series-links")
        val base = fixture.getValue("base").jsonObject
        for (row in fixture.getValue("cases").jsonArray) {
            val sample = row.jsonObject
            fun link(key: String): TaskSeriesLink =
                Json.decodeFromJsonElement(JsonObject(base + sample.getValue(key).jsonObject))
            val a = link("a")
            val b = link("b")
            val expected = link(sample.getValue("winner").jsonPrimitive.content)
            val name = sample.getValue("id").jsonPrimitive.content
            fun data(link: TaskSeriesLink) = TodoData(1, now, emptyList(), taskSeriesLinks = listOf(link))
            assertEquals(name, listOf(expected), MergeUtils.mergeTodoData(data(a), data(b)).taskSeriesLinks)
            assertEquals(name, listOf(expected), MergeUtils.mergeTodoData(data(b), data(a)).taskSeriesLinks)
        }
    }

    @Test fun nameConflictsMatchWindowsAtMillisecondPrecision() {
        val fixture = seriesConflictFixture("series-names")
        val base = fixture.getValue("base").jsonObject
        for (row in fixture.getValue("cases").jsonArray) {
            val sample = row.jsonObject
            fun series(key: String): TaskSeries =
                Json.decodeFromJsonElement(JsonObject(base + sample.getValue(key).jsonObject))
            val a = series("a")
            val b = series("b")
            val deletion = sample.getValue("deleted_at")
            val deletedAt = if (deletion == JsonNull) null else deletion.jsonPrimitive.content
            val expected = series(sample.getValue("winner").jsonPrimitive.content)
                .copy(deleted = deletedAt != null, deleted_at = deletedAt)
            val name = sample.getValue("id").jsonPrimitive.content
            fun data(series: TaskSeries) = TodoData(1, now, emptyList(), taskSeries = listOf(series))
            assertEquals(name, listOf(expected), MergeUtils.mergeTodoData(data(a), data(b)).taskSeries)
            assertEquals(name, listOf(expected), MergeUtils.mergeTodoData(data(b), data(a)).taskSeries)
        }
    }

    @Test fun summaryCountsPeriodsAndOnlyUnlinkedSameTypeNames() {
        val base = continued(); val current = base.todos.last()
        assertTrue(TaskSeriesLogic.associationSummary(base, current.id).unlinkedSameName.isEmpty())
        val other = todo("2026-W39").copy(content = "  抽象代数  ")
        val data = base.copy(todos = listOf(current, other, todo("2026-09").copy(taskType = TaskType.MONTHLY_CHECKIN), todo().copy(deleted = true)))
        val summary = TaskSeriesLogic.associationSummary(data, current.id)
        assertEquals(listOf("2026-W41", "2026-W42"), summary.periods)
        assertEquals(1, summary.sameNameCount); assertEquals(listOf(other), summary.unlinkedSameName)
        assertNull(TaskSeriesLogic.associationSummary(data, other.id).series)
        val repeated = data.copy(taskSeriesLinks = data.taskSeriesLinks + data.taskSeriesLinks.first().copy(todo_id = java.util.UUID.randomUUID().toString()))
        assertEquals(2, TaskSeriesLogic.associationSummary(repeated, current.id).periods.size)
    }
    @Test fun longTermWeeklyAndMonthlyImportsKeepIdentityAndCurrentName() {
        for ((type, periods, firstTime) in listOf(
            Triple(TaskType.WEEKLY_CHECKIN, listOf("2026-W40", "2026-W41", "2026-W42"), "2026-10-08T12:00:00+08:00"),
            Triple(TaskType.MONTHLY_CHECKIN, listOf("2026-08", "2026-09", "2026-10"), "2026-09-15T12:00:00+08:00")
        )) {
            val base = initial().copy(todos = listOf(todo(periods[0]).copy(taskType = type)))
            val linked = TaskSeriesLogic.import(base, base.todos, periods[1], firstTime)
            val s = linked.taskSeries.single().copy(content = "长期任务新名称", content_renamed = true, content_updated_at = firstTime)
            val independent = todo(periods[2]).copy(taskType = type, content = s.content)
            val data = linked.copy(taskSeries = listOf(s), todos = linked.todos + independent, timeEntries = listOf(timer(linked.todos.first())))
            val result = TaskSeriesLogic.import(data, listOf(data.todos.first()), periods[2], now)
            val imported = result.todos.last()
            assertEquals(s.id, TaskSeriesLogic.series(result, imported.id)?.id)
            assertEquals(s.content, imported.content); assertEquals(1, result.taskSeries.size)
            assertEquals(3, TaskSeriesLogic.associationSummary(result, imported.id).periods.size)
            assertNull(TaskSeriesLogic.series(result, independent.id))
            assertEquals(data.todos, result.todos.dropLast(1)); assertEquals(data.timeEntries, result.timeEntries)
            assertTrue(runCatching { TaskSeriesLogic.import(result, listOf(data.todos.first()), periods[2], now) }.isFailure)
        }
    }
    @Test fun unlinkScopePreservesRecordsAndRejectsChangedMembership() {
        val base = continued(); val current = base.todos.last()
        val data = base.copy(todos = listOf(current, todo("2026-W39")), timeEntries = listOf(timer(base.todos.first())))
        val one = TaskSeriesLogic.unlinkPeriods(data, TaskSeriesLogic.unlinkPreview(data, current.id), now)
        assertEquals(1, one.taskSeriesLinks.count { !it.deleted })
        val preview = TaskSeriesLogic.unlinkPreview(data, current.id, true)
        val all = TaskSeriesLogic.unlinkPeriods(data, preview, now)
        assertTrue(all.taskSeriesLinks.all { it.deleted && it.next_series_id != null })
        assertEquals(2, all.taskSeriesLinks.map { it.next_series_id }.distinct().size)
        assertEquals(data.todos, all.todos); assertEquals(data.timeEntries, all.timeEntries); assertEquals(data.taskSeries, all.taskSeries)
        assertTrue(TaskSeriesLogic.merge(data, all).second.all { it.deleted })
        val changed = data.copy(taskSeriesLinks = data.taskSeriesLinks + data.taskSeriesLinks.first().copy(todo_id = java.util.UUID.randomUUID().toString(), period = "2026-W39"))
        assertTrue(runCatching { TaskSeriesLogic.unlinkPeriods(changed, preview, now) }.isFailure)
        assertTrue(changed.taskSeriesLinks.none { it.deleted })
    }
    @Test fun comparisonClipsCrossPeriodAndIgnoresForeignReferences() {
        val base = continued(); val source = base.todos.first(); val id = base.taskSeries.single().id
        val cross = timer(source).copy(started_at = "2026-10-11T23:30:00+08:00", ended_at = "2026-10-12T00:30:00+08:00")
        val foreign = cross.copy(id = "foreign", task_ref = TaskReference(source.id, "collaboration", "remote"), started_at = "2026-10-12T01:00:00+08:00", ended_at = "2026-10-12T02:00:00+08:00")
        val data = base.copy(timeEntries = listOf(cross, foreign))
        val zone = ZoneId.of("Asia/Shanghai")
        val a = TaskSeriesLogic.compare(data, id, "2026-W41", zone = zone)
        val b = TaskSeriesLogic.compare(data, id, "2026-W42", zone = zone)
        assertEquals(1800000L, a.duration); assertEquals(1800000L, b.duration)
        assertEquals(3600000L, a.duration + b.duration)
        assertEquals(900000L, TaskSeriesLogic.compare(data, id, "2026-W42", Instant.parse("2026-10-11T16:15:00Z"), zone).duration)
        assertFalse(TaskSeriesLogic.compare(data, id, "2026-W40", zone = zone).available)
        assertEquals("旧名称", LearningViewData(data, emptySet()).display(foreign))
        val pending = cross.copy(id = "pending", started_at = "2026-10-12T03:00:00+08:00", ended_at = null)
        assertEquals(1, TaskSeriesLogic.compare(data.copy(timeEntries = data.timeEntries + pending), id, "2026-W42", zone = zone).pending)
    }
    private val now = "2026-10-15T12:00:00+08:00"
    private fun todo(period: String = "2026-W41") = Todo.create("抽象代数", period).copy(taskType = TaskType.WEEKLY_CHECKIN,
        createdAt = "2026-10-01T09:00:00+08:00", updatedAt = now, targetCount = 5, time = "17:30")
    private fun initial() = TodoData(1, now, listOf(todo()), dailyReviews = listOf(DailyReview("r", "2026-10-15", now, now, fact = "保留复盘")))
    private fun continued(): TodoData { val d = initial(); return TaskSeriesLogic.import(d, d.todos, "2026-W42", now) }
    private fun timer(todo: Todo, id: String = "timer", end: String? = "2026-10-15T12:00:30+08:00") =
        TimeEntry(id, TaskReference(todo.id), "2026-10-15T11:59:50+08:00", now, now, "旧名称", ended_at = end)

    @Test fun oldFilesDefaultCollectionsAndNewMembersValidate() {
        val old = Json.decodeFromString<TodoData>("""{"version":1,"last_updated":"$now","todos":[]}""")
        assertTrue(old.taskSeries.isEmpty()); assertTrue(old.taskSeriesLinks.isEmpty())
        assertTrue(runCatching { Json.decodeFromString<TodoData>("""{"version":1,"last_updated":"$now","todos":[],"task_series":null}""") }.isFailure)
        assertNull(TaskSeriesLogic.range("2025-W53")); assertNotNull(TaskSeriesLogic.range("2026-W53")); assertNull(TaskSeriesLogic.range("2026-13"))
        val data = continued(); val encoded = Json { encodeDefaults = true }.encodeToString(data)
        assertEquals(data, Json.decodeFromString<TodoData>(encoded))
        assertTrue(runCatching { TaskSeriesLogic.validate(data.copy(taskSeries = data.taskSeries.map { it.copy(deleted_at = "无效") })) }.isFailure)
        assertTrue(runCatching { TaskSeriesLogic.validate(data.copy(taskSeries = data.taskSeries.map { it.copy(content_updated_at = "无效") })) }.isFailure)
    }
    @Test fun importKeepsSourceAndDefaultsButDeduplicatesIdentityNotName() {
        val base = initial(); val result = TaskSeriesLogic.import(base, base.todos, "2026-W42", now)
        assertEquals(base.todos.first(), result.todos.first()); assertEquals(base.dailyReviews, result.dailyReviews)
        assertEquals(2, result.taskSeriesLinks.size); assertEquals("17:30", result.todos.last().time)
        assertTrue(result.todos.last().completedDates.isEmpty()); assertFalse(result.todos.last().completed)
        assertTrue(runCatching { TaskSeriesLogic.import(result, listOf(result.todos.first()), "2026-W42", now) }.isFailure)
        val independent = base.copy(todos = base.todos + todo("2026-W42"))
        assertEquals(3, TaskSeriesLogic.import(independent, listOf(base.todos.first()), "2026-W42", now).todos.size)
    }
    @Test fun concurrentImportsKeepDuplicatesAndDisallowDefaultReference() {
        val base = initial(); val a = TaskSeriesLogic.import(base, base.todos, "2026-W42", now); val b = TaskSeriesLogic.import(base, base.todos, "2026-W42", now)
        val merged = MergeUtils.mergeTodoData(a, b)
        assertEquals(3, merged.todos.size); assertEquals(1, merged.taskSeries.size)
        assertTrue(TaskSeriesLogic.timingTodos(merged, LocalDate.of(2026, 10, 15)).isEmpty())
        assertNull(TaskSeriesLogic.candidates(merged, "week", LocalDate.of(2026, 10, 21)).single().reference)
    }
    @Test fun explicitRenameWinsInitializationAndDeletionRegardlessOfMergeDirection() {
        val base = continued()
        val a = base.copy(taskSeries = base.taskSeries.map { it.copy(content = "新名称", content_renamed = true, content_updated_at = "2026-10-15T10:00:00+08:00") })
        val b = base.copy(taskSeries = base.taskSeries.map { it.copy(content = "离线旧名称", content_updated_at = "2026-10-15T13:00:00+08:00", updated_at = "2026-10-15T13:00:00+08:00") })
        val c = base.copy(taskSeries = base.taskSeries.map { it.copy(deleted = true, deleted_at = now) })
        val ab = TaskSeriesLogic.merge(a, b)
        assertEquals(ab, TaskSeriesLogic.merge(b, a)); assertEquals("新名称", ab.first.single().content)
        val equivalent = a.copy(taskSeries = a.taskSeries.map { it.copy(content_updated_at = "2026-10-15T02:00:00Z") })
        assertEquals(TaskSeriesLogic.merge(a, equivalent), TaskSeriesLogic.merge(equivalent, a))
        val abc = TaskSeriesLogic.merge(base.copy(taskSeries = ab.first, taskSeriesLinks = ab.second), c)
        val ac = TaskSeriesLogic.merge(a, c)
        assertEquals(abc, TaskSeriesLogic.merge(base.copy(taskSeries = ac.first, taskSeriesLinks = ac.second), b))
        assertTrue(abc.first.single().deleted)
        assertEquals(abc, TaskSeriesLogic.merge(base.copy(taskSeries = abc.first, taskSeriesLinks = abc.second), a))
    }
    @Test fun unlinkReservesStableNewIdentity() {
        val base = continued(); val id = base.todos.first().id; val unlinked = TaskSeriesLogic.unlink(base, id, now)
        val reserved = unlinked.taskSeriesLinks.first { it.todo_id == id }.next_series_id
        assertEquals(unlinked, TaskSeriesLogic.unlink(unlinked, id, now))
        val imported = TaskSeriesLogic.import(unlinked, listOf(unlinked.todos.first()), "2026-W42", now)
        assertEquals(reserved, TaskSeriesLogic.series(imported, id)?.id); assertNotEquals(base.taskSeries.single().id, reserved)
    }
    @Test fun associationMovesArchivedLinksAndPreservesTimerReferences() {
        val base = continued(); val archived = base.todos.first(); val other = todo("2026-W40").copy(content = "历史名称")
        val data = base.copy(todos = listOf(base.todos.last(), other), timeEntries = listOf(timer(archived)))
        val selected = data.todos.map { it.id }.toSet(); val preview = TaskSeriesLogic.preview(data, other.id, selected)
        val result = TaskSeriesLogic.associate(data, preview, selected, now)
        assertEquals(TaskSeriesLogic.series(result, other.id)?.id, TaskSeriesLogic.series(result, archived.id)?.id)
        assertEquals(archived.id, result.timeEntries.single().task_ref.todo_id)
        val duplicate = data.copy(todos = data.todos + todo("2026-W42")); val ids = duplicate.todos.map { it.id }.toSet()
        assertTrue(runCatching { TaskSeriesLogic.associate(duplicate, TaskSeriesLogic.preview(duplicate, other.id, ids), ids, now) }.isFailure)
    }
    @Test fun deleteStopsOnlyConfirmedTimersAndPurgeDoesNotRestartPendingRecord() {
        val base = continued(); val task = base.todos.last(); val known = timer(task, "known", null)
        val before = base.copy(timeEntries = listOf(known)); val preview = TaskSeriesLogic.deletion(before, task.id)
        val late = timer(task, "late", null); val deleted = TaskSeriesLogic.delete(before.copy(timeEntries = before.timeEntries + late), preview, now)
        assertEquals(now, deleted.timeEntries.first { it.id == "known" }.ended_at); assertFalse(deleted.timeEntries.first { it.id == "known" }.deleted)
        assertNull(deleted.timeEntries.first { it.id == "late" }.ended_at); assertTrue(TaskSeriesLogic.pending(deleted, late)!!.contains("已删除"))
        val purged = deleted.copy(todos = deleted.todos.filterNot { it.id == task.id })
        assertTrue(TaskSeriesLogic.pending(purged, late)!!.contains("不可用"))
        assertNull(TaskSeriesLogic.pending(purged, late.copy(task_ref = TaskReference(task.id, "collaboration", "remote"))))
        val real = late.copy(ended_at = "2026-10-15T12:00:30+08:00", updated_at = "2026-10-15T12:00:30+08:00")
        assertEquals(real.ended_at, MergeUtils.mergeTodoData(purged, purged.copy(timeEntries = listOf(real))).timeEntries.first { it.id == "late" }.ended_at)
    }
    @Test fun ordinaryDeletionAndWholeSeriesDeletionKeepIndependentTaskAndShortTimer() {
        val base = continued(); val independent = todo().copy(taskType = TaskType.NORMAL, date = null)
        val data = base.copy(todos = base.todos + independent, timeEntries = listOf(timer(independent, end = null)))
        val deleted = TaskSeriesLogic.delete(data, TaskSeriesLogic.deletion(data, data.todos.first().id, true), now)
        assertFalse(deleted.todos.first { it.id == independent.id }.deleted); assertNull(deleted.timeEntries.single().ended_at)
        val one = TaskSeriesLogic.delete(deleted, TaskSeriesLogic.deletion(deleted, independent.id), now)
        assertEquals(now, one.timeEntries.single().ended_at); assertFalse(one.timeEntries.single().deleted)
    }
    @Test fun editPreservesLatestNameButBlocksArrayConflictsWithoutMutation() {
        val base = continued(); val task = base.todos.last()
        val renamed = base.copy(taskSeries = base.taskSeries.map { it.copy(content = "同步新名", content_renamed = true) })
        val result = TaskSeriesLogic.edit(renamed, base, task.copy(targetCount = 8), now)
        assertEquals("同步新名", TaskSeriesLogic.display(result, task.id)); assertEquals(8, result.todos.last().targetCount)
        val newName = TaskSeriesLogic.edit(base, base, task.copy(content = "改名"), now)
        assertEquals(base.todos, newName.todos)
        assertTrue(newName.taskSeries.single().content_renamed)
        assertTrue(TaskSeriesLogic.visible(newName).all { it.content == "改名" })
        val independent = todo()
        val unrelated = newName.copy(todos = newName.todos + independent)
        assertEquals(independent.content, TaskSeriesLogic.display(unrelated, independent.id))
        val changed = base.copy(todos = base.todos.map { if (it.id == task.id) it.copy(completedDates = listOf("2026-10-13")) else it })
        assertTrue(runCatching { TaskSeriesLogic.edit(changed, base, task.copy(completedDates = listOf("2026-10-14")), now) }.isFailure)
        assertEquals(listOf("2026-10-13"), changed.todos.last().completedDates)
    }
    @Test fun resolvedEntriesUseCurrentNameWithoutChangingSnapshotAndPendingIsNotRunning() {
        val base = continued(); val e = timer(base.todos.first()); val renamed = base.copy(taskSeries = base.taskSeries.map { it.copy(content = "统一新名") })
        val tasks = renamed.todos.associateBy { TaskReference(it.id) }
        assertEquals("统一新名", Learning.resolveEntries(listOf(e), tasks, renamed).single().display_content); assertEquals("旧名称", e.task_content_snapshot)
        val missing = e.copy(ended_at = null, task_ref = TaskReference(java.util.UUID.randomUUID().toString()))
        val resolved = Learning.resolveEntries(listOf(missing), tasks, renamed)
        val summary = Learning.summary(resolved, LocalDate.of(2026, 10, 15), LocalDate.of(2026, 10, 16), ZoneId.of("Asia/Shanghai"))
        assertEquals(1, summary.pending); assertEquals(0, summary.running)
        val foreign = missing.copy(task_ref = TaskReference(missing.task_ref.todo_id, "collaboration", "remote"))
        assertNull(LearningViewData(renamed, emptySet()).pending(foreign))
        assertNotNull(LearningViewData(renamed, emptySet(), "remote").pending(foreign))
        val pendingData = renamed.copy(timeEntries = listOf(missing), dailyReviews = listOf(DailyReview("review", "2026-10-15", now, now, fact = "核对记录")))
        val exported = Learning.export(pendingData, "day", LocalDate.of(2026, 10, 15), zone = ZoneId.of("Asia/Shanghai")).second
        assertTrue(exported.contains("1 条待核对记录未计入")); assertFalse(exported.contains("条进行中记录未计入"))
    }
}
