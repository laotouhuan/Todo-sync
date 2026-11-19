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
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
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
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val tasks = learning.tasks
    val source by viewModel.activeSource.collectAsState()
    val ref = if (source is TodoViewModel.ActiveSource.Collaboration) TaskReference("", "collaboration", (source as TodoViewModel.ActiveSource.Collaboration).collab.id) else TaskReference("")
    val resolved = remember(data.timeEntries, tasks, data.taskSeries, data.taskSeriesLinks) { Learning.resolveEntries(data.timeEntries, tasks, data, learning.sourceId) }
    val parts = remember(resolved, learning.conflicts, ref, period, target) { StatsTimeline.arcs(resolved, ref, period, target, conflicts = learning.conflicts) }
    val labelColors = remember(resolved, ref, learning.conflicts) { timerLabelColors(resolved, ref, learning.conflicts) }
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
    var tooltipParts by remember { mutableStateOf<List<TimerArc>>(emptyList()) }
    var tooltipAnchor by remember { mutableStateOf(Offset.Zero) }
    var canvasOrigin by remember { mutableStateOf(Offset.Zero) }
    var editingSteps by remember { mutableStateOf<List<Pair<Todo, Subtask>>>(emptyList()) }
    LaunchedEffect(period, target, ref, parts, events) { selectedParts = emptyList(); selectedPoints = emptyList(); editingSteps = emptyList(); tooltipParts = emptyList() }
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
        fun select(offset: Offset, longPress: Boolean = false) {
            tooltipParts = emptyList()
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
            val hits = StatsTimeline.hitSegments(parts, date, minute, 10f).distinctBy { it.part.entry.id to it.part.date }
            if (longPress) {
                tooltipParts = hits
                tooltipAnchor = canvasOrigin + offset
            } else selectedParts = hits
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
                    Canvas(Modifier.width(stride * days.size).height(356.dp).onGloballyPositioned {
                        val origin = it.positionInWindow()
                        if (origin != canvasOrigin) tooltipParts = emptyList()
                        canvasOrigin = origin
                    }.pointerInput(points, parts, days, stridePx) {
                        detectTapGestures(onTap = { select(it) }, onLongPress = { select(it, longPress = true) })
                    }) {
                        val lineWidth = (if (month) 3 else 6).dp.toPx()
                        days.forEachIndexed { index, date ->
                            val x = (index + .5f) * stridePx
                            val label = if (month) "${date.dayOfMonth}日" else listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")[index]
                            drawContext.canvas.nativeCanvas.drawText(label, x, 17.dp.toPx(), paint)
                            if (!month) drawContext.canvas.nativeCanvas.drawText(date.toString().drop(5), x, 32.dp.toPx(), paint)
                            TimeSlotColors.chronological.forEachIndexed { slot, color ->
                                drawLine(color.copy(alpha = .25f), Offset(x, yAt(slot * 360.0)), Offset(x, yAt((slot + 1) * 360.0)), lineWidth)
                            }
                            parts.filter { it.part.date == date }.forEach { a ->
                                val end = minOf(a.endMinute, progress.value * 1440)
                                if (end > a.startMinute) {
                                    val color = a.part.entry.label_snapshot?.let(labelColors::get) ?: unclassifiedTimerColor
                                    drawLine(color, Offset(x, yAt(a.startMinute.toDouble())), Offset(x, yAt(end.toDouble())), lineWidth)
                                }
                            }
                        }
                        points.forEach { (e, p) -> drawStatsTaskMark(e.todo.statsVisualStyle(), p, (if (month) 3 else 4).dp.toPx(), clockEntryAlpha(progress.value, StatsTimeline.clockMinute(e.time)), subtask = e.subtask != null) }
                    }
                }
            }
        }
    }
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
    if (tooltipParts.isNotEmpty()) TimelineTimerTooltip(tooltipParts, tooltipAnchor) { tooltipParts = emptyList() }
    if (editingSteps.isNotEmpty()) TimelineSubtaskPicker(viewModel, editingSteps) { editingSteps = emptyList() }
}
