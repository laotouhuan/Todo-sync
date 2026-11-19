package com.todo.app.ui.view

import com.todo.app.ui.theme.SupportingText

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import com.todo.app.data.model.Todo
import com.todo.app.data.model.Learning
import com.todo.app.data.model.StatsTimeline
import com.todo.app.data.model.TaskReference
import com.todo.app.data.model.TodoComparator
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.calcTaskAgeDays
import com.todo.app.data.model.calculateStatsPeriodProgress
import com.todo.app.data.model.collectStatsCompletionEvents
import com.todo.app.data.model.getHealthGrade
import com.todo.app.data.model.isIncludedInStatsPeriod
import com.todo.app.data.model.isOverdue
import com.todo.app.data.model.latestCheckinInStatsPeriod
import com.todo.app.data.model.nowIso
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.IsoFields
import java.util.Locale

// ====== Top-level private helper ======

private fun formatVal(valDouble: Double): String {
    return if (valDouble % 1.0 == 0.0) valDouble.toInt().toString() else String.format(Locale.US, "%.1f", valDouble)
}

internal fun matchesStatsTypeFilter(todo: Todo, checkedFilters: Set<String>): Boolean =
    StatsTaskVisualStyle.entries.any { it.taskType == todo.taskType && it.filterKey in checkedFilters }

@Composable
internal fun StatsView(viewModel: TodoViewModel, navigation: InsightsNavigation = remember { InsightsNavigation() }) {
    val source by viewModel.activeSource.collectAsState()
    val loading by viewModel.collabLoading.collectAsState()
    val error by viewModel.collabError.collectAsState()
    if (source is TodoViewModel.ActiveSource.Collaboration && (loading || error != null)) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(if (loading) "正在加载协作数据…" else error ?: "无法读取协作数据")
            if (!loading) TextButton(onClick = { (source as? TodoViewModel.ActiveSource.Collaboration)?.collab?.let(viewModel::loadCollabData) }) { Text("重试读取") }
        }
        return
    }
    var subTab by remember { mutableIntStateOf(0) } // 0 = Insights, 1 = Health
    var showEditDialogFor by remember { mutableStateOf<Todo?>(null) }

    Column(modifier = Modifier.fillMaxSize()) {
        // 二级 Tab (顶栏零间距挂载，固定 48.dp 高度)
        TabRow(selectedTabIndex = subTab, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Tab(selected = subTab == 0, onClick = { navigation.request { subTab = 0 } }, text = { Text("效率洞察", maxLines = 1) })
            Tab(selected = subTab == 1, onClick = { navigation.request { subTab = 1 } }, text = { Text("清单健康", maxLines = 1) })
        }

        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
            AnimatedContent(targetState = subTab, label = "statsSubTab") { currentTab ->
                when (currentTab) {
                    0 -> InsightsContent(viewModel, navigation, onEditTodo = { showEditDialogFor = it })
                    1 -> HealthContent(viewModel)
                }
            }
        }
    }

    showEditDialogFor?.let { todo ->
        val editSource = remember(todo.id) { viewModel.activeSource.value }
        EditTodoDialog(
            viewModel = viewModel,
            todo = todo,
            onDismiss = { showEditDialogFor = null },
            onConfirm = { updated, baseline ->
                viewModel.saveEditedTodo(updated, editSource, baseline)
                showEditDialogFor = null
            }
        )
    }
}

