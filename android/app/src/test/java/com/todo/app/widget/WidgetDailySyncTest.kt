package com.todo.app.widget

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZonedDateTime

class WidgetDailySyncTest {
    @Test
    fun `按本地日期安排下一天午夜并支持跨年`() {
        assertNext("2026-12-31T23:59:59+08:00[Asia/Shanghai]",
            "2027-01-01T00:00:00+08:00[Asia/Shanghai]")
    }

    @Test
    fun `午夜执行后安排第二天而非立即重复`() {
        assertNext("2026-09-27T00:00:00+08:00[Asia/Shanghai]",
            "2026-09-28T00:00:00+08:00[Asia/Shanghai]")
    }

    @Test
    fun `夏令时切换按日历午夜计算而非加二十四小时`() {
        assertNext("2026-03-08T00:00:00-05:00[America/New_York]",
            "2026-03-09T00:00:00-04:00[America/New_York]")
        assertNext("2026-11-01T00:00:00-04:00[America/New_York]",
            "2026-11-02T00:00:00-05:00[America/New_York]")
    }

    private fun assertNext(now: String, expected: String) {
        assertEquals(ZonedDateTime.parse(expected).toInstant().toEpochMilli(),
            nextWidgetMidnight(ZonedDateTime.parse(now)))
    }
}
