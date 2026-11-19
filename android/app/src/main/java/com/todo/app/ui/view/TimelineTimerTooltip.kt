package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import com.todo.app.data.model.Learning
import com.todo.app.data.model.TimerArc
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
private fun StatsTooltipCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.inverseSurface,
            contentColor = MaterialTheme.colorScheme.inverseOnSurface),
        elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
        content = content
    )
}

@Composable
internal fun CompletionTooltip(title: String, date: String, time: String? = null) {
    StatsTooltipCard {
        Column(Modifier.padding(10.dp)) {
            Text(title, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
            val detailColor = LocalContentColor.current.copy(alpha = 0.8f)
            Text("完成日期: $date", style = MaterialTheme.typography.labelSmall, color = detailColor)
            if (time != null) Text("打卡时间: $time", style = MaterialTheme.typography.labelSmall, color = detailColor)
        }
    }
}

@Composable
internal fun TimelineTimerTooltip(arcs: List<TimerArc>, anchor: Offset, onDismiss: () -> Unit) {
    val parts = arcs.distinctBy { it.part.entry.id to it.part.date }.map { it.part }
    if (parts.isEmpty()) return
    val margin = with(LocalDensity.current) { 12.dp.roundToPx() }
    val configuration = LocalConfiguration.current
    val format = DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault())
    val position = object : PopupPositionProvider {
        override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
            val x = anchor.x.toInt() - popupContentSize.width / 2
            val above = anchor.y.toInt() - popupContentSize.height - margin
            val y = if (above >= margin) above else anchor.y.toInt() + margin
            return IntOffset(
                x.coerceIn(margin, maxOf(margin, windowSize.width - popupContentSize.width - margin)),
                y.coerceIn(margin, maxOf(margin, windowSize.height - popupContentSize.height - margin))
            )
        }
    }
    Popup(popupPositionProvider = position, onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true)) {
        StatsTooltipCard(Modifier.widthIn(max = minOf(320.dp, (configuration.screenWidthDp - 24).coerceAtLeast(1).dp))) {
            Column(Modifier.heightIn(max = (configuration.screenHeightDp * 0.6f).dp)
                .verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (parts.size == 1) parts.first().entry.display_content ?: parts.first().entry.task_content_snapshot
                    else "${parts.size} 条计时记录", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                parts.take(3).forEach { part ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (parts.size > 1) Text(part.entry.display_content ?: part.entry.task_content_snapshot,
                            style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
                        Text("标签：${part.entry.label_snapshot?.takeIf { it.isNotBlank() } ?: "未分类"}", style = MaterialTheme.typography.labelSmall)
                        Text("计时区间：${format.format(part.startedAt)} — ${format.format(part.endedAt)}", style = MaterialTheme.typography.labelSmall)
                        Text("投入时长：${Learning.duration(part.duration)}", style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (parts.size > 3) Text("另有 ${parts.size - 3} 条，点按计时图标查看全部", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
