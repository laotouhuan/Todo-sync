package com.todo.app.ui.view

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

internal enum class StatsTaskVisualStyle(val taskType: String, val filterKey: String, val label: String, val color: Color, val shape: String) {
    Normal(TaskType.NORMAL, "normal", "普通待办", Color(0xFF10B981), "circle"),
    Weekly(TaskType.WEEKLY_CHECKIN, "weekly", "每周打卡", Color(0xFF6366F1), "diamond"),
    Monthly(TaskType.MONTHLY_CHECKIN, "monthly", "每月打卡", Color(0xFFF43F5E), "star")
}

internal fun Todo.statsVisualStyle() = StatsTaskVisualStyle.entries.firstOrNull { it.taskType == taskType }
    ?: StatsTaskVisualStyle.Normal

internal fun DrawScope.drawStatsTaskMark(
    style: StatsTaskVisualStyle, center: Offset, radius: Float, alpha: Float = 1f,
    strokeWidth: Float = 1.dp.toPx(), subtask: Boolean = false
) {
    val outline = Stroke(strokeWidth)
    if (subtask) {
        drawCircle(style.color, radius, center, alpha, style = outline)
    } else if (style.shape == "circle") {
        drawCircle(style.color, radius, center, alpha)
        drawCircle(Color.White, radius, center, alpha, style = outline)
    } else {
        val star = style.shape == "star"
        val points = if (star) 10 else 4
        val path = Path().apply {
            repeat(points) { i ->
                val angle = i * 2 * PI / points - PI / 2
                val r = radius * (if (star && i % 2 == 1) .6f else if (star) 1.25f else 1.1f)
                val x = center.x + r * cos(angle).toFloat()
                val y = center.y + r * sin(angle).toFloat()
                if (i == 0) moveTo(x, y) else lineTo(x, y)
            }
            close()
        }
        drawPath(path, style.color, alpha)
        drawPath(path, Color.White, alpha, style = outline)
    }
}
