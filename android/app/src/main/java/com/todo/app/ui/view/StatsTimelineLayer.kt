package com.todo.app.ui.view

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.*
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.*

@Composable
fun StatsTimelineLayer(viewModel: TodoViewModel, todos: List<Todo>, period: String, target: LocalDate, showTiming: Boolean,
    onEditTodo: (Todo) -> Unit, sweepProgress: () -> Float, fallbackTap: (Offset) -> Unit, fallbackLongPress: (Offset) -> Unit) {
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val tasks = learning.tasks
    val source by viewModel.activeSource.collectAsState()
    val ref = if (source is TodoViewModel.ActiveSource.Collaboration) TaskReference("", "collaboration", (source as TodoViewModel.ActiveSource.Collaboration).collab.id) else TaskReference("")
    val resolved = remember(data.timeEntries, tasks, data.taskSeries, data.taskSeriesLinks) { Learning.resolveEntries(data.timeEntries, tasks, data, learning.sourceId) }
    val arcs = remember(resolved, learning.conflicts, ref, period, target) { StatsTimeline.arcs(resolved, ref, period, target, conflicts = learning.conflicts) }
    val labelColors = remember(resolved, ref, learning.conflicts) { timerLabelColors(resolved, ref, learning.conflicts) }
    val timerSweep = rememberClockSweep(showTiming, arcs)
    val steps = remember(todos, period, target) { StatsTimeline.subtasks(todos, period, target) }
    val density = LocalDensity.current
    val points = remember(steps, density) { steps.filter { it.time != null }.mapIndexed { i, event ->
        val minute = StatsTimeline.clockMinute(event.time!!)
        val angle = minute / 1440 * 2 * PI
        event to with(density) { Offset(145.dp.toPx() + (39 + i % 3 * 5).dp.toPx() * sin(angle).toFloat(), 130.dp.toPx() - (39 + i % 3 * 5).dp.toPx() * cos(angle).toFloat()) }
    } }
    var selectedSteps by remember { mutableStateOf<List<SubtaskEvent>>(emptyList()) }
    var selectedArcs by remember { mutableStateOf<List<TimerArc>>(emptyList()) }
    var tooltipArcs by remember { mutableStateOf<List<TimerArc>>(emptyList()) }
    var tooltipAnchor by remember { mutableStateOf(Offset.Zero) }
    var canvasOrigin by remember { mutableStateOf(Offset.Zero) }
    LaunchedEffect(showTiming, period, target, source, data, tasks) { selectedArcs = emptyList(); selectedSteps = emptyList(); tooltipArcs = emptyList() }
    fun hit(offset: Offset, longPress: Boolean = false): Boolean = with(density) {
        tooltipArcs = emptyList()
        val matching = points.filter { (_, p) -> (p - offset).getDistance() <= 12.dp.toPx() }.map { it.first }
        if (matching.isNotEmpty()) { selectedSteps = matching; true }
        else {
            val dx = offset.x - 145.dp.toPx(); val dy = offset.y - 130.dp.toPx()
            if (showTiming && abs(hypot(dx, dy) - 95.dp.toPx()) <= 12.dp.toPx()) {
                val minute = ((atan2(dx, -dy) * 1440 / (2 * PI) + 1440) % 1440).toFloat()
                val hits = StatsTimeline.hitArcs(arcs, minute, 8f)
                if (hits.isNotEmpty()) {
                    if (longPress) {
                        tooltipArcs = hits
                        tooltipAnchor = canvasOrigin + offset
                    } else selectedArcs = hits.distinctBy { it.part.entry.id to it.part.date }
                    true
                } else false
            } else false
        }
    }
    Canvas(Modifier.size(290.dp, 260.dp).onGloballyPositioned {
        val origin = it.positionInWindow()
        if (origin != canvasOrigin) tooltipArcs = emptyList()
        canvasOrigin = origin
    }.pointerInput(points, arcs, showTiming, fallbackTap, fallbackLongPress) {
        detectTapGestures(onTap = { if (!hit(it)) fallbackTap(it) }, onLongPress = { if (!hit(it, longPress = true)) fallbackLongPress(it) })
    }) {
        if (showTiming) arcs.forEach { a ->
            val r = 95.dp.toPx()
            val sweep = clockArcSweep(minOf(sweepProgress(), timerSweep.value), a.startMinute, a.endMinute)
            val color = a.part.entry.label_snapshot?.let(labelColors::get) ?: unclassifiedTimerColor
            drawArc(color, a.startMinute / 4 - 90, sweep, false,
                Offset(size.width / 2 - r, size.height / 2 - r), Size(2 * r, 2 * r), style = Stroke(6.dp.toPx()))
        }
        points.forEach { (e, p) ->
            val alpha = clockEntryAlpha(sweepProgress(), StatsTimeline.clockMinute(e.time!!))
            drawStatsTaskMark(e.todo.statsVisualStyle(), p, (if (period == "day") 4 else 3).dp.toPx(), alpha, 2.dp.toPx(), subtask = true)
        }
    }
    if (selectedSteps.isNotEmpty()) TimelineSubtaskPicker(viewModel, selectedSteps.map { it.todo to it.subtask }) { selectedSteps = emptyList() }
    if (selectedArcs.isNotEmpty()) TimelineRecordEditor(viewModel, selectedArcs.map { it.part.entry.id }.distinct()) { selectedArcs = emptyList() }
    if (tooltipArcs.isNotEmpty()) TimelineTimerTooltip(tooltipArcs, tooltipAnchor) { tooltipArcs = emptyList() }

}

@Composable
fun TimelineLegend(viewModel: TodoViewModel, todos: List<Todo>, dateOnly: List<Pair<Todo, String>>, period: String, target: LocalDate, showTiming: Boolean, onEditTodo: (Todo) -> Unit) {
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || currentLearningData(viewModel).readOnly
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val source by viewModel.activeSource.collectAsState()
    val ref = if (source is TodoViewModel.ActiveSource.Collaboration) TaskReference("", "collaboration", (source as TodoViewModel.ActiveSource.Collaboration).collab.id) else TaskReference("")
    val arcs = remember(data.timeEntries, learning.conflicts, ref, period, target) { StatsTimeline.arcs(data.timeEntries, ref, period, target, conflicts = learning.conflicts) }
    val undated = remember(todos, period, target) { StatsTimeline.subtasks(todos, period, target).filter { it.time == null } }
    if (showTiming && arcs.isEmpty()) Text("本时段暂无有效计时记录", style = MaterialTheme.typography.bodySmall)
    if (timingEnabled && !showTiming && arcs.isNotEmpty()) Text("可点击“显示计时”查看投入", style = MaterialTheme.typography.bodySmall)
    var selectedStep by remember { mutableStateOf<SubtaskEvent?>(null) }
    selectedStep?.let { e -> TimelineSubtaskEditor(viewModel, e.todo, e.subtask) { selectedStep = null } }
    val count = dateOnly.size + undated.size
    if (count > 0) {
        var expanded by remember(source, period, target) { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.semantics {
            stateDescription = if (expanded) "已展开" else "已收起"
        }) { Text("无具体时间 · $count 条 " + if (expanded) "▴" else "▾") }
        if (expanded) {
            dateOnly.forEach { (todo, date) ->
                TextButton(onClick = { onEditTodo(todo) }) { Text("$date · ${todo.content}") }
            }
            undated.forEach { e ->
                TextButton(onClick = { selectedStep = e }) { Text("${e.date} · 子步骤 · ${e.subtask.content}") }
            }
        }
    }
}
