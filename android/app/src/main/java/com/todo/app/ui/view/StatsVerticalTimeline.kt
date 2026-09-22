package com.todo.app.ui.view

import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.todo.app.data.model.*
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.*

private data class VerticalCompletion(val todo: Todo, val subtask: Subtask?, val date: LocalDate, val time: Instant)

@Composable
fun StatsVerticalTimeline(viewModel: TodoViewModel, todos: List<Todo>, period: String, target: LocalDate, onEditTodo: (Todo) -> Unit) {
    val data by viewModel.todoData.collectAsState()
    val tasks by viewModel.learningTasks.collectAsState()
    val source by viewModel.activeSource.collectAsState()
    val ref = if (source is TodoViewModel.ActiveSource.Collaboration) TaskReference("", "collaboration", (source as TodoViewModel.ActiveSource.Collaboration).collab.id) else TaskReference("")
    val resolved = remember(data.timeEntries, tasks) { Learning.resolveEntries(data.timeEntries, tasks) }
    val parts = remember(resolved, ref, period, target) { StatsTimeline.arcs(resolved, ref, period, target) }
    val days = remember(period, target) { StatsTimeline.days(period, target) }
    val completed = remember(todos, period, target) { StatsTimeline.completions(todos, period, target) }
    val steps = remember(todos, period, target) { StatsTimeline.subtasks(todos, period, target) }
    val events = remember(completed, steps) {
        completed.mapNotNull { e -> e.time?.let { VerticalCompletion(e.todo, null, e.date, it) } } +
            steps.mapNotNull { e -> e.time?.let { VerticalCompletion(e.todo, e.subtask, e.date, it) } }
    }
    val progress = rememberClockSweep(period, target, ref, parts, events)
    var selectedPoints by remember { mutableStateOf<List<VerticalCompletion>>(emptyList()) }
    var selectedParts by remember { mutableStateOf<List<TimerArc>>(emptyList()) }
    var editingSteps by remember { mutableStateOf<List<Pair<Todo, Subtask>>>(emptyList()) }
    LaunchedEffect(period, target, ref, parts, events) { selectedParts = emptyList(); selectedPoints = emptyList(); editingSteps = emptyList() }
    val month = period == "month"
    val density = LocalDensity.current
    val labelColor = MaterialTheme.colorScheme.onSurfaceVariant
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        val stride = if (month) 32.dp else maxOf(36.dp, (maxWidth - 44.dp) / 7)
        val stridePx = with(density) { stride.toPx() }
        val top = with(density) { 44.dp.toPx() }; val height = with(density) { 288.dp.toPx() }
        fun yAt(minute: Double) = top + (minute / 1440 * height).toFloat()
        val points = events.map { e -> e to Offset((days.indexOf(e.date) + .5f) * stridePx + with(density) { (if (e.subtask == null) 6 else -6).dp.toPx() }, yAt(StatsTimeline.clockMinute(e.time))) }
        val paint = remember(density, labelColor) { Paint(Paint.ANTI_ALIAS_FLAG).apply { color = labelColor.toArgb(); textSize = with(density) { 10.sp.toPx() }; textAlign = Paint.Align.CENTER } }
        fun select(offset: Offset) {
            val dayIndex = floor(offset.x / stridePx).toInt()
            val date = days.getOrNull(dayIndex) ?: return
            val nearby = points.filter { it.first.date == date && (it.second - offset).getDistance() <= with(density) { 10.dp.toPx() } }.map { it.first }
            if (nearby.isNotEmpty()) {
                val substeps = nearby.mapNotNull { e -> e.subtask?.let { e.todo to it } }
                if (substeps.size == nearby.size) editingSteps = substeps else selectedPoints = nearby
                selectedParts = emptyList(); return
            }
            val minute = (offset.y - top) / height * 1440
            if (minute !in 0f..1440f || abs(offset.x - (dayIndex + .5f) * stridePx) > with(density) { 12.dp.toPx() }) return
            selectedParts = StatsTimeline.hitSegments(parts, date, minute, 10f).distinctBy { it.part.entry.id to it.part.date }
            selectedPoints = emptyList()
        }
        Row(Modifier.fillMaxWidth()) {
            Canvas(Modifier.width(44.dp).height(356.dp)) {
                listOf(0, 6, 12, 18, 24).forEach { hour ->
                    drawContext.canvas.nativeCanvas.drawText("${hour.toString().padStart(2, '0')}:00", 20.dp.toPx(), yAt(hour * 60.0) + 4.dp.toPx(), paint)
                }
            }
            key(period, target, ref) {
                Box(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                    Canvas(Modifier.width(stride * days.size).height(356.dp).pointerInput(points, parts, days, stridePx) {
                        detectTapGestures(onTap = { select(it) }, onLongPress = { select(it) })
                    }) {
                        val lineWidth = (if (month) 3 else 6).dp.toPx()
                        days.forEachIndexed { index, date ->
                            val x = (index + .5f) * stridePx
                            val label = if (month) "${date.dayOfMonth}日" else listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")[index]
                            drawContext.canvas.nativeCanvas.drawText(label, x, 17.dp.toPx(), paint)
                            if (!month) drawContext.canvas.nativeCanvas.drawText(date.toString().drop(5), x, 32.dp.toPx(), paint)
                            listOf(Color(0xFF3B82F6), Color(0xFFF59E0B), Color(0xFF7B61FF), Color(0xFF6366F1)).forEachIndexed { slot, color ->
                                drawLine(color.copy(alpha = .25f), Offset(x, yAt(slot * 360.0)), Offset(x, yAt((slot + 1) * 360.0)), lineWidth)
                            }
                            parts.filter { it.part.date == date }.forEach { a ->
                                val end = minOf(a.endMinute, progress.value * 1440)
                                if (end > a.startMinute) drawLine(Color(0xFF22D3EE).copy(alpha = .65f), Offset(x, yAt(a.startMinute.toDouble())), Offset(x, yAt(end.toDouble())), lineWidth)
                            }
                        }
                        points.forEach { (e, p) -> drawVerticalMark(e.todo, e.subtask != null, p, (if (month) 3 else 4).dp.toPx(), clockEntryAlpha(progress.value, StatsTimeline.clockMinute(e.time))) }
                    }
                }
            }
        }
    }
    completed.filter { it.time == null }.forEach { e -> TextButton(onClick = { onEditTodo(e.todo) }) { Text("${e.date.toString().drop(5)} · ${e.todo.content}（无具体时间）") } }
    val format = DateTimeFormatter.ofPattern("MM-dd HH:mm")
    fun time(value: Instant) = value.atZone(ZoneId.systemDefault()).format(format)
    if (selectedPoints.isNotEmpty()) AlertDialog(
        onDismissRequest = { selectedParts = emptyList(); selectedPoints = emptyList() },
        title = { Text(if (selectedParts.isNotEmpty()) "计时记录" else "完成记录") },
        text = { Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
            selectedPoints.forEach { e ->
                Text(e.subtask?.content ?: e.todo.content)
                if (e.subtask != null) Text("所属任务：${e.todo.content}")
                Text("完成时间：${time(e.time)}")
                TextButton(onClick = {
                    selectedPoints = emptyList()
                    if (e.subtask != null) editingSteps = listOf(e.todo to e.subtask) else onEditTodo(e.todo)
                }) { Text(if (e.subtask != null) "编辑子步骤" else "编辑任务") }
            }
        } },
        confirmButton = { TextButton(onClick = { selectedPoints = emptyList(); selectedParts = emptyList() }) { Text("关闭") } }
    )
    if (selectedParts.isNotEmpty()) TimelineRecordEditor(viewModel, selectedParts.map { it.part.entry.id }.distinct()) { selectedParts = emptyList() }
    if (editingSteps.isNotEmpty()) TimelineSubtaskPicker(viewModel, editingSteps) { editingSteps = emptyList() }
}

private fun DrawScope.drawVerticalMark(todo: Todo, subtask: Boolean, center: Offset, radius: Float, alpha: Float) {
    val style = todo.statsVisualStyle()
    if (subtask || style.shape == "circle") {
        if (!subtask) drawCircle(style.color, radius, center, alpha = alpha)
        drawCircle(if (subtask) style.color else Color.White, radius, center, alpha = alpha, style = Stroke(1.5.dp.toPx()))
    } else {
        val count = when (style.shape) { "triangle" -> 3; "diamond" -> 4; else -> 10 }
        val path = Path().apply {
            repeat(count) { i ->
                val angle = i.toDouble() / count * PI * 2 - PI / 2
                val r = if (style.shape == "star" && i % 2 == 1) radius * .45f else radius
                val x = center.x + cos(angle).toFloat() * r; val y = center.y + sin(angle).toFloat() * r
                if (i == 0) moveTo(x, y) else lineTo(x, y)
            }
            close()
        }
        drawPath(path, style.color, alpha = alpha); drawPath(path, Color.White, alpha = alpha, style = Stroke(1.dp.toPx()))
    }
}
