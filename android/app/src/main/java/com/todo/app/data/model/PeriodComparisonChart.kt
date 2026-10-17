package com.todo.app.data.model

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZonedDateTime

data class PeriodComparisonDay(val date: LocalDate, val duration: Long?, val status: String)

object PeriodComparisonChart {
    // 周按星期、月按日号对齐；短月截到月末，当前周期不计未来时刻。
    fun end(period: String, sameProgress: Boolean, hasCurrentPeriod: Boolean, now: ZonedDateTime): Instant {
        val range = requireNotNull(TaskSeriesLogic.range(period))
        val end = range.second.atStartOfDay(now.zone).toInstant()
        val cutoff = if (!sameProgress || !hasCurrentPeriod) end else {
            val date = if (period.contains("-W")) range.first.plusDays((now.dayOfWeek.value - 1).toLong())
            else YearMonth.from(range.first).let { month ->
                if (now.dayOfMonth > month.lengthOfMonth()) range.second else month.atDay(now.dayOfMonth)
            }
            date.atTime(now.toLocalTime()).atZone(now.zone).toInstant()
        }
        return minOf(end, cutoff, now.toInstant())
    }

    fun days(result: PeriodComparison, period: String, end: Instant, now: ZonedDateTime): List<PeriodComparisonDay> {
        val range = requireNotNull(TaskSeriesLogic.range(period))
        return generateSequence(range.first) { it.plusDays(1) }.takeWhile { it < range.second }.map { date ->
            val start = date.atStartOfDay(now.zone).toInstant()
            val stop = minOf(date.plusDays(1).atStartOfDay(now.zone).toInstant(), end)
            val status = when {
                date > now.toLocalDate() -> "未到"
                start >= end -> "未纳入"
                !result.available -> "无数据"
                else -> ""
            }
            val duration = if (status.isNotEmpty()) null else result.parts.sumOf { part ->
                Duration.between(maxOf(start, part.start), minOf(stop, part.end)).toMillis().coerceAtLeast(0)
            }
            PeriodComparisonDay(date, duration, status)
        }.toList()
    }
}
