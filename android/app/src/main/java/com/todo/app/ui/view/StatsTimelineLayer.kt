package com.todo.app.ui.view

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
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
    val data by viewModel.todoData.collectAsState()
    val tasks by viewModel.learningTasks.collectAsState()
    val source by viewModel.activeSource.collectAsState()
    val ref = if (source is TodoViewModel.ActiveSource.Collaboration) TaskReference("", "collaboration", (source as TodoViewModel.ActiveSource.Collaboration).collab.id) else TaskReference("")
    val resolved = remember(data.timeEntries, tasks) { Learning.resolveEntries(data.timeEntries, tasks) }
    val arcs = remember(resolved, ref, period, target) { StatsTimeline.arcs(resolved, ref, period, target) }
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
    var recordIds by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(showTiming, period, target, data, tasks) { selectedArcs = emptyList(); selectedSteps = emptyList(); recordIds = null }
    fun hit(offset: Offset): Boolean = with(density) {
        val matching = points.filter { (_, p) -> (p - offset).getDistance() <= 12.dp.toPx() }.map { it.first }
        if (matching.isNotEmpty()) { selectedSteps = matching; true }
        else {
            val dx = offset.x - 145.dp.toPx(); val dy = offset.y - 130.dp.toPx()
            if (showTiming && abs(hypot(dx, dy) - 95.dp.toPx()) <= 12.dp.toPx()) {
                val minute = ((atan2(dx, -dy) * 1440 / (2 * PI) + 1440) % 1440).toFloat()
                val hits = StatsTimeline.hitArcs(arcs, minute, 8f)
                if (hits.isNotEmpty()) { selectedArcs = hits.distinctBy { it.part.entry.id to it.part.date }; true } else false
            } else false
        }
    }
    Canvas(Modifier.size(290.dp, 260.dp).pointerInput(points, arcs, showTiming, fallbackTap, fallbackLongPress) {
        detectTapGestures(onTap = { if (!hit(it)) fallbackTap(it) }, onLongPress = { if (!hit(it)) fallbackLongPress(it) })
    }) {
        if (showTiming) arcs.forEach { a ->
            val r = 95.dp.toPx()
            val sweep = clockArcSweep(minOf(sweepProgress(), timerSweep.value), a.startMinute, a.endMinute)
            drawArc(Color(0xFF22D3EE).copy(alpha = .65f), a.startMinute / 4 - 90, sweep, false,
                Offset(size.width / 2 - r, size.height / 2 - r), Size(2 * r, 2 * r), style = Stroke(6.dp.toPx()))
        }
        points.forEach { (e, p) ->
            val color = when { e.todo.recurring == "daily_repeat" -> Color(0xFFF59E0B); e.todo.taskType == TaskType.WEEKLY_CHECKIN -> Color(0xFF6366F1); e.todo.taskType == TaskType.MONTHLY_CHECKIN -> Color(0xFFF43F5E); else -> Color(0xFF10B981) }
            val alpha = clockEntryAlpha(sweepProgress(), StatsTimeline.clockMinute(e.time!!))
            drawCircle(color, (if (period == "day") 4 else 3).dp.toPx(), p, alpha = alpha, style = Stroke(2.dp.toPx()))
        }
    }
    val format = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
    if (selectedSteps.isNotEmpty()) AlertDialog(onDismissRequest = { selectedSteps = emptyList() }, title = { Text("子步骤完成") }, text = {
        Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
            selectedSteps.forEach { e ->
                Text("${e.todo.content} / ${e.subtask.content}")
                Text(e.time?.atZone(ZoneId.systemDefault())?.format(format) ?: "${e.date}（无具体时间）")
                TextButton(onClick = { selectedSteps = emptyList(); onEditTodo(e.todo) }) { Text("编辑任务") }
            }
        }
    }, confirmButton = { TextButton(onClick = { selectedSteps = emptyList() }) { Text("关闭") } })
    if (selectedArcs.isNotEmpty()) AlertDialog(onDismissRequest = { selectedArcs = emptyList() }, title = { Text("计时区间") }, text = {
        Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
            selectedArcs.forEach { a ->
                val e = a.part.entry
                Text("${e.task_content_snapshot} · ${e.label_snapshot ?: "未分类"}" + if (e.task_ref !in tasks) " · 原任务不可用" else if (tasks[e.task_ref]?.deleted == true) " · 原任务已删除" else "")
                Text("原记录：${Learning.instant(e.started_at)?.atZone(ZoneId.systemDefault())?.format(format)} — ${Learning.instant(e.ended_at)?.atZone(ZoneId.systemDefault())?.format(format)}")
                Text("本日：${a.part.startedAt.atZone(ZoneId.systemDefault()).format(format)} — ${a.part.endedAt.atZone(ZoneId.systemDefault()).format(format)} · ${Learning.duration(a.part.duration)}")
                HorizontalDivider()
            }
        }
    }, confirmButton = { TextButton(onClick = { recordIds = selectedArcs.map { it.part.entry.id }.distinct(); selectedArcs = emptyList() }) { Text("管理记录") } },
        dismissButton = { TextButton(onClick = { selectedArcs = emptyList() }) { Text("关闭") } })
    recordIds?.let { LearningRecordsDialog(viewModel, it) { recordIds = null } }
}

@Composable
fun TimelineLegend(viewModel: TodoViewModel, todos: List<Todo>, period: String, target: LocalDate, showTiming: Boolean, onEditTodo: (Todo) -> Unit) {
    val data by viewModel.todoData.collectAsState()
    val source by viewModel.activeSource.collectAsState()
    val ref = if (source is TodoViewModel.ActiveSource.Collaboration) TaskReference("", "collaboration", (source as TodoViewModel.ActiveSource.Collaboration).collab.id) else TaskReference("")
    val arcs = remember(data.timeEntries, ref, period, target) { StatsTimeline.arcs(data.timeEntries, ref, period, target) }
    val undated = remember(todos, period, target) { StatsTimeline.subtasks(todos, period, target).filter { it.time == null } }
    if (showTiming && arcs.isEmpty()) Text("本时段暂无有效计时记录", style = MaterialTheme.typography.bodySmall)
    if (!showTiming && arcs.isNotEmpty()) Text("可点击“显示计时”查看投入", style = MaterialTheme.typography.bodySmall)
    undated.forEach { e -> TextButton(onClick = { onEditTodo(e.todo) }) { Text("子步骤 · ${e.date} · ${e.subtask.content}（无具体时间）") } }
}
