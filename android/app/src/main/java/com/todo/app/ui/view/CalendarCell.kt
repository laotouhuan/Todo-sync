package com.todo.app.ui.view

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private val CalendarCellShape = RoundedCornerShape(4.dp)

@Composable
internal fun Modifier.calendarCell(
    today: Boolean,
    inRange: Boolean = true,
    fill: Color = Color.Unspecified,
    selected: Boolean = false
): Modifier {
    val colors = MaterialTheme.colorScheme
    val backgroundColor = if (fill != Color.Unspecified) fill
        else colors.surfaceVariant.copy(alpha = if (inRange) 0.4f else 0.15f)
    val borderColor = when {
        today -> Color(0xFFFAAD14)
        selected -> colors.primary
        else -> colors.outline.copy(alpha = if (inRange) 0.2f else 0.05f)
    }
    return clip(CalendarCellShape)
        .background(backgroundColor)
        .border(if (today || selected) 2.dp else 0.5.dp, borderColor, CalendarCellShape)
}