@Composable
internal fun InsightsContent(viewModel: TodoViewModel, navigation: InsightsNavigation, onEditTodo: (Todo) -> Unit) {
    val todos by viewModel.activeTodos.collectAsState()
    val activeSource by viewModel.activeSource.collectAsState()
    val learning = currentLearningData(viewModel)
    var period by remember { mutableStateOf("day") }
    var targetDate by remember { mutableStateOf(LocalDate.now()) }
    val planning = if (activeSource is TodoViewModel.ActiveSource.Personal)
        rememberPersonalPlanning(viewModel) else null
    val listState = rememberLazyListState()
    var scrollTarget by remember { mutableStateOf<String?>(null) }
    var showWeekDetails by remember(planning?.target) { mutableStateOf(false) }
    val sections = listOf("period-navigation", "date-navigation", "completion-and-effort", "time-distribution", "period-review")
    fun navigate(nextPeriod: String, day: LocalDate = targetDate, scroll: String? = null) = navigation.request {
        showWeekDetails = false
        period = nextPeriod
        targetDate = day
        scrollTarget = scroll
    }
    LaunchedEffect(scrollTarget, period, targetDate) {
        val index = sections.indexOf(scrollTarget)
        if (index >= 0) listState.scrollToItem(index)
        scrollTarget = null
    }

    var showTimingPreference by remember { mutableStateOf(viewModel.configManager.statsShowTiming) }
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    val showTiming = timingEnabled && (period == "day" || showTimingPreference)
    var showTaskList by remember { mutableStateOf(false) }
    var expandedFilterMenu by remember { mutableStateOf(false) }
    var checkedFilters by remember { mutableStateOf(setOf("normal", "weekly", "monthly")) }
    var tooltipTodo by remember { mutableStateOf<Todo?>(null) }
    var tooltipDate by remember { mutableStateOf("") }
    var tooltipTime by remember { mutableStateOf("") }
    var tooltipOffset by remember { mutableStateOf(Offset.Zero) }

    val periodTodos = remember(todos, period, targetDate) {
        todos.filter { it.isIncludedInStatsPeriod(period, targetDate) }
    }

    // Apply global category filter to periodTodos
    val filteredTodos = remember(periodTodos, checkedFilters) {
        periodTodos.filter { matchesStatsTypeFilter(it, checkedFilters) }
    }

    val timelineTodos = remember(todos, checkedFilters) {
        todos.filter { matchesStatsTypeFilter(it, checkedFilters) }
    }

    val periodProgress = remember(filteredTodos, period, targetDate) {
        calculateStatsPeriodProgress(filteredTodos, period, targetDate)
    }
    val progress = periodProgress.fraction

    val displayTodos = filteredTodos.sortedWith(TodoComparator)

    val todayStr = LocalDate.now().toString()
    val tomorrowStr = LocalDate.now().plusDays(1).toString()

    val completionEvents = remember(filteredTodos, period, targetDate) {
        collectStatsCompletionEvents(filteredTodos, period, targetDate)
    }
    val timedCompletionEvents = remember(completionEvents) {
        completionEvents.filter { it.hasExplicitTime }
    }
    val dateOnly = remember(completionEvents) {
        completionEvents.filterNot { it.hasExplicitTime }.map { it.todo to it.completedAt }
    }

    val density = LocalDensity.current
    val plottedDots = remember(timedCompletionEvents, period, targetDate, density) {
        val list = mutableListOf<PlottedDot>()
        val cx = with(density) { 145.dp.toPx() }
        val cy = with(density) { 130.dp.toPx() }

        timedCompletionEvents.forEachIndexed { index, event ->
            val t = event.todo
            val timeStr = event.completedAt
            val hm = parseTimeToHourMinute(timeStr)
            if (hm != null) {
                val (hour, minute) = hm
                val preciseMinute = Learning.instant(timeStr)?.let { StatsTimeline.clockMinute(it) }
                    ?: (hour * 60.0 + minute)
                val fracHour = preciseMinute / 60.0
                val angle = fracHour * 15.0

                val hash = (t.id + index.toString()).hashCode()
                // 只沿半径分散重叠点，不改变时间先后顺序。
                val activeR = with(density) { (57 + Math.floorMod(hash, 3) * 2).dp.toPx() }

                val thetaRad = Math.toRadians(angle)
                val px = cx + activeR * Math.sin(thetaRad).toFloat()
                val py = cy - activeR * Math.cos(thetaRad).toFloat()

                val pad = { n: Int -> n.toString().padStart(2, '0') }
                val dateLabel = Learning.instant(timeStr)?.atZone(ZoneId.systemDefault())?.toLocalDate()?.toString()?.drop(5)
                    ?: timeStr.take(10).drop(5)
                list.add(PlottedDot(t, dateLabel, "${pad(hour)}:${pad(minute)}", px, py, preciseMinute))
            }
        }
        list
    }

    val slotDurations = remember(learning, timelineTodos, period, targetDate, timingEnabled) {
        val source = TaskReference("", if (learning.readOnly) "collaboration" else "personal", learning.sourceId)
        val arcs = if (timingEnabled) StatsTimeline.arcs(learning.data.timeEntries, source, period, targetDate,
            conflicts = learning.conflicts) else emptyList()
        StatsTimeline.checkinDurationBySlot(arcs, timelineTodos)
    }
    val (nightDuration, morningDuration, afternoonDuration, eveningDuration) = slotDurations
    val totalDuration = slotDurations.sum()
    fun slotPercent(duration: Long) = if (totalDuration > 0) Math.round(duration.toDouble() / totalDuration * 100) else 0L
    fun slotLabel(label: String, duration: Long) = if (timingEnabled) "$label: ${slotPercent(duration)}%" else label

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        contentPadding = PaddingValues(bottom = 24.dp)
    ) {
        // Period Tabs with Dropdown Filter
        item(key = sections[0]) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    modifier = Modifier
                        .width(200.dp)
                        .height(36.dp)
                        .background(
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                            shape = RoundedCornerShape(18.dp)
                        )
                        .padding(3.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    val options = listOf("day" to "日", "week" to "周", "month" to "月")
                    options.forEach { (key, label) ->
                        val isSelected = period == key
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .background(
                                    color = if (isSelected) MaterialTheme.colorScheme.primary else Color.Transparent,
                                    shape = RoundedCornerShape(15.dp)
                                )
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = { if (period != key) navigate(key) }
                                ),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = label,
                                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold),
                                color = if (isSelected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
                Box {
                    IconButton(onClick = { expandedFilterMenu = true }) {
                        Icon(FilterListIcon, contentDescription = "筛选")
                    }
                    DropdownMenu(
                        expanded = expandedFilterMenu,
                        onDismissRequest = { expandedFilterMenu = false }
                    ) {
                        StatsTaskVisualStyle.entries.forEach { style ->
                            val key = style.filterKey
                            DropdownMenuItem(
                                text = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Checkbox(
                                            checked = checkedFilters.contains(key),
                                            onCheckedChange = { isChecked ->
                                                checkedFilters = if (isChecked) {
                                                    checkedFilters + key
                                                } else {
                                                    checkedFilters - key
                                                }
                                            }
                                        )
                                        Spacer(Modifier.width(4.dp))
                                        Canvas(Modifier.size(14.dp)) {
                                            drawStatsTaskMark(style, center, 5.dp.toPx())
                                        }
                                        Spacer(Modifier.width(8.dp))
                                        Text(style.label)
                                    }
                                },
                                onClick = {
                                    val isChecked = checkedFilters.contains(key)
                                    checkedFilters = if (isChecked) {
                                        checkedFilters - key
                                    } else {
                                        checkedFilters + key
                                    }
                                }
                            )
                        }
                    }
                }
            }
        }

        // Date Nav
        item(key = sections[1]) {
            Spacer(Modifier.height(4.dp))
            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = {
                    navigate(period, when (period) {
                        "day" -> targetDate.minusDays(1)
                        "week" -> targetDate.minusWeeks(1)
                        else -> targetDate.minusMonths(1)
                    })
                }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Prev") }

                val label = when (period) {
                    "day" -> "$targetDate · ${chineseWeekday(targetDate)}"
                    "week" -> "${targetDate.get(IsoFields.WEEK_BASED_YEAR)}年 第${targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)}周"
                    else -> "${targetDate.year}年 ${targetDate.monthValue}月"
                }
                Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp))

                IconButton(onClick = {
                    navigate(period, when (period) {
                        "day" -> targetDate.plusDays(1)
                        "week" -> targetDate.plusWeeks(1)
                        else -> targetDate.plusMonths(1)
                    })
                }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Next") }
            }
        }

        // Summary Bar
        item(key = sections[2]) {
            ElevatedCard(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                shape = MaterialTheme.shapes.medium
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text("完成与投入", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "共 ${formatVal(periodProgress.total)} 项，已完成 ${formatVal(periodProgress.completed)} 项，进度 ${(progress * 100).toInt()}%",
                        style = MaterialTheme.typography.titleSmall
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LinearProgressIndicator(
                            progress = { progress }, 
                            modifier = Modifier.weight(1f).height(8.dp),
                            strokeCap = StrokeCap.Round,
                            color = MaterialTheme.colorScheme.primary,
                            trackColor = MaterialTheme.colorScheme.surfaceVariant
                        )
                        Spacer(Modifier.width(12.dp))
                        Text("${(progress * 100).toInt()}%", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    }
                    LearningInsightsSummary(viewModel, period, targetDate)
                }
            }
        }

        // 时段分布卡片
        item(key = sections[3]) {
            OutlinedCard(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                shape = MaterialTheme.shapes.medium,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
                colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f))
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(if (timingEnabled) "打卡任务时长分布" else "任务时间线", style = MaterialTheme.typography.titleMedium)
                        if (timingEnabled && period != "day") TextButton(onClick = {
                            tooltipTodo = null
                            showTimingPreference = !showTimingPreference
                            viewModel.configManager.statsShowTiming = showTimingPreference
                        }) { Text(if (showTimingPreference) "隐藏计时" else "显示计时", color = if (showTimingPreference) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    if (timingEnabled) {
                        val insightText = if (totalDuration == 0L) {
                            "本周期暂无打卡任务计时"
                        } else {
                            val maxSlot = slotDurations.indices.maxBy { slotDurations[it] }
                            val slotName = listOf("深夜", "上午", "下午", "晚上")[maxSlot]
                            "${slotName}投入最多，占打卡任务总计时的 ${slotPercent(slotDurations[maxSlot])}%"
                        }
                        SupportingText(insightText)
                    }
                    val sweepProgress = rememberClockSweep(period, targetDate, activeSource)

                    val verticalTiming = showTiming && period != "day"
                    if (verticalTiming) {
                        StatsVerticalTimeline(viewModel, timelineTodos, period, targetDate, onEditTodo)
                    } else {
                        // Clock drawing container
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .wrapContentHeight()
                                .padding(vertical = 4.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Canvas(
                                modifier = Modifier
                                    .size(290.dp, 260.dp)
                                    .pointerInput(plottedDots, period) {
                                        detectTapGestures(
                                            onTap = { offset ->
                                                val touchRadius = 24.dp.toPx()
                                                val clicked = plottedDots.minByOrNull { dot ->
                                                    val dx = dot.x - offset.x
                                                    val dy = dot.y - offset.y
                                                    dx * dx + dy * dy
                                                }
                                                if (clicked != null) {
                                                    val dx = clicked.x - offset.x
                                                    val dy = clicked.y - offset.y
                                                    if (dx * dx + dy * dy <= touchRadius * touchRadius) {
                                                        onEditTodo(clicked.todo)
                                                    } else {
                                                        tooltipTodo = null
                                                    }
                                                } else {
                                                    tooltipTodo = null
                                                }
                                            },
                                            onLongPress = { offset ->
                                                val touchRadius = 24.dp.toPx()
                                                val clicked = plottedDots.minByOrNull { dot ->
                                                    val dx = dot.x - offset.x
                                                    val dy = dot.y - offset.y
                                                    dx * dx + dy * dy
                                                }
                                                if (clicked != null) {
                                                    val dx = clicked.x - offset.x
                                                    val dy = clicked.y - offset.y
                                                    if (dx * dx + dy * dy <= touchRadius * touchRadius) {
                                                        tooltipTodo = clicked.todo
                                                        tooltipDate = clicked.dateLabel
                                                        tooltipTime = clicked.timeLabel
                                                        tooltipOffset = offset
                                                    }
                                                }
                                            }
                                        )
                                    }
                            ) {
                                val cx = size.width / 2
                                val cy = size.height / 2
                                val rPx = 75.dp.toPx()
                                val strokeWidthPx = 10.dp.toPx()

                                // Background track
                                drawCircle(
                                    color = Color.White.copy(alpha = 0.05f),
                                    radius = rPx,
                                    center = Offset(cx, cy),
                                    style = Stroke(width = strokeWidthPx)
                                )

                                val currentSweep = sweepProgress.value * 360f

                                // Q1 (Top-Right): 0-6 (Night)
                                drawArc(
                                    color = TimeSlotColors.night,
                                    startAngle = 270f,
                                    sweepAngle = minOf(90f, currentSweep),
                                    useCenter = false,
                                    topLeft = Offset(cx - rPx, cy - rPx),
                                    size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                    style = Stroke(width = strokeWidthPx),
                                    alpha = if (nightDuration > 0) 0.95f else 0.2f
                                )

                                // Q2 (Bottom-Right): 6-12 (Morning)
                                drawArc(
                                    color = TimeSlotColors.morning,
                                    startAngle = 0f,
                                    sweepAngle = maxOf(0f, minOf(90f, currentSweep - 90f)),
                                    useCenter = false,
                                    topLeft = Offset(cx - rPx, cy - rPx),
                                    size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                    style = Stroke(width = strokeWidthPx),
                                    alpha = if (morningDuration > 0) 0.95f else 0.2f
                                )

                                // Q3 (Bottom-Left): 12-18 (Afternoon)
                                drawArc(
                                    color = TimeSlotColors.afternoon,
                                    startAngle = 90f,
                                    sweepAngle = maxOf(0f, minOf(90f, currentSweep - 180f)),
                                    useCenter = false,
                                    topLeft = Offset(cx - rPx, cy - rPx),
                                    size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                    style = Stroke(width = strokeWidthPx),
                                    alpha = if (afternoonDuration > 0) 0.95f else 0.2f
                                )

                                // Q4 (Top-Left): 18-24 (Evening)
                                drawArc(
                                    color = TimeSlotColors.evening,
                                    startAngle = 180f,
                                    sweepAngle = maxOf(0f, minOf(90f, currentSweep - 270f)),
                                    useCenter = false,
                                    topLeft = Offset(cx - rPx, cy - rPx),
                                    size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                    style = Stroke(width = strokeWidthPx),
                                    alpha = if (eveningDuration > 0) 0.95f else 0.2f
                                )

                                // Division lines
                                drawLine(
                                    color = Color.White.copy(alpha = 0.15f),
                                    start = Offset(cx - rPx - 15.dp.toPx(), cy),
                                    end = Offset(cx + rPx + 15.dp.toPx(), cy),
                                    strokeWidth = 1.dp.toPx()
                                )
                                drawLine(
                                    color = Color.White.copy(alpha = 0.15f),
                                    start = Offset(cx, cy - rPx - 15.dp.toPx()),
                                    end = Offset(cx, cy + rPx + 15.dp.toPx()),
                                    strokeWidth = 1.dp.toPx()
                                )

                                // Clock text labels
                                val paint = android.graphics.Paint().apply {
                                    textSize = 11.5.sp.toPx()
                                    typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
                                }

                                paint.color = TimeSlotColors.night.toArgb()
                                paint.textAlign = android.graphics.Paint.Align.RIGHT
                                drawContext.canvas.nativeCanvas.drawText(slotLabel("深夜 (0-6)", nightDuration), 282.dp.toPx(), 25.dp.toPx(), paint)

                                paint.color = TimeSlotColors.morning.toArgb()
                                paint.textAlign = android.graphics.Paint.Align.RIGHT
                                drawContext.canvas.nativeCanvas.drawText(slotLabel("上午 (6-12)", morningDuration), 282.dp.toPx(), 245.dp.toPx(), paint)

                                paint.color = TimeSlotColors.afternoon.toArgb()
                                paint.textAlign = android.graphics.Paint.Align.LEFT
                                drawContext.canvas.nativeCanvas.drawText(slotLabel("下午 (12-18)", afternoonDuration), 8.dp.toPx(), 245.dp.toPx(), paint)

                                paint.color = TimeSlotColors.evening.toArgb()
                                paint.textAlign = android.graphics.Paint.Align.LEFT
                                drawContext.canvas.nativeCanvas.drawText(slotLabel("晚上 (18-24)", eveningDuration), 8.dp.toPx(), 25.dp.toPx(), paint)

                                // Draw shapes
                                val dotRadius = when (period) {
                                    "day" -> 8.dp.toPx()
                                    "week" -> 6.dp.toPx()
                                    else -> 4.5.dp.toPx()
                                }
                                val strokeW = when (period) {
                                    "day" -> 1.5.dp.toPx()
                                    "week" -> 1.0.dp.toPx()
                                    else -> 0.7.dp.toPx()
                                }

                                plottedDots.forEach { dot ->
                                    val dotAlpha = clockEntryAlpha(sweepProgress.value, dot.minute)
                                    if (dotAlpha > 0f) {
                                        drawStatsTaskMark(dot.todo.statsVisualStyle(), Offset(dot.x, dot.y), dotRadius, dotAlpha, strokeW)
                                    }
                                }
                            }

                            StatsTimelineLayer(viewModel, timelineTodos, period, targetDate, showTiming, onEditTodo,
                                sweepProgress = { sweepProgress.value },
                                fallbackTap = { offset ->
                                    val clicked = plottedDots.minByOrNull { (Offset(it.x, it.y) - offset).getDistance() }
                                    if (clicked != null && (Offset(clicked.x, clicked.y) - offset).getDistance() <= with(density) { 24.dp.toPx() }) onEditTodo(clicked.todo)
                                    else tooltipTodo = null
                                }, fallbackLongPress = { offset ->
                                    val clicked = plottedDots.minByOrNull { (Offset(it.x, it.y) - offset).getDistance() }
                                    if (clicked != null && (Offset(clicked.x, clicked.y) - offset).getDistance() <= with(density) { 24.dp.toPx() }) {
                                        tooltipTodo = clicked.todo; tooltipDate = clicked.dateLabel; tooltipTime = clicked.timeLabel; tooltipOffset = offset
                                    }
                                })
                            // Tooltip Pop-up overlay for Canvas dots
                            tooltipTodo?.let { todo ->
                                Popup(
                                    alignment = Alignment.TopStart,
                                    offset = IntOffset(tooltipOffset.x.toInt(), tooltipOffset.y.toInt() - 40.dp.value.toInt()),
                                    onDismissRequest = { tooltipTodo = null }
                                ) {
                                    CompletionTooltip(todo.content, tooltipDate, tooltipTime)
                                }
                            }

                        }
                    }
                    TimelineLegend(viewModel, timelineTodos, dateOnly, period, targetDate, showTiming, onEditTodo)

                }
            }
        }

        item(key = sections[4]) {
            if (planning != null && period != "day") key(planning.target) {
                PersonalPlanningStats(planning, targetDate, period, navigation, showWeekDetails,
                    { showWeekDetails = it }, viewModel) { day -> navigate("day", day, "period-review") }
            }
            if (period != "week" || planning == null) LearningInsights(viewModel, period, targetDate, planning, navigation) { day ->
                // 编辑器已经完成草稿保护，直接应用这次导航。
                period = "week"
                targetDate = day
                scrollTarget = "period-review"
                showWeekDetails = true
            }
        }

        // Toggle list button
        item {
            Spacer(Modifier.height(8.dp))
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center
            ) {
                OutlinedButton(
                    onClick = { showTaskList = !showTaskList },
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.primary
                    ),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)
                ) {
                    Text(
                        text = if (showTaskList) "收起详细任务列表" 
                               else "显示详细任务列表 (共 ${displayTodos.size} 项)"
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
        }

        // List
        if (showTaskList) {
            items(displayTodos, key = { it.id }) { todo ->
                val checkinDateForTodo = if (todo.taskType == TaskType.WEEKLY_CHECKIN || todo.taskType == TaskType.MONTHLY_CHECKIN) {
                    todo.latestCheckinInStatsPeriod(period, targetDate)
                } else null
                TodoItemRow(
                    todo = todo,
                    viewModel = viewModel,
                    onEdit = { onEditTodo(todo) },
                    onMoveToTomorrow = {
                        viewModel.updateTodo(todo.copy(date = tomorrowStr, updatedAt = nowIso()))
                    },
                    todayStr = todayStr,
                    tomorrowStr = tomorrowStr,
                    checkinDate = checkinDateForTodo
                )
            }
        }
    }
}

