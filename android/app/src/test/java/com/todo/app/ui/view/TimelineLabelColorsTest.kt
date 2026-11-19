package com.todo.app.ui.view

import androidx.compose.ui.graphics.Color
import com.todo.app.data.model.TaskReference
import com.todo.app.data.model.TimeEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class TimelineLabelColorsTest {
    @Test
    fun assignsFiveDistinctColorsBeforeReusingAndIgnoresOtherSources() {
        val source = TaskReference("task")
        fun entry(id: String, label: String?): TimeEntry {
            val start = "2026-09-10T09:00:00+08:00"
            return TimeEntry(id, source, start, start, start,
                label_snapshot = label, ended_at = "2026-09-10T10:30:00+08:00")
        }
        val records = listOf("A", "F", "K", "P", "U", "Z").map { entry(it, it) } + listOf(
            entry("deleted", "0").copy(deleted = true),
            entry("running", "1").copy(ended_at = null),
            entry("other", "2").copy(task_ref = TaskReference("task", "collaboration", "x")),
            entry("overlap", "3"),
            entry("unclassified", null)
        )
        val conflicts = setOf("overlap")
        val expected = mapOf(
            "A" to Color(0xFF2593A7), "F" to Color(0xFF8F77D8), "K" to Color(0xFFB5832F),
            "P" to Color(0xFFC96889), "U" to Color(0xFF4E996C), "Z" to Color(0xFF2593A7)
        )
        assertEquals(expected, timerLabelColors(records, source, conflicts))
        assertEquals(expected, timerLabelColors(records.reversed(), source, conflicts))
    }
}
