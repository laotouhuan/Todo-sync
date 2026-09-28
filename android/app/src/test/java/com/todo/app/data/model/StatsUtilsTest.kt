package com.todo.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

class StatsUtilsTest {

    private fun healthTodo(
        name: String,
        createdAt: String,
        completed: Boolean = false,
        completedAt: String? = null,
        deleted: Boolean = false,
        taskType: String = TaskType.NORMAL,
        recurring: String = "none"
    ) = Todo.create(name).copy(
        createdAt = createdAt,
        completed = completed,
        completedAt = completedAt,
        deleted = deleted,
        taskType = taskType,
        recurring = recurring
    )

    @Test
    fun calculateHealthMetricsReturnsDefaultsForEmptyList() {
        assertEquals(
            HealthMetrics(),
            calculateHealthMetrics(emptyList(), Instant.parse("2026-09-10T12:00:00Z"), ZoneId.of("UTC"))
        )
    }

    @Test
    fun calculateHealthMetricsExcludesDeletedCheckinAndDailyRepeatTodos() {
        val now = Instant.parse("2026-09-10T12:00:00Z")
        val active = healthTodo("active", "2026-09-01T00:00:00Z")
        val excluded = listOf(
            healthTodo("deleted", "2026-08-01T00:00:00Z", deleted = true),
            healthTodo("weekly", "2026-08-01T00:00:00Z", taskType = TaskType.WEEKLY_CHECKIN),
            healthTodo("monthly", "2026-08-01T00:00:00Z", taskType = TaskType.MONTHLY_CHECKIN),
            healthTodo("daily", "2026-08-01T00:00:00Z", recurring = "daily_repeat")
        )

        val metrics = calculateHealthMetrics(listOf(active) + excluded, now, ZoneId.of("UTC"))

        assertEquals(9.0, metrics.currentAvgBacklogLife, 0.0)
        assertEquals(9.0, metrics.baselineAvgBacklogLife, 0.0)
        assertEquals(1, metrics.baselineSleepingCountVal)
    }

    @Test
    fun calculateHealthMetricsSeparatesCompletionsBeforeAndAfterLocalMidnight() {
        val beforeMidnight = healthTodo(
            "before", "2026-09-02T00:00:00Z", completed = true, completedAt = "2026-09-09T23:59:00Z"
        )
        val afterMidnight = healthTodo(
            "after", "2026-09-02T00:00:00Z", completed = true, completedAt = "2026-09-10T00:01:00Z"
        )

        val metrics = calculateHealthMetrics(
            listOf(beforeMidnight, afterMidnight),
            Instant.parse("2026-09-10T12:00:00Z"),
            ZoneId.of("UTC")
        )

        assertEquals(7.5, metrics.currentAvgCompletedLife, 0.0)
        assertEquals(7.0, metrics.baselineAvgCompletedLife, 0.0)
        assertEquals(8.0, metrics.baselineAvgBacklogLife, 0.0)
        assertEquals(1, metrics.baselineSleepingCountVal)
    }

    @Test
    fun calculateHealthMetricsUsesSuppliedZoneForLocalDayBoundary() {
        val beforeLocalMidnight = healthTodo("before", "2026-09-09T16:00:00Z")
        val afterLocalMidnight = healthTodo("after", "2026-09-10T16:10:00Z")

        val metrics = calculateHealthMetrics(
            listOf(beforeLocalMidnight, afterLocalMidnight),
            Instant.parse("2026-09-10T16:30:00Z"),
            ZoneId.of("Asia/Shanghai")
        )

        assertEquals(0.5, metrics.currentAvgBacklogLife, 0.0)
        assertEquals(1.0, metrics.baselineAvgBacklogLife, 0.0)
    }

