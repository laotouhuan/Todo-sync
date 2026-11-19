package com.todo.app.ui.view

import androidx.compose.ui.graphics.Color
import com.todo.app.data.model.Learning
import com.todo.app.data.model.TaskReference
import com.todo.app.data.model.TimeEntry

// 按本地时间从午夜起排列，钟面和纵向时间线共用。
internal object TimeSlotColors {
    val night = Color(0xFF3B82F6)
    val morning = Color(0xFFF59E0B)
    val afternoon = Color(0xFF7B61FF)
    val evening = Color(0xFF6366F1)
    val chronological = listOf(night, morning, afternoon, evening)
}

// 与 Windows 使用相同色板和 UTF-16 标签顺序。
private val timerPalette = listOf(
    Color(0xFF2593A7), Color(0xFF8F77D8), Color(0xFFB5832F), Color(0xFFC96889), Color(0xFF4E996C)
)
internal val unclassifiedTimerColor = Color(0xFF858899)

internal fun timerLabelColors(
    resolvedEntries: List<TimeEntry>,
    source: TaskReference,
    conflicts: Set<String>
): Map<String, Color> {
    val labels = resolvedEntries.asSequence().filter { entry ->
        !entry.deleted && entry.id !in conflicts && entry.label_snapshot != null &&
            entry.task_ref.source_type == source.source_type && entry.task_ref.source_id == source.source_id
    }.mapNotNull { entry ->
        val start = Learning.instant(entry.started_at)
        val end = Learning.instant(entry.ended_at)
        entry.label_snapshot?.takeIf { start != null && end != null && end > start }
    }.toSortedSet()

    val used = mutableSetOf<Int>()
    return labels.associateWith { label ->
        var index = Math.floorMod(label.hashCode(), timerPalette.size)
        if (used.size < timerPalette.size) {
            while (index in used) index = (index + 1) % timerPalette.size
            used.add(index)
        }
        timerPalette[index]
    }
}
