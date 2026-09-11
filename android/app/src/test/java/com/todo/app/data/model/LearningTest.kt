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