@Composable
fun HealthContent(viewModel: TodoViewModel) {
    val todos by viewModel.activeTodos.collectAsState()
    var throughputDays by remember { mutableIntStateOf(30) }
    var expandedDropdown by remember { mutableStateOf(false) }

    val activeTodos = remember(todos) {
        todos.filter { 
            !it.deleted && 
            it.taskType != TaskType.WEEKLY_CHECKIN && 
            it.taskType != TaskType.MONTHLY_CHECKIN
        }
    }
    val incompleteTodos = remember(activeTodos) {
        activeTodos.filter { !it.completed }
    }

    val healthMetrics by viewModel.healthMetrics.collectAsState()
    val currentAvgCompletedLife = healthMetrics.currentAvgCompletedLife
    val currentAvgBacklogLife = healthMetrics.currentAvgBacklogLife
    val baselineAvgCompletedLife = healthMetrics.baselineAvgCompletedLife
    val baselineAvgBacklogLife = healthMetrics.baselineAvgBacklogLife
    val baselineSleepingCountVal = healthMetrics.baselineSleepingCountVal

    val nowTime = OffsetDateTime.now()

    // 3. Health Grade (based on backlog average age)
    val healthGrade = getHealthGrade(currentAvgBacklogLife)

    // 3. Throughput calculation
    val thresholdDate = nowTime.minusDays(throughputDays.toLong())
    var addedCount = 0
    var completedCount = 0

    activeTodos.forEach { t ->
        val createdDateTime = try {
            OffsetDateTime.parse(t.createdAt)
        } catch (e: Exception) {
            try { OffsetDateTime.ofInstant(java.time.Instant.parse(t.createdAt), java.time.ZoneId.systemDefault()) } catch (ex: Exception) { null }
        }
        if (createdDateTime != null && createdDateTime.isAfter(thresholdDate)) {
            addedCount++
        }

        if (t.completed && !t.completedAt.isNullOrEmpty()) {
            val completedDateTime = try {
                OffsetDateTime.parse(t.completedAt)
            } catch (e: Exception) {
                try { OffsetDateTime.ofInstant(java.time.Instant.parse(t.completedAt), java.time.ZoneId.systemDefault()) } catch (ex: Exception) { null }
            }
            if (completedDateTime != null && completedDateTime.isAfter(thresholdDate)) {
                completedCount++
            }
        }
    }

    // 4. Sleeping tasks (survived >= 7 days)
    val sleepingTodos = incompleteTodos.filter {
        calcTaskAgeDays(it.createdAt, nowTime) >= 7
    }.sortedByDescending {
        calcTaskAgeDays(it.createdAt, nowTime)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Text(
                text = "* 清单健康及相关指标仅统计普通单次任务，不含重复任务与周/月打卡",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                textAlign = TextAlign.Center
            )
        }
        // Health Grade Card
        item {
            ElevatedCard(
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.medium
            ) {
                Column(
                    modifier = Modifier.padding(20.dp).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Text("清单健康度", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = healthGrade.grade,
                        style = MaterialTheme.typography.displayMedium,
                        fontWeight = FontWeight.Bold,
                        color = Color(healthGrade.color)
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "“${healthGrade.text}”",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center
                    )
                }
            }
        }

        // Metabolism (Throughput) Card
        item {
            ElevatedCard(
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.medium
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("新陈代谢", style = MaterialTheme.typography.titleMedium)
                        Box {
                            TextButton(onClick = { expandedDropdown = true }) {
                                Text("最近 $throughputDays 天 ▾")
                            }
                            DropdownMenu(
                                expanded = expandedDropdown,
                                onDismissRequest = { expandedDropdown = false }
                            ) {
                                listOf(7, 14, 30, 60, 90).forEach { days ->
                                    DropdownMenuItem(
                                        text = { Text("最近 $days 天") },
                                        onClick = {
                                            throughputDays = days
                                            expandedDropdown = false
                                        }
                                    )
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        SupportingText("新增 $addedCount 项")
                        SupportingText("消灭 $completedCount 项")
                    }

                    Spacer(Modifier.height(8.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth().height(12.dp).clip(RoundedCornerShape(6.dp))
                    ) {
                        val totalThroughput = addedCount + completedCount
                        val targetAddedWeight = if (totalThroughput == 0) 1f else addedCount.toFloat()
                        val targetCompletedWeight = if (totalThroughput == 0) 1f else completedCount.toFloat()

                        val animatedAddedWeight by animateFloatAsState(
                            targetValue = targetAddedWeight,
                            animationSpec = tween(durationMillis = 500)
                        )
                        val animatedCompletedWeight by animateFloatAsState(
                            targetValue = targetCompletedWeight,
                            animationSpec = tween(durationMillis = 500)
                        )

                        val addedWeight = maxOf(0.001f, animatedAddedWeight)
                        val completedWeight = maxOf(0.001f, animatedCompletedWeight)

                        if (addedWeight > 0f) Box(modifier = Modifier.weight(addedWeight).fillMaxHeight().background(Color(0xFF3B82F6)))
                        if (completedWeight > 0f) Box(modifier = Modifier.weight(completedWeight).fillMaxHeight().background(Color(0xFF10B981)))
                    }

                    Spacer(Modifier.height(8.dp))

                    val verdict = when {
                        completedCount > addedCount -> "清单正在变轻盈 ✨"
                        completedCount == addedCount -> "收支平衡，保持节奏"
                        else -> ""
                    }
                    if (verdict.isNotEmpty()) {
                        Text(
                            text = verdict,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth(),
                            textAlign = TextAlign.Center,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }

        // Metrics Row
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Card 1: 平均任务寿命
                ElevatedCard(
                    modifier = Modifier.weight(1f),
                    shape = MaterialTheme.shapes.medium
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("⏱️", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = String.format(Locale.US, "%.1f 天", currentAvgCompletedLife),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(Modifier.height(2.dp))
                        val changeCompleted = currentAvgCompletedLife - baselineAvgCompletedLife
                        TrendIndicator(change = changeCompleted, isItemCount = false)
                        Spacer(Modifier.height(2.dp))
                        Text("平均任务寿命", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                // Card 2: 积压任务时长
                ElevatedCard(
                    modifier = Modifier.weight(1f),
                    shape = MaterialTheme.shapes.medium
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("⏳", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = String.format(Locale.US, "%.1f 天", currentAvgBacklogLife),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(Modifier.height(2.dp))
                        val changeBacklog = currentAvgBacklogLife - baselineAvgBacklogLife
                        TrendIndicator(change = changeBacklog, isItemCount = false)
                        Spacer(Modifier.height(2.dp))
                        Text("积压任务时长", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                // Card 3: 沉睡任务
                ElevatedCard(
                    modifier = Modifier.weight(1f),
                    shape = MaterialTheme.shapes.medium
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("💤", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "${sleepingTodos.size} 项",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(Modifier.height(2.dp))
                        val changeSleeping = (sleepingTodos.size - baselineSleepingCountVal).toDouble()
                        TrendIndicator(change = changeSleeping, isItemCount = true)
                        Spacer(Modifier.height(2.dp))
                        Text("沉睡任务", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // Sleeping list section header
        item {
            Text(
                text = "💤 沉睡待办清理 (超过7天未完成)",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 8.dp)
            )
        }

        if (sleepingTodos.isEmpty()) {
            item {
                ElevatedCard(
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.medium,
                    colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f))
                ) {
                    Text(
                        text = "所有任务都在健康流转中，继续保持！",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(24.dp).fillMaxWidth(),
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            items(sleepingTodos, key = { it.id }) { todo ->
                val age = calcTaskAgeDays(todo.createdAt, nowTime)
                ElevatedCard(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp).fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
                            Text(todo.content, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                            SupportingText("已存活 $age 天")
                        }

                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(
                                onClick = {
                                    val tomorrowStr = LocalDate.now().plusDays(1).toString()
                                    viewModel.updateTodo(todo.copy(date = tomorrowStr, updatedAt = nowIso()))
                                },
                                colors = ButtonDefaults.textButtonColors(contentColor = Color(0xFF7B61FF))
                            ) {
                                Text("延期")
                            }

                            TextButton(
                                onClick = {
                                    viewModel.deleteTodo(todo.id)
                                },
                                colors = ButtonDefaults.textButtonColors(contentColor = Color(0xFFEF4444))
                            ) {
                                Text("删除")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TimeSlotLegendItem(label: String, pct: Int, color: Color, modifier: Modifier = Modifier) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .background(color.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
            .padding(vertical = 6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(color, CircleShape)
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium),
                color = MaterialTheme.colorScheme.onSurface
            )
        }
        Spacer(Modifier.height(2.dp))
        Text(
            text = "$pct%",
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
            color = color
        )
    }
}

private data class PlottedDot(
    val todo: Todo,
    val dateLabel: String,
    val timeLabel: String,
    val x: Float,
    val y: Float,
    val minute: Double
)

@Composable
private fun TrendIndicator(change: Double, isItemCount: Boolean = false) {
    val isGood = change < -0.01
    val isBad = change > 0.01
    val color = when {
        isGood -> Color(0xFF22C55E)
        isBad -> Color(0xFFEF4444)
        else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
    }
    val text = when {
        isGood -> {
            val formatted = if (isItemCount) String.format(Locale.US, "%.0f", Math.abs(change)) else String.format(Locale.US, "%.1f", Math.abs(change))
            "↓ $formatted" + (if (isItemCount) "" else "天")
        }
        isBad -> {
            val formatted = if (isItemCount) String.format(Locale.US, "%.0f", change) else String.format(Locale.US, "%.1f", change)
            "↑ $formatted" + (if (isItemCount) "" else "天")
        }
        else -> "—"
    }

    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 1.dp)
    )
}

private fun parseTimeToHourMinute(completedAt: String): Pair<Int, Int>? {
    return try {
        val odt = OffsetDateTime.parse(completedAt).atZoneSameInstant(ZoneId.systemDefault())
        Pair(odt.hour, odt.minute)
    } catch (e: Exception) {
        try {
            val dt = Instant.parse(completedAt).atZone(ZoneId.systemDefault())
            Pair(dt.hour, dt.minute)
        } catch (ex: Exception) {
            val match = Regex("T(\\d{2}):(\\d{2})").find(completedAt)
            if (match != null) {
                val (h, m) = match.destructured
                Pair(h.toInt(), m.toInt())
            } else null
        }
    }
}

private val FilterListIcon: ImageVector
    get() = ImageVector.Builder(
        name = "Filled.FilterList",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f
    ).apply {
        path(fill = SolidColor(Color(0xFF000000))) {
            moveTo(10f, 18f)
            horizontalLineTo(14f)
            verticalLineTo(16f)
            horizontalLineTo(10f)
            verticalLineTo(18f)
            close()
            moveTo(3f, 6f)
            verticalLineTo(8f)
            horizontalLineTo(21f)
            verticalLineTo(6f)
            horizontalLineTo(3f)
            close()
            moveTo(6f, 13f)
            horizontalLineTo(18f)
            verticalLineTo(11f)
            horizontalLineTo(6f)
            verticalLineTo(13f)
            close()
        }
    }.build()