    @Test
    fun calculateHealthMetricsPreservesDateOnlyAndMalformedTimestampFallbacks() {
        val dateOnlyCompletion = healthTodo(
            "date only", "2026-09-01T00:00:00Z", completed = true, completedAt = "2026-09-08"
        )
        val malformedCompletion = healthTodo(
            "malformed completion", "2026-09-01T00:00:00Z", completed = true, completedAt = "not-a-time"
        )
        val malformedCreation = healthTodo("malformed creation", "not-a-date")

        val metrics = calculateHealthMetrics(
            listOf(dateOnlyCompletion, malformedCompletion, malformedCreation),
            Instant.parse("2026-09-10T12:00:00Z"),
            ZoneId.of("UTC")
        )

        assertEquals(8.0, metrics.currentAvgCompletedLife, 0.0)
        assertEquals(7.0, metrics.baselineAvgCompletedLife, 0.0)
        assertEquals(9.0, metrics.baselineAvgBacklogLife, 0.0)
        assertEquals(-1.0, calculateHealthMetrics(
            listOf(malformedCreation), Instant.parse("2026-09-10T12:00:00Z"), ZoneId.of("UTC")
        ).currentAvgBacklogLife, 0.0)
    }

    @Test
    fun calculateHealthMetricsFallsBackToCurrentAveragesWhenBaselineHasNoSamples() {
        val todayTodo = healthTodo("today", "2026-09-10T01:00:00Z")
        val metrics = calculateHealthMetrics(
            listOf(todayTodo), Instant.parse("2026-09-10T12:00:00Z"), ZoneId.of("UTC")
        )

        assertEquals(metrics.currentAvgCompletedLife, metrics.baselineAvgCompletedLife, 0.0)
        assertEquals(metrics.currentAvgBacklogLife, metrics.baselineAvgBacklogLife, 0.0)
        assertEquals(0, metrics.baselineSleepingCountVal)
    }

    @Test
    fun calculateHealthMetricsCountsExactlySevenDaysAsSleeping() {
        val atThreshold = healthTodo("at threshold", "2026-09-03T00:00:00Z")
        val belowThreshold = healthTodo("below threshold", "2026-09-03T00:01:00Z")

        val metrics = calculateHealthMetrics(
            listOf(atThreshold, belowThreshold),
            Instant.parse("2026-09-10T12:00:00Z"),
            ZoneId.of("UTC")
        )

        assertEquals(1, metrics.baselineSleepingCountVal)
    }

    @Test
    fun testCalcTaskAgeDays() {
        val now = OffsetDateTime.parse("2026-06-15T12:00:00Z")
        
        // Exactly 5 days ago
        val age = calcTaskAgeDays("2026-06-10T12:00:00Z", now)
        assertEquals(5L, age)

        // Future -> 0
        val futureAge = calcTaskAgeDays("2026-06-20T12:00:00Z", now)
        assertEquals(0L, futureAge)

        // Invalid or null -> -1
        assertEquals(-1L, calcTaskAgeDays(null, now))
        assertEquals(-1L, calcTaskAgeDays("", now))
        assertEquals(-1L, calcTaskAgeDays("invalid", now))
    }

    @Test
    fun testGetHealthGrade() {
        assertEquals("A", getHealthGrade(Double.NaN).grade)
        assertEquals("A", getHealthGrade(0.0).grade)
        assertEquals("A", getHealthGrade(2.5).grade)
        assertEquals("B", getHealthGrade(5.0).grade)
        assertEquals("C", getHealthGrade(10.0).grade)
    }

    @Test
    fun testCalculateStreak() {
        val todos = listOf(
            Todo.create("A").apply { completed = true; completedAt = "2026-06-15T10:00:00Z" },
            Todo.create("B").apply { completed = true; completedAt = "2026-06-14T10:00:00Z" },
            Todo.create("C").apply { completed = true; completedAt = "2026-06-13T10:00:00Z" },
            Todo.create("D").apply { completed = true; completedAt = "2026-06-11T10:00:00Z" } // Gap on 12th
        )

        // Streak counting from 15th (today is 15th) -> 13, 14, 15 -> 3 days
        assertEquals(3, calculateStreak(todos, "2026-06-15"))

        // Streak counting from 16th (today is 16th, missed today but completed yesterday) -> 13, 14, 15 -> 3 days
        assertEquals(3, calculateStreak(todos, "2026-06-16"))

        // Streak counting from 17th (today is 17th, missed today and yesterday) -> 0
        assertEquals(0, calculateStreak(todos, "2026-06-17"))
    }

