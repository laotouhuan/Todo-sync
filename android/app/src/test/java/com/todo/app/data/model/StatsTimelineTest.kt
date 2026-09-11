package com.todo.app.data.model

import org.junit.Assert.*
import org.junit.Test
import java.time.*

class StatsTimelineTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val day = LocalDate.parse("2026-09-10")
    private val ref = TaskReference("task")
    @Test fun clockPositionsKeepSubsecondOrderAndMatchTimerBoundaries() {
        val middle = Instant.parse("2026-09-10T06:00:00Z")
        val before = middle.minusMillis(1)
        val after = middle.plusMillis(1)
        val a = StatsTimeline.clockMinute(before, zone)
        val b = StatsTimeline.clockMinute(middle, zone)
        val c = StatsTimeline.clockMinute(after, zone)
        assertTrue(a < b && b < c)
        assertEquals(840.0, b, 1e-9)
        assertEquals(1.0 / 60000, c - b, 1e-9)
        val arc = StatsTimeline.arcs(listOf(entry("precise", before.toString(), after.toString())), ref, "day", day, zone).single()
        assertEquals(a.toFloat(), arc.startMinute, 0f)
        assertEquals(c.toFloat(), arc.endMinute, 0f)
        assertEquals(0.0, StatsTimeline.clockMinute(Instant.parse("2026-09-10T16:00:00Z"), zone), 1e-9)
    }
    private fun entry(id: String, start: String = "2026-09-10T09:00:00+08:00", end: String? = "2026-09-10T10:30:00+08:00") =
        TimeEntry(id, ref, start, start, start, label_snapshot = "错字", ended_at = end)
    @Test fun labelsFollowCurrentTasksAndNeverRestoreSnapshots() {
        val a = Todo.create("A").copy(label = "数学习")
        val b = Todo.create("B").copy(label = "阅读", completed = true)
        assertEquals(listOf("数学习", "阅读"), Learning.availableLabels(listOf(a, b)))
        assertEquals(listOf("数学", "阅读"), Learning.availableLabels(listOf(a.copy(label = " 数学 "), b)))
        assertEquals(listOf("阅读"), Learning.availableLabels(listOf(a.copy(deleted = true), b)))
        assertEquals(listOf("é"), Learning.availableLabels(listOf(a.copy(label = "e\u0301"), b.copy(label = "é"))))
    }
    @Test fun mergedTaskLabelDrivesCandidatesAndChangeDetection() {
        val old = Todo.create("A").copy(id = "task", label = "数学习", updatedAt = "2026-09-10T01:00:00Z")
        val newer = old.copy(label = "数学", updatedAt = "2026-09-10T02:00:00Z")
        val local = TodoData(1, old.updatedAt, listOf(old))
        val remote = TodoData(1, newer.updatedAt, listOf(newer, old.copy(id = "other", label = "阅读")))
        val merged = MergeUtils.mergeTodoData(local, remote)
        assertEquals(listOf("数学", "阅读"), Learning.availableLabels(merged.todos))
        assertEquals(Learning.availableLabels(merged.todos), Learning.availableLabels(MergeUtils.mergeTodoData(remote, local).todos))
        assertTrue(MergeUtils.hasContentChanges(local, merged))
    }
    @Test fun historyAndExportUseCurrentLabelWithoutChangingRawData() {
        val raw = listOf(entry("a")); val todo = Todo.create("A").copy(id = "task", label = "阅读")
        assertEquals("阅读", Learning.resolveEntries(raw, mapOf(ref to todo)).single().label_snapshot)
        assertNull(Learning.resolveEntries(raw, mapOf(ref to todo.copy(label = null))).single().label_snapshot)
        assertEquals("错字", raw.single().label_snapshot)
        val data = TodoData(1, raw.single().updated_at, listOf(todo), timeEntries = raw)
        assertTrue(Learning.export(data, "day", day, zone = zone).second.contains("| 阅读 |"))
        assertEquals(5400000L, Learning.summary(raw, day, day.plusDays(1), zone).duration)
    }
    @Test fun missingTaskFallbackIsDeterministicAndSourceAware() {
        val a = entry("a"); val b = a.copy(id = "z", label_snapshot = "回退")
        assertEquals(listOf("回退", "回退"), Learning.resolveEntries(listOf(a, b), emptyMap()).map { it.label_snapshot })
        val todo = Todo.create("A").copy(id = "task", label = "当前", deleted = true)
        val collab = a.copy(id = "c", task_ref = TaskReference("task", "collaboration", "x"))
        assertEquals(listOf("当前", "错字"), Learning.resolveEntries(listOf(a, collab), mapOf(ref to todo)).map { it.label_snapshot })
    }
    @Test fun subtaskUsesOwnLocalDateAndDoesNotChangeProgress() {
        val todo = Todo.create("parent", date = "2030-01-01").copy(subtasks = listOf(
            Subtask("s", "子步骤", true, "2026-09-09T17:30:00Z"), Subtask("d", "补录", true, "2026-09-10"), Subtask("empty", "无时间", true)))
        val before = calculateStatsPeriodProgress(listOf(todo), "day", day)
        val events = StatsTimeline.subtasks(listOf(todo), "day", day, zone)
        assertEquals(2, events.size); assertEquals(day, events.first().date); assertNull(events.last().time)
        assertEquals(before, calculateStatsPeriodProgress(listOf(todo), "day", day))
        assertTrue(StatsTimeline.subtasks(listOf(todo.copy(deleted = true)), "day", day, zone).isEmpty())
    }
    @Test fun arcsHaveExactEndpointsAndCrossMidnightOnlyOncePerDay() {
        val a = StatsTimeline.arcs(listOf(entry("a")), ref, "day", day, zone).single()
        assertEquals(540f, a.startMinute, .001f); assertEquals(630f, a.endMinute, .001f)
        val e = entry("b", "2026-09-30T23:30:00+08:00", "2026-10-01T00:30:00+08:00")
        val sept = StatsTimeline.arcs(listOf(e), ref, "month", day, zone).single()
        val oct = StatsTimeline.arcs(listOf(e), ref, "month", LocalDate.parse("2026-10-01"), zone).single()
        assertEquals(1410f, sept.startMinute, .001f); assertEquals(1440f, sept.endMinute, .001f)
        assertEquals(0f, oct.startMinute, .001f); assertEquals(30f, oct.endMinute, .001f)
        assertEquals(3600000L, sept.part.duration + oct.part.duration)
        assertTrue(StatsTimeline.arcs(listOf(e.copy(ended_at = "2026-10-01T00:00:00+08:00")), ref, "month", LocalDate.parse("2026-10-01"), zone).isEmpty())
    }
    @Test fun clockOverlapOnDifferentDaysIsNotAConflict() {
        val a = entry("a"); val b = entry("b", "2026-09-11T09:00:00+08:00", "2026-09-11T10:30:00+08:00")
        val arcs = StatsTimeline.arcs(listOf(a, b), ref, "week", day, zone)
        assertEquals(2, StatsTimeline.hitArcs(arcs, 600f).size)
        assertTrue(StatsTimeline.arcs(listOf(a, a.copy(id = "conflict")), ref, "day", day, zone).isEmpty())
        listOf(a.copy(ended_at = null), a.copy(deleted = true), a.copy(ended_at = "bad"), a.copy(task_ref = TaskReference("task", "collaboration", "x"))).forEach {
            assertTrue(StatsTimeline.arcs(listOf(it), ref, "day", day, zone).isEmpty())
        }
    }
    @Test fun daylightSavingSegmentsKeepRealDuration() {
        val ny = ZoneId.of("America/New_York")
        val spring = entry("a", "2026-03-08T00:00:00-05:00", "2026-03-09T00:00:00-04:00")
        val s = StatsTimeline.arcs(listOf(spring), ref, "day", LocalDate.parse("2026-03-08"), ny)
        assertEquals(listOf(0f to 120f, 180f to 1440f), s.map { it.startMinute to it.endMinute })
        assertEquals(23 * 3600000L, s.first().part.duration)
        val fall = entry("b", "2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00")
        val f = StatsTimeline.arcs(listOf(fall), ref, "day", LocalDate.parse("2026-11-01"), ny)
        assertEquals(listOf(0f to 120f, 60f to 1440f), f.map { it.startMinute to it.endMinute })
        assertEquals(25 * 3600000L, f.first().part.duration)
    }
}
