package com.todo.app.ui.view

import com.todo.app.data.model.*
import org.junit.Assert.assertEquals
import org.junit.Test

class ListSectionTest {
    @Test fun changingDatePreservesMarkerAndChangingTypeClearsIt() {
        for ((originalType, section, finalType) in listOf(
            Triple(TaskType.NORMAL, "today", TaskType.NORMAL),
            Triple(TaskType.NORMAL, "nodate", TaskType.NORMAL),
            Triple(TaskType.NORMAL, "week", TaskType.WEEKLY_CHECKIN),
            Triple(TaskType.WEEKLY_CHECKIN, "week", TaskType.WEEKLY_CHECKIN),
            Triple(TaskType.MONTHLY_CHECKIN, "month", TaskType.MONTHLY_CHECKIN),
            Triple(TaskType.WEEKLY_CHECKIN, "today", TaskType.NORMAL)
        )) {
            val task = Todo.create("旧任务", "2026-10-01").copy(taskType = originalType, recurring = RecurringType.DAILY_REPEAT)
            val result = resolveTaskForSection(section, task, "2026-10-08", "2026-W41", "2026-10")
            assertEquals(finalType, result.taskType)
            assertEquals(if (originalType == finalType) RecurringType.DAILY_REPEAT else RecurringType.NONE, result.recurring)
        }
    }
}