    @Test
    fun testCalculateBestStreak() {
        val todos = listOf(
            Todo.create("A").apply { completed = true; completedAt = "2026-06-15T10:00:00Z" },
            Todo.create("B").apply { completed = true; completedAt = "2026-06-14T10:00:00Z" },
            Todo.create("C").apply { completed = true; completedAt = "2026-06-13T10:00:00Z" },
            
            Todo.create("D").apply { completed = true; completedAt = "2026-06-10T10:00:00Z" },
            Todo.create("E").apply { completed = true; completedAt = "2026-06-09T10:00:00Z" },
            Todo.create("F").apply { completed = true; completedAt = "2026-06-08T10:00:00Z" },
            Todo.create("G").apply { completed = true; completedAt = "2026-06-07T10:00:00Z" } // Longest streak is 4
        )

        assertEquals(4, calculateBestStreak(todos))
    }

    @Test
    fun testCalculateCompletionStats() {
        val todayStr = "2026-06-15"
        val todos = listOf(
            Todo.create("Today 1", date = todayStr).apply { completed = true },
            Todo.create("Today 2", date = todayStr).apply { completed = false },
            Todo.create("Overdue", date = "2026-06-10").apply { completed = false }, // Overdue counts for today
            Todo.create("Future", date = "2026-06-20").apply { completed = false },  // Ignored
            Todo.create("Deleted", date = todayStr).apply { deleted = true }         // Ignored
        )

        val stats = calculateCompletionStats(todos, todayStr)
        assertEquals(1, stats.first) // completed
        assertEquals(3, stats.second) // total (Today 1, Today 2, Overdue)
    }

    @Test
    fun testStatsPeriodDateMatchingAcrossYearBoundary() {
        val target = LocalDate.of(2026, 1, 1)

        assertEquals(true, isDateInStatsPeriod("2025-12-29T08:00:00Z", "week", target))
        assertEquals(true, isDateInStatsPeriod("2026-01-01", "day", target))
        assertEquals(false, isDateInStatsPeriod("2026-01-08", "week", target))
        assertEquals(true, isDateInStatsPeriod("2026-01-31", "month", target))
    }

    @Test
    fun testTargetedCheckinTaskIsIncludedWithoutCheckin() {
        val target = LocalDate.of(2026, 9, 6)
        val weekly = Todo.create("Weekly", weekStringOf(target)).apply {
            taskType = TaskType.WEEKLY_CHECKIN
            targetCount = 3
        }

        assertEquals(true, weekly.isIncludedInStatsPeriod("week", target))
        assertEquals(false, weekly.isIncludedInStatsPeriod("day", target))
    }

    @Test
    fun testCollectCompletionEventsAndProgress() {
        val target = LocalDate.of(2026, 9, 6)
        val weekly = Todo.create("Weekly", weekStringOf(target)).apply {
            taskType = TaskType.WEEKLY_CHECKIN
            targetCount = 3
            completedDates = listOf(
                "2026-09-05",
                "2026-09-06T08:30:00Z",
                "2026-08-30T08:30:00Z"
            )
        }
        val normal = Todo.create("Normal", target.toString()).apply {
            completed = true
            completedAt = "2026-09-06T10:00:00Z"
        }

        val events = collectStatsCompletionEvents(listOf(weekly, normal), "week", target)
        assertEquals(3, events.size)
        assertEquals(2, events.count { it.hasExplicitTime })
        val progress = calculateStatsPeriodProgress(listOf(weekly, normal), "week", target)
        assertEquals(3.0, progress.completed, 0.0001)
        assertEquals(4.0, progress.total, 0.0001)
        assertEquals(0.75f, progress.fraction, 0.0001f)
        assertEquals("2026-09-06T08:30:00Z", weekly.latestCheckinInStatsPeriod("week", target))
    }

    @Test
    fun testNormalCompletionUsesLocalDateForPeriod() {
        val target = LocalDate.of(2026, 9, 6)
        val localCompletion = target.atTime(0, 30)
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toString()
        val normal = Todo.create("Normal", "2026-09-05").apply {
            completed = true
            completedAt = localCompletion
        }

        assertEquals(true, normal.isIncludedInStatsPeriod("day", target))
        assertEquals(1, collectStatsCompletionEvents(listOf(normal), "day", target).size)
    }
}
