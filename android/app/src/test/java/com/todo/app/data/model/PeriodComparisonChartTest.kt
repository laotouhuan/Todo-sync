package com.todo.app.data.model

import org.junit.Assert.*
import org.junit.Test
import java.time.*

class PeriodComparisonChartTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private fun time(value: String) = LocalDateTime.parse(value).atZone(zone)
    private fun result(parts: List<PeriodTimePart> = emptyList(), available: Boolean = true) =
        PeriodComparison(if (available) listOf(Todo.create("学习", "2026-W42")) else emptyList(), emptyList(), parts, 0)

    @Test fun dailyTotalsPreserveCrossMidnightAndMultipleEntries() {
        val r = result(listOf(
            PeriodTimePart(time("2026-10-12T23:30").toInstant(), time("2026-10-13T00:30").toInstant()),
            PeriodTimePart(time("2026-10-13T09:00").toInstant(), time("2026-10-13T10:00").toInstant())
        ))
        val now = time("2026-10-19T00:00")
        val days = PeriodComparisonChart.days(r, "2026-W42", now.toInstant(), now)
        assertEquals(7, days.size)
        assertEquals(1800000L, days[0].duration)
        assertEquals(5400000L, days[1].duration)
        assertEquals(0L, days[2].duration)
        assertEquals(r.duration, days.sumOf { it.duration ?: 0 })
    }

    @Test fun sameProgressClipsMatchingWeekdayAndKeepsExcludedDaysMissing() {
        val now = time("2026-10-17T10:30")
        val stop = PeriodComparisonChart.end("2026-W41", true, true, now)
        assertEquals(time("2026-10-10T10:30").toInstant(), stop)
        assertEquals(now.toInstant(), PeriodComparisonChart.end("2026-W42", true, true, now))
        val r = result(listOf(PeriodTimePart(time("2026-10-10T10:00").toInstant(), time("2026-10-10T11:00").toInstant())))
        val days = PeriodComparisonChart.days(r, "2026-W41", stop, now)
        assertEquals(1800000L, days[5].duration)
        assertEquals("未纳入", days[6].status); assertNull(days[6].duration)
        assertEquals("未到", PeriodComparisonChart.days(result(), "2026-W42", now.toInstant(), now)[6].status)
        assertEquals(time("2026-10-12T00:00").toInstant(), PeriodComparisonChart.end("2026-W41", false, true, now))
    }

    @Test fun shortMonthsLeapYearsAndYearBoundaryRemainCalendarBased() {
        val now = time("2026-03-31T10:00")
        assertEquals(time("2026-03-01T00:00").toInstant(), PeriodComparisonChart.end("2026-02", true, true, now))
        assertEquals(time("2026-02-01T00:00").toInstant(), PeriodComparisonChart.end("2026-01", true, false, now))
        assertEquals(28, PeriodComparisonChart.days(result(), "2026-02", now.toInstant(), now).size)
        assertEquals(29, PeriodComparisonChart.days(result(), "2024-02", now.toInstant(), now).size)
        assertEquals(31, PeriodComparisonChart.days(result(), "2026-03", now.toInstant(), now).size)
        assertEquals(time("2026-12-29T08:00").toInstant(), PeriodComparisonChart.end("2026-W53", true, true, time("2027-01-05T08:00")))
    }

    @Test fun missingZeroAndFutureDaysAreDifferent() {
        val now = time("2026-10-17T10:00")
        val missing = PeriodComparisonChart.days(result(available = false), "2026-W42", now.toInstant(), now)
        val zero = PeriodComparisonChart.days(result(), "2026-W42", now.toInstant(), now)
        assertNull(missing[0].duration); assertEquals("无数据", missing[0].status)
        assertEquals(0L, zero[0].duration); assertEquals("", zero[0].status)
        assertTrue(PeriodComparisonChart.days(result(), "2026-W43", now.toInstant(), now).all { it.duration == null && it.status == "未到" })
    }

    @Test fun daylightSavingDayUsesActualDuration() {
        val dst = ZoneId.of("America/New_York")
        val start = LocalDate.of(2026, 3, 8).atStartOfDay(dst)
        val end = start.plusDays(1)
        val now = end.plusDays(1)
        val r = result(listOf(PeriodTimePart(start.toInstant(), end.toInstant())))
        val days = PeriodComparisonChart.days(r, "2026-03", now.toInstant(), now)
        assertEquals(23 * 3600000L, days[7].duration)
        assertEquals(r.duration, days.sumOf { it.duration ?: 0 })
    }
}
