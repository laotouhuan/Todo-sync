package com.todo.app.data.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import java.time.*

class LearningTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private fun entry(id: String, start: String, end: String?, label: String? = "数学") =
        TimeEntry(id, TaskReference("task"), start, start, end ?: start, "定理", label, end)

    private fun timingTodo(id: String) = Todo(id, "当前任务 $id", createdAt = "2026-09-01T00:00:00Z")
    private fun history(id: String, startedAt: String): TimeEntry =
        entry("record-$id-$startedAt", startedAt, Learning.instant(startedAt)!!.plusSeconds(60).toString())
            .copy(task_ref = TaskReference(id))

    @Test fun recentTasksFilterDeduplicateAndTakeFiveAfterSorting() {
        val todos = (0..7).map { timingTodo(it.toString()) }
        val records = todos.mapIndexed { i, todo -> history(todo.id, "2026-09-10T0$i:00:00Z") } +
            history("0", "2026-09-10T08:00:00Z") + history("0", "2026-09-10T09:00:00Z")
        assertEquals(listOf("0", "7", "6", "5", "4"), Learning.recentTimingTasks(todos, records, zone).map { it.todo.id })
        val filtered = todos.map { if (it.id == "0") it.copy(deleted = true) else if (it.id == "7") it.copy(completed = true) else it }
        assertEquals(listOf("6", "5", "4", "3", "2"), Learning.recentTimingTasks(filtered, records, zone).map { it.todo.id })
        assertEquals("当前任务 0", Learning.recentTimingTasks(todos, records, zone).first().todo.content)
        assertEquals(1, Learning.recentTimingTasks(todos.take(1), records, zone).size)
        assertTrue(Learning.recentTimingTasks(todos, emptyList(), zone).isEmpty())
        assertTrue(Learning.recentTimingTasks(emptyList(), records, zone).isEmpty())
        assertFalse(todos.first().deleted)
    }

    @Test fun recentTasksExcludeInvalidShortDeletedCollaborationAndMissingRecords() {
        val todos = listOf(timingTodo("a"), timingTodo("b"))
        val valid = history("a", "2026-09-10T01:00:00Z")
        val excluded = listOf(valid.copy(deleted = true), valid.copy(started_at = "bad"), valid.copy(ended_at = "bad"),
            valid.copy(ended_at = valid.started_at), valid.copy(ended_at = "2026-09-10T01:00:30Z"),
            valid.copy(started_at = "2026-02-30T01:00:00Z"),
            valid.copy(task_ref = TaskReference("a", "collaboration", "source")),
            valid.copy(task_ref = TaskReference("a", "personal", "source")),
            valid.copy(task_ref = TaskReference("missing")))
        assertTrue(Learning.recentTimingTasks(todos, excluded, zone).isEmpty())
        val newerShort = history("b", "2026-09-10T02:00:00Z").copy(ended_at = "2026-09-10T02:00:30Z")
        assertEquals(listOf("a"), Learning.recentTimingTasks(todos, listOf(valid, newerShort) + excluded, zone).map { it.todo.id })
        assertEquals(1, Learning.recentTimingTasks(todos, listOf(valid.copy(ended_at = "2026-09-10T01:00:30.001Z")), zone).size)
        assertTrue(Learning.recentTimingTasks(todos, listOf(valid, newerShort.copy(ended_at = null)), zone).isEmpty())
    }

    @Test fun recentTasksUseActualStartAndIdRatherThanUpdateTimeOrSnapshots() {
        val todos = listOf("a", "b", "c").map { timingTodo(it) }
        val records = listOf(history("b", "2026-09-10T10:00:00+08:00"), history("a", "2026-09-10T02:00:00Z"),
            history("c", "2026-09-10T03:00:00Z"))
        assertEquals(listOf("c", "a", "b"), Learning.recentTimingTasks(todos, records, zone).map { it.todo.id })
        val updated = records.map { it.copy(updated_at = "2026-10-01T00:00:00Z", task_content_snapshot = "旧名称") }
        assertEquals(listOf("c", "a", "b"), Learning.recentTimingTasks(todos, updated, zone).map { it.todo.id })
        val manual = history("b", "2026-09-10T04:00:00Z")
        assertEquals(listOf("b", "c", "a"), Learning.recentTimingTasks(todos, updated + manual, zone).map { it.todo.id })
        assertEquals(listOf("c", "a", "b"), Learning.recentTimingTasks(todos, updated + manual.copy(deleted = true), zone).map { it.todo.id })
        val edited = updated.map { if (it.task_ref.todo_id == "c") it.copy(started_at = "2026-09-10T00:00:00Z") else it }
        assertEquals(listOf("a", "b", "c"), Learning.recentTimingTasks(todos, edited, zone).map { it.todo.id })
        assertEquals("上次计时：今天 10:00", Learning.lastTimedText(Learning.instant(records[0].started_at)!!, LocalDate.parse("2026-09-10"), zone))
        assertEquals("上次计时：2026-09-10 10:00", Learning.lastTimedText(Learning.instant(records[0].started_at)!!, LocalDate.parse("2026-09-11"), zone))
    }

    @Test fun timingEligibilityCountsLocalPeriodsAndDoesNotTrustOrRewriteCompleted() {
        val weekly = timingTodo("week").copy(taskType = TaskType.WEEKLY_CHECKIN, date = "2026-W41", targetCount = 2,
            completed = true, completedDates = listOf("2026-10-04T16:30:00Z", "2026-10-06Tbad"))
        assertTrue(Learning.canTimeTodo(weekly, zone))
        assertTrue(weekly.completed)
        assertFalse(Learning.canTimeTodo(weekly.copy(completed = false, completedDates = weekly.completedDates + "2026-10-06"), zone))
        assertTrue(Learning.canTimeTodo(weekly.copy(targetCount = null), zone))
        val monthly = weekly.copy(taskType = TaskType.MONTHLY_CHECKIN, date = "2026-10", completedDates = listOf(
            "2026-09-30T16:30:00Z", "2026-09-30", "2026-10-01Tinvalid", "2026-10-99", "2026-10-01T12:99:00Z"))
        assertTrue(Learning.canTimeTodo(monthly, zone))
        assertFalse(Learning.canTimeTodo(monthly.copy(completedDates = monthly.completedDates + "2026-10-02T10:00:00+08:00"), zone))
        assertFalse(Learning.canTimeTodo(timingTodo("normal").copy(completed = true), zone))
        assertFalse(Learning.canTimeTodo(timingTodo("daily").copy(recurring = RecurringType.DAILY_REPEAT, completed = true), zone))
        assertFalse(Learning.canTimeTodo(weekly.copy(deleted = true), zone))
        val daily = timingTodo("new").copy(recurring = RecurringType.DAILY_REPEAT, content = "同名任务")
        assertTrue(Learning.recentTimingTasks(listOf(daily), listOf(history("old", "2026-09-10T01:00:00Z")), zone).isEmpty())
    }

    @Test fun shortTimersAreDiscardedAtThirtySecondsAndStayDeletedAfterSync() {
        val running = entry("short", "2026-09-18T23:59:45+08:00", null)
        for (duration in listOf(0L, 29999L, 30000L, 30001L, 60000L)) {
            val end = Learning.instant(running.started_at)!!.plusMillis(duration).toString()
            val finished = Learning.finishTimeEntry(running, end)
            assertEquals(duration <= 30000, finished.deleted)
            assertEquals(end, finished.ended_at)
            assertEquals(end, finished.updated_at)
            assertEquals(running.created_at, finished.created_at)
            assertNull(running.ended_at)
            for (merged in listOf(Learning.mergeTimes(listOf(running), listOf(finished)), Learning.mergeTimes(listOf(finished), listOf(running)))) {
                assertEquals(duration <= 30000, merged.single().deleted)
                val summary = Learning.summary(merged, LocalDate.parse("2026-09-18"), LocalDate.parse("2026-09-20"), zone)
                assertEquals(if (duration <= 30000) 0L else duration, summary.duration)
                assertEquals(0, summary.running)
                if (duration <= 30000) assertEquals(0, summary.count)
            }
        }
    }

    @Test fun finishingPreservesHistoryAndRejectsInvalidClocks() {
        val old = entry("old", "2026-09-18T00:00:00Z", "2026-09-18T00:00:01Z")
        assertEquals(old, Learning.finishTimeEntry(old, "2026-09-18T00:02:00Z"))
        val deleted = old.copy(ended_at = null, deleted = true)
        assertEquals(deleted, Learning.finishTimeEntry(deleted, "2026-09-18T00:02:00Z"))
        for (end in listOf("invalid", "2026-09-17T23:59:59Z")) {
            assertTrue(runCatching { Learning.finishTimeEntry(old.copy(ended_at = null), end) }.exceptionOrNull() is IllegalArgumentException)
        }
        assertTrue(runCatching { Learning.finishTimeEntry(old.copy(started_at = "invalid", ended_at = null), old.ended_at!!) }.isFailure)
    }

    @Test fun manualSaveChecksMinimumDurationButAllowsRunningEntries() {
        val start = Instant.parse("2026-09-18T00:00:00Z")
        val now = Instant.parse("2026-09-19T00:00:00Z")
        for (duration in listOf(1000L, 30000L, 30001L)) {
            val e = entry("manual", start.toString(), start.plusMillis(duration).toString())
            assertEquals(if (duration <= 30000) Learning.SHORT_TIME_ENTRY_MESSAGE else null, Learning.validate(e, emptyList(), now))
        }
        assertNull(Learning.validate(entry("running", start.toString(), null), emptyList(), now))
    }

    @Test fun crossMidnightCountsOnBothDays() {
        val e = entry("a", "2026-09-10T23:40:00+08:00", "2026-09-11T00:20:00+08:00")
        assertEquals(listOf(1200000L, 1200000L), Learning.split(e, zone).map { it.duration })
        val s = Learning.summary(listOf(e), LocalDate.parse("2026-09-07"), LocalDate.parse("2026-09-14"), zone)
        assertEquals(2, s.count); assertEquals(2400000L, s.duration)
        assertEquals(1, Learning.split(e.copy(ended_at = "2026-09-11T00:00:00+08:00"), zone).size)
        val midnight = e.copy(ended_at = "2026-09-11T00:00:00+08:00")
        assertEquals(0, Learning.summary(listOf(midnight, midnight.copy(id = "b")), LocalDate.parse("2026-09-11"), LocalDate.parse("2026-09-12"), zone).pending)
    }
    @Test fun localDaysIncludeDstAndLeapDay() {
        val e = entry("a", "2026-03-08T00:00:00-05:00", "2026-03-09T00:00:00-04:00")
        assertEquals(23 * 3600000L, Learning.split(e, ZoneId.of("America/New_York")).single().duration)
        assertEquals(2, Learning.split(entry("b", "2024-02-29T23:00:00+08:00", "2024-03-01T01:00:00+08:00"), zone).size)
        assertTrue(Learning.split(e.copy(ended_at = e.started_at), zone).isEmpty())
        assertTrue(Learning.split(e.copy(deleted = true), zone).isEmpty())
    }
    @Test fun overlappingRecordsAreExcludedWithoutChangingTimes() {
        val a = entry("a", "2026-09-10T09:00:00+08:00", "2026-09-10T10:00:00+08:00")
        val b = entry("b", a.ended_at!!, "2026-09-10T11:00:00+08:00", null)
        assertTrue(Learning.overlaps(listOf(a, b)).isEmpty())
        val active = b.copy(started_at = a.started_at, ended_at = null)
        val s = Learning.summary(listOf(a, active), LocalDate.parse("2026-09-10"), LocalDate.parse("2026-09-11"), zone)
        assertEquals(0, s.count); assertEquals(2, s.pending); assertNull(active.ended_at)
        assertNotNull(Learning.validate(active, listOf(a), Instant.parse("2026-09-11T00:00:00Z")))
        assertNotNull(Learning.validate(a.copy(ended_at = a.started_at), emptyList(), Instant.parse("2026-09-11T00:00:00Z")))
    }
    @Test fun dailyMergeUsesDateAndIsStableWithTombstones() {
        val a = DailyReview("a", "2026-09-10", "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z", fact = "旧")
        val b = a.copy(id = "b", fact = "新", updated_at = "2026-09-10T01:00:00Z")
        assertEquals(listOf(b), Learning.mergeReviews(listOf(a), listOf(b)))
        assertEquals(Learning.mergeReviews(listOf(a), listOf(b)), Learning.mergeReviews(listOf(b), listOf(a)))
        assertEquals(listOf(b), Learning.mergeReviews(listOf(b), listOf(b)))
        assertTrue(Learning.mergeReviews(listOf(b), listOf(b.copy(deleted = true))).single().deleted)
        val tied = b.copy(fact = "😀")
        assertEquals(Learning.mergeReviews(listOf(b), listOf(tied)), Learning.mergeReviews(listOf(tied), listOf(b)))
    }
    @Test fun oldSerializationAndActualMergeRetainLearningFields() {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val old = json.decodeFromString<TodoData>("""{"version":1,"last_updated":"2026-09-10T00:00:00Z","todos":[]}""")
        assertTrue(old.timeEntries.isEmpty()); assertTrue(old.dailyReviews.isEmpty())
        val e = entry("a", "2026-09-10T09:00:00+08:00", "2026-09-10T10:00:00+08:00")
        val r = DailyReview("r", "2026-09-10", old.last_updated, old.last_updated, fact = "理解了条件")
        val cloud = old.copy(timeEntries = listOf(e), dailyReviews = listOf(r))
        val merged = MergeUtils.mergeTodoData(old, cloud)
        assertEquals(listOf(e), merged.timeEntries); assertEquals(listOf(r), merged.dailyReviews)
        assertTrue(MergeUtils.hasContentChanges(old, merged))
        assertEquals(merged, json.decodeFromString<TodoData>(json.encodeToString(merged)))
        assertNull(Todo.create("旧任务").label)
    }
    @Test fun exportIncludesDailyStatisticsByDefaultAndKeepsText() {
        val r = DailyReview("r", "2026-09-10", "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z", fact = "第一行\n第二行\n第三行")
        val data = TodoData(1, r.updated_at, emptyList(), timeEntries = listOf(entry("a", "2026-09-10T23:40:00+08:00", "2026-09-11T00:20:00+08:00", "数学|证明")), dailyReviews = listOf(r))
        assertEquals("事实：第一行\n第二行", Learning.preview(r))
        val out = Learning.export(data, "week", LocalDate.parse(r.date), zone = zone)
        assertEquals("2026-09-07_2026-09-13-复盘.md", out.first)
        assertTrue(out.second.contains("数学\\|证明")); assertTrue(out.second.contains("当日未填写复盘"))
        assertTrue(out.second.contains("20 分钟，1 次"))
        val plain = Learning.export(data, "month", LocalDate.parse(r.date), false, zone).second
        assertFalse(plain.contains("学习投入")); assertFalse(plain.contains("2026-09-11"))
    }
    @Test fun labelsAndDurationsHaveCompatibleDefaults() {
        assertNull(Learning.label(" 未分类 ")); assertEquals("数学", Learning.label(" 数学 "))
        assertEquals("é", Learning.label("e\u0301")); assertEquals("25:01:01", Learning.duration(90061000L, true))
        assertEquals("59 秒", Learning.duration(59000L))
    }
}
