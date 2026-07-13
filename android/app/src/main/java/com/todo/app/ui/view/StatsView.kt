package com.todo.app.ui.view

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.List
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
import androidx.compose.ui.graphics.Path
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
import com.todo.app.data.model.TodoComparator
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.calcTaskAgeDays
import com.todo.app.data.model.categorizeByTimeSlot
import com.todo.app.data.model.getHealthGrade
import com.todo.app.data.model.isOverdue
import com.todo.app.data.model.monthStringOf
import com.todo.app.data.model.nowIso
import com.todo.app.data.model.weekStringOf
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

@Composable
private fun MakeupIcon(shape: String, color: Color, dotRadius: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val dotRadiusPx = dotRadius.toPx()
        val px = size.width / 2f
        val py = size.height / 2f
        val strokeW = when (dotRadius) {
            8.dp -> 1.5.dp.toPx()
            6.dp -> 1.0.dp.toPx()
            else -> 0.7.dp.toPx()
        }
        when (shape) {
            "circle" -> {
                drawCircle(color = color, radius = dotRadiusPx)
                drawCircle(color = Color.White, radius = dotRadiusPx, style = Stroke(width = strokeW))
            }
            "triangle" -> {
                val path = Path().apply {
                    moveTo(px, py - dotRadiusPx * 1.1f)
                    lineTo(px - dotRadiusPx, py + dotRadiusPx * 0.9f)
                    lineTo(px + dotRadiusPx, py + dotRadiusPx * 0.9f)
                    close()
                }
                drawPath(path = path, color = color)
                drawPath(path = path, color = Color.White, style = Stroke(width = strokeW))
            }
            "diamond" -> {
                val path = Path().apply {
                    moveTo(px, py - dotRadiusPx * 1.1f)
                    lineTo(px + dotRadiusPx * 1.1f, py)
                    lineTo(px, py + dotRadiusPx * 1.1f)
                    lineTo(px - dotRadiusPx * 1.1f, py)
                    close()
                }
                drawPath(path = path, color = color)
                drawPath(path = path, color = Color.White, style = Stroke(width = strokeW))
            }
            "star" -> {
                val path = Path().apply {
                    val spikes = 5
                    val outerRadius = dotRadiusPx * 1.25f
                    val innerRadius = dotRadiusPx * 0.6f
                    var rot = Math.PI / 2 * 3
                    val step = Math.PI / spikes
                    for (i in 0 until spikes) {
                        val px1 = px + Math.cos(rot).toFloat() * outerRadius
                        val py1 = py + Math.sin(rot).toFloat() * outerRadius
                        if (i == 0) moveTo(px1, py1) else lineTo(px1, py1)
                        rot += step
                        
                        val px2 = px + Math.cos(rot).toFloat() * innerRadius
                        val py2 = py + Math.sin(rot).toFloat() * innerRadius
                        lineTo(px2, py2)
                        rot += step
                    }
                    close()
                }
                drawPath(path = path, color = color)
                drawPath(path = path, color = Color.White, style = Stroke(width = strokeW))
            }
        }
    }
}

@Composable
fun StatsView(viewModel: TodoViewModel) {
    var subTab by remember { mutableIntStateOf(0) } // 0 = Insights, 1 = Health
    var showEditDialogFor by remember { mutableStateOf<Todo?>(null) }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        // 二级 Tab
        TabRow(selectedTabIndex = subTab) {
            Tab(selected = subTab == 0, onClick = { subTab = 0 }, text = { Text("效率洞察") })
            Tab(selected = subTab == 1, onClick = { subTab = 1 }, text = { Text("清单健康") })
        }

        Spacer(Modifier.height(16.dp))

        AnimatedContent(targetState = subTab, label = "statsSubTab") { currentTab ->
            when (currentTab) {
                0 -> InsightsContent(viewModel, onEditTodo = { showEditDialogFor = it })
                1 -> HealthContent(viewModel)
            }
        }
    }

    showEditDialogFor?.let { todo ->
        EditTodoDialog(
            todo = todo,
            onDismiss = { showEditDialogFor = null },
            onAutoSave = { updated -> 
                viewModel.updateTodo(updated)
                showEditDialogFor = updated 
            },
            onDelete = {
                viewModel.deleteTodo(todo.id)
                showEditDialogFor = null
            }
        )
    }
}

@Composable
fun InsightsContent(viewModel: TodoViewModel, onEditTodo: (Todo) -> Unit) {
    val todos by viewModel.todos.collectAsState()
    var period by remember { mutableStateOf("day") }
    var targetDate by remember { mutableStateOf(LocalDate.now()) }

    var showTaskList by remember { mutableStateOf(false) }
    var expandedFilterMenu by remember { mutableStateOf(false) }
    var checkedFilters by remember { mutableStateOf(setOf("normal", "daily", "weekly", "monthly")) }
    var tooltipTodo by remember { mutableStateOf<Todo?>(null) }
    var tooltipDate by remember { mutableStateOf("") }
    var tooltipTime by remember { mutableStateOf("") }
    var tooltipOffset by remember { mutableStateOf(Offset.Zero) }

    val targetWeekStr = weekStringOf(targetDate)
    val targetMonthStr = monthStringOf(targetDate)

    val periodTodos = remember(todos, period, targetDate) {
        when (period) {
            "day" -> todos.filter { t ->
                if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
                    t.completedDates.any { it.startsWith(targetDate.toString()) }
                } else {
                    if (t.completed && !t.completedAt.isNullOrEmpty()) {
                        t.completedAt?.take(10) == targetDate.toString()
                    } else {
                        t.date == targetDate.toString()
                    }
                }
            }
            "week" -> todos.filter { t ->
                if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
                    val hasCheckin = t.completedDates.any { dStr ->
                        try {
                            val checkDate = LocalDate.parse(dStr.take(10))
                            checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                            checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                        } catch (e: Exception) {
                            false
                        }
                    }
                    if (t.taskType == TaskType.WEEKLY_CHECKIN && t.date == targetWeekStr) {
                        if (t.targetCount != null) true else hasCheckin
                    } else {
                        hasCheckin
                    }
                } else {
                    if (t.completed && !t.completedAt.isNullOrEmpty()) {
                        t.completedAt?.take(10)?.let { completedDateStr ->
                            try {
                                val checkDate = LocalDate.parse(completedDateStr)
                                checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                                checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                            } catch (e: Exception) {
                                false
                            }
                        } ?: false
                    } else {
                        val dateStr = t.date
                        if (!dateStr.isNullOrEmpty()) {
                            dateStr == targetWeekStr || (dateStr.length == 10 && dateStr.startsWith(targetWeekStr.substring(0,4)) && 
                                try {
                                    val checkDate = LocalDate.parse(dateStr)
                                    checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) &&
                                    checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR)
                                } catch (e: Exception) { false }
                            )
                        } else {
                            false
                        }
                    }
                }
            }
            else -> todos.filter { t ->
                if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
                    val hasCheckin = t.completedDates.any { dStr -> dStr.startsWith(targetMonthStr) }
                    if (t.taskType == TaskType.MONTHLY_CHECKIN && t.date == targetMonthStr) {
                        if (t.targetCount != null) true else hasCheckin
                    } else {
                        hasCheckin
                    }
                } else {
                    if (t.completed && !t.completedAt.isNullOrEmpty()) {
                        t.completedAt?.take(7) == targetMonthStr
                    } else {
                        val dateStr = t.date
                        if (!dateStr.isNullOrEmpty()) {
                            dateStr == targetMonthStr || (dateStr.length == 10 && dateStr.startsWith(targetMonthStr))
                        } else {
                            false
                        }
                    }
                }
            }
        }
    }

    // Apply global category filter to periodTodos
    val filteredTodos = remember(periodTodos, checkedFilters) {
        periodTodos.filter { t ->
            val isDaily = t.recurring == "daily_repeat"
            val isWeekly = t.taskType == TaskType.WEEKLY_CHECKIN
            val isMonthly = t.taskType == TaskType.MONTHLY_CHECKIN
            val isNormal = t.taskType == TaskType.NORMAL && t.recurring != "daily_repeat"
            
            (isNormal && checkedFilters.contains("normal")) ||
            (isDaily && checkedFilters.contains("daily")) ||
            (isWeekly && checkedFilters.contains("weekly")) ||
            (isMonthly && checkedFilters.contains("monthly"))
        }
    }

    var totalDouble = 0.0
    var completedDouble = 0.0

    filteredTodos.forEach { t ->
        if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
            var periodCheckinCount = 0
            t.completedDates.forEach { dStr ->
                when (period) {
                    "day" -> {
                        if (dStr.startsWith(targetDate.toString())) periodCheckinCount++
                    }
                    "week" -> {
                        try {
                            val checkDate = LocalDate.parse(dStr.take(10))
                            if (checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                                checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)) {
                                periodCheckinCount++
                            }
                        } catch (e: Exception) {}
                    }
                    else -> {
                        if (dStr.startsWith(targetMonthStr)) periodCheckinCount++
                    }
                }
            }
            if (t.targetCount != null) {
                completedDouble += Math.min(t.targetCount!!.toDouble(), periodCheckinCount.toDouble())
                totalDouble += t.targetCount!!.toDouble()
            } else {
                completedDouble += periodCheckinCount.toDouble()
                totalDouble += periodCheckinCount.toDouble()
            }
        } else {
            totalDouble += 1.0
            if (t.completed) completedDouble += 1.0
        }
    }

    val progress = if (totalDouble == 0.0) 0f else (completedDouble / totalDouble).toFloat()

    val displayTodos = filteredTodos.sortedWith(TodoComparator)

    val todayStr = LocalDate.now().toString()
    val tomorrowStr = LocalDate.now().plusDays(1).toString()

    val density = LocalDensity.current
    val plottedDots = remember(filteredTodos, period, targetDate) {
        val list = mutableListOf<PlottedDot>()
        val completionEvents = mutableListOf<Pair<Todo, String>>()
        filteredTodos.forEach { t ->
            if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
                t.completedDates.forEach { dStr ->
                    val inPeriod = when (period) {
                        "day" -> dStr.startsWith(targetDate.toString())
                        "week" -> {
                            try {
                                val checkDate = LocalDate.parse(dStr.take(10))
                                checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                                checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                            } catch (e: Exception) {
                                false
                            }
                        }
                        else -> dStr.startsWith(targetMonthStr)
                    }
                    if (inPeriod && dStr.length > 10) {
                        completionEvents.add(Pair(t, dStr))
                    }
                }
            } else {
                if (t.completed && !t.completedAt.isNullOrEmpty()) {
                    completionEvents.add(Pair(t, t.completedAt!!))
                }
            }
        }

        val cx = with(density) { 145.dp.toPx() }
        val cy = with(density) { 130.dp.toPx() }
        val r = with(density) { 75.dp.toPx() }
        
        completionEvents.forEachIndexed { index, (t, timeStr) ->
            val hm = parseTimeToHourMinute(timeStr)
            if (hm != null) {
                val (hour, minute) = hm
                val fracHour = hour + minute / 60.0
                val angle = fracHour * 15.0
                
                val hash = (t.id + index.toString()).hashCode()
                val jitterR = ((hash % 5) - 2) * with(density) { 3.dp.toPx() }
                val activeR = r + jitterR
                val jitterAngle = ((hash % 7) - 3) * 1.5
                
                val thetaRad = Math.toRadians(angle + jitterAngle)
                val px = cx + activeR * Math.sin(thetaRad).toFloat()
                val py = cy - activeR * Math.cos(thetaRad).toFloat()
                
                val color = when {
                    t.recurring == "daily_repeat" -> Color(0xFFF59E0B)
                    t.taskType == TaskType.WEEKLY_CHECKIN -> Color(0xFF6366F1)
                    t.taskType == TaskType.MONTHLY_CHECKIN -> Color(0xFFF43F5E)
                    else -> Color(0xFF10B981)
                }
                
                val shape = when {
                    t.recurring == "daily_repeat" -> "triangle"
                    t.taskType == TaskType.WEEKLY_CHECKIN -> "diamond"
                    t.taskType == TaskType.MONTHLY_CHECKIN -> "star"
                    else -> "circle"
                }
                
                val pad = { n: Int -> n.toString().padStart(2, '0') }
                val dateLabel = timeStr.take(10)
                list.add(PlottedDot(t, dateLabel, "${pad(hour)}:${pad(minute)}", px, py, color, shape))
            }
        }
        list
    }

    val makeupCheckins = remember(filteredTodos, period, targetDate) {
        val list = mutableListOf<Pair<Todo, String>>()
        filteredTodos.forEach { t ->
            if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
                t.completedDates.forEach { dStr ->
                    val inPeriod = when (period) {
                        "day" -> dStr.startsWith(targetDate.toString())
                        "week" -> {
                            try {
                                val checkDate = LocalDate.parse(dStr.take(10))
                                checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                                checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                            } catch (e: Exception) {
                                false
                            }
                        }
                        else -> dStr.startsWith(targetMonthStr)
                    }
                    if (inPeriod && dStr.length <= 10) {
                        list.add(Pair(t, dStr))
                    }
                }
            }
        }
        list
    }

    var morningCount = 0
    var afternoonCount = 0
    var eveningCount = 0
    var nightCount = 0
    val makeupCheckinCount = makeupCheckins.size

    filteredTodos.forEach { t ->
        if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
            t.completedDates.forEach { dStr ->
                val inPeriod = when (period) {
                    "day" -> dStr.startsWith(targetDate.toString())
                    "week" -> {
                        try {
                            val checkDate = LocalDate.parse(dStr.take(10))
                            checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                            checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                        } catch (e: Exception) {
                            false
                        }
                    }
                    else -> dStr.startsWith(targetMonthStr)
                }

                if (inPeriod && dStr.length > 10) {
                    val slot = categorizeByTimeSlot(dStr)
                    if (slot == "morning") morningCount++
                    else if (slot == "afternoon") afternoonCount++
                    else if (slot == "evening") eveningCount++
                    else if (slot == "night") nightCount++
                }
            }
        } else {
            if (t.completed && !t.completedAt.isNullOrEmpty()) {
                val slot = categorizeByTimeSlot(t.completedAt)
                if (slot == "morning") morningCount++
                else if (slot == "afternoon") afternoonCount++
                else if (slot == "evening") eveningCount++
                else if (slot == "night") nightCount++
            }
        }
    }
    val totalSlots = morningCount + afternoonCount + eveningCount + nightCount
    val morningPct = if (totalSlots == 0) 0 else Math.round((morningCount.toDouble() / totalSlots) * 100).toInt()
    val afternoonPct = if (totalSlots == 0) 0 else Math.round((afternoonCount.toDouble() / totalSlots) * 100).toInt()
    val eveningPct = if (totalSlots == 0) 0 else Math.round((eveningCount.toDouble() / totalSlots) * 100).toInt()
    val nightPct = if (totalSlots == 0) 0 else Math.round((nightCount.toDouble() / totalSlots) * 100).toInt()

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        contentPadding = PaddingValues(bottom = 24.dp)
    ) {
        // Period Tabs with Dropdown Filter
        item {
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
                                    onClick = { period = key }
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
                        listOf(
                            Triple("normal", "普通待办", Color(0xFF10B981)),
                            Triple("daily", "每日重复", Color(0xFFF59E0B)),
                            Triple("weekly", "每周打卡", Color(0xFF6366F1)),
                            Triple("monthly", "每月打卡", Color(0xFFF43F5E))
                        ).forEach { (key, label, color) ->
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
                                        Box(
                                            modifier = Modifier
                                                .size(8.dp)
                                                .background(color, if (key == "normal") CircleShape else RoundedCornerShape(1.dp))
                                        )
                                        Spacer(Modifier.width(8.dp))
                                        Text(label)
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
        item {
            Spacer(Modifier.height(4.dp))
            Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = {
                    targetDate = when (period) {
                        "day" -> targetDate.minusDays(1)
                        "week" -> targetDate.minusWeeks(1)
                        else -> targetDate.minusMonths(1)
                    }
                }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Prev") }
                
                val label = when (period) {
                    "day" -> targetDate.toString()
                    "week" -> "${targetDate.get(IsoFields.WEEK_BASED_YEAR)}年 第${targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)}周"
                    else -> "${targetDate.year}年 ${targetDate.monthValue}月"
                }
                Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp))
                
                IconButton(onClick = {
                    targetDate = when (period) {
                        "day" -> targetDate.plusDays(1)
                        "week" -> targetDate.plusWeeks(1)
                        else -> targetDate.plusMonths(1)
                    }
                }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Next") }
            }
        }

        // Summary Bar
        item {
            ElevatedCard(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                shape = RoundedCornerShape(12.dp)
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text("共 ${formatVal(totalDouble)} 项，已完成 ${formatVal(completedDouble)} 项，进度 ${(progress * 100).toInt()}%", style = MaterialTheme.typography.titleSmall)
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
                }
            }
        }

        // 时段分布卡片
        item {
            val insightText = if (totalSlots == 0) {
                "☀️ 暂无已完成的任务数据"
            } else {
                var maxCount = morningCount
                var maxSlotLabel = "上午"
                var maxPct = morningPct
                if (afternoonCount > maxCount) {
                    maxCount = afternoonCount
                    maxSlotLabel = "下午"
                    maxPct = afternoonPct
                }
                if (eveningCount > maxCount) {
                    maxCount = eveningCount
                    maxSlotLabel = "晚上"
                    maxPct = eveningPct
                }
                if (nightCount > maxCount) {
                    maxCount = nightCount
                    maxSlotLabel = "深夜"
                    maxPct = nightPct
                }
                "☀️ 当前周期内你的高效时段在 ${maxSlotLabel}，占已完成任务的 ${maxPct}%"
            }
            OutlinedCard(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                shape = RoundedCornerShape(12.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
                colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f))
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text(insightText, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(8.dp))
                    
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
                            
                            // Q1 (Top-Right): 0-6 (Night)
                            drawArc(
                                color = Color(0xFF3B82F6),
                                startAngle = 270f,
                                sweepAngle = 90f,
                                useCenter = false,
                                topLeft = Offset(cx - rPx, cy - rPx),
                                size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                style = Stroke(width = strokeWidthPx),
                                alpha = if (totalSlots > 0) (if (nightCount > 0) 0.95f else 0.2f) else 0.2f
                            )
                            
                            // Q2 (Bottom-Right): 6-12 (Morning)
                            drawArc(
                                color = Color(0xFFF59E0B),
                                startAngle = 0f,
                                sweepAngle = 90f,
                                useCenter = false,
                                topLeft = Offset(cx - rPx, cy - rPx),
                                size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                style = Stroke(width = strokeWidthPx),
                                alpha = if (totalSlots > 0) (if (morningCount > 0) 0.95f else 0.2f) else 0.2f
                            )
                            
                            // Q3 (Bottom-Left): 12-18 (Afternoon)
                            drawArc(
                                color = Color(0xFF10B981),
                                startAngle = 90f,
                                sweepAngle = 90f,
                                useCenter = false,
                                topLeft = Offset(cx - rPx, cy - rPx),
                                size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                style = Stroke(width = strokeWidthPx),
                                alpha = if (totalSlots > 0) (if (afternoonCount > 0) 0.95f else 0.2f) else 0.2f
                            )
                            
                            // Q4 (Top-Left): 18-24 (Evening)
                            drawArc(
                                color = Color(0xFF6366F1),
                                startAngle = 180f,
                                sweepAngle = 90f,
                                useCenter = false,
                                topLeft = Offset(cx - rPx, cy - rPx),
                                size = androidx.compose.ui.geometry.Size(rPx * 2, rPx * 2),
                                style = Stroke(width = strokeWidthPx),
                                alpha = if (totalSlots > 0) (if (eveningCount > 0) 0.95f else 0.2f) else 0.2f
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
                            
                            paint.color = Color(0xFF3B82F6).toArgb()
                            paint.textAlign = android.graphics.Paint.Align.RIGHT
                            drawContext.canvas.nativeCanvas.drawText("深夜 (0-6): $nightPct%", 282.dp.toPx(), 25.dp.toPx(), paint)
                            
                            paint.color = Color(0xFFF59E0B).toArgb()
                            paint.textAlign = android.graphics.Paint.Align.RIGHT
                            drawContext.canvas.nativeCanvas.drawText("上午 (6-12): $morningPct%", 282.dp.toPx(), 245.dp.toPx(), paint)
                            
                            paint.color = Color(0xFF10B981).toArgb()
                            paint.textAlign = android.graphics.Paint.Align.LEFT
                            drawContext.canvas.nativeCanvas.drawText("下午 (12-18): $afternoonPct%", 8.dp.toPx(), 245.dp.toPx(), paint)
                            
                            paint.color = Color(0xFF6366F1).toArgb()
                            paint.textAlign = android.graphics.Paint.Align.LEFT
                            drawContext.canvas.nativeCanvas.drawText("晚上 (18-24): $eveningPct%", 8.dp.toPx(), 25.dp.toPx(), paint)

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
                                val px = dot.x
                                val py = dot.y
                                
                                when (dot.shape) {
                                    "circle" -> {
                                        drawCircle(
                                            color = dot.color,
                                            radius = dotRadius,
                                            center = Offset(px, py)
                                        )
                                        drawCircle(
                                            color = Color.White,
                                            radius = dotRadius,
                                            center = Offset(px, py),
                                            style = Stroke(width = strokeW)
                                        )
                                    }
                                    "triangle" -> {
                                        val path = Path().apply {
                                            moveTo(px, py - dotRadius * 1.1f)
                                            lineTo(px - dotRadius, py + dotRadius * 0.9f)
                                            lineTo(px + dotRadius, py + dotRadius * 0.9f)
                                            close()
                                        }
                                        drawPath(path = path, color = dot.color)
                                        drawPath(path = path, color = Color.White, style = Stroke(width = strokeW))
                                    }
                                    "diamond" -> {
                                        val path = Path().apply {
                                            moveTo(px, py - dotRadius * 1.1f)
                                            lineTo(px + dotRadius * 1.1f, py)
                                            lineTo(px, py + dotRadius * 1.1f)
                                            lineTo(px - dotRadius * 1.1f, py)
                                            close()
                                        }
                                        drawPath(path = path, color = dot.color)
                                        drawPath(path = path, color = Color.White, style = Stroke(width = strokeW))
                                    }
                                    "star" -> {
                                        val path = Path().apply {
                                            val spikes = 5
                                            val outerRadius = dotRadius * 1.25f
                                            val innerRadius = dotRadius * 0.6f
                                            var rot = Math.PI / 2 * 3
                                            val step = Math.PI / spikes
                                            for (i in 0 until spikes) {
                                                val px1 = px + Math.cos(rot).toFloat() * outerRadius
                                                val py1 = py + Math.sin(rot).toFloat() * outerRadius
                                                if (i == 0) moveTo(px1, py1) else lineTo(px1, py1)
                                                rot += step
                                                
                                                val px2 = px + Math.cos(rot).toFloat() * innerRadius
                                                val py2 = py + Math.sin(rot).toFloat() * innerRadius
                                                lineTo(px2, py2)
                                                rot += step
                                            }
                                            close()
                                        }
                                        drawPath(path = path, color = dot.color)
                                        drawPath(path = path, color = Color.White, style = Stroke(width = strokeW))
                                    }
                                }
                            }
                        }
                        
                        // Tooltip Pop-up overlay for Canvas dots
                        tooltipTodo?.let { todo ->
                            Popup(
                                alignment = Alignment.TopStart,
                                offset = IntOffset(tooltipOffset.x.toInt(), tooltipOffset.y.toInt() - 40.dp.value.toInt()),
                                onDismissRequest = { tooltipTodo = null }
                            ) {
                                Card(
                                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.inverseSurface),
                                    elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Column(modifier = Modifier.padding(10.dp)) {
                                        Text(todo.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.inverseOnSurface, fontWeight = FontWeight.Bold)
                                        Text("完成日期: $tooltipDate", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.8f))
                                        Text("打卡时间: $tooltipTime", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.8f))
                                    }
                                }
                            }
                        }

                        val dotRadiusDp = when (period) {
                            "day" -> 8.dp
                            "week" -> 6.dp
                            else -> 4.5.dp
                        }

                        // Left column for makeup check-ins
                        Column(
                            modifier = Modifier
                                .align(Alignment.CenterStart)
                                .padding(start = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            makeupCheckins.filterIndexed { idx, _ -> idx % 2 == 0 }.forEach { (todo, dateStr) ->
                                val color = when {
                                    todo.recurring == "daily_repeat" -> Color(0xFFF59E0B)
                                    todo.taskType == TaskType.WEEKLY_CHECKIN -> Color(0xFF6366F1)
                                    todo.taskType == TaskType.MONTHLY_CHECKIN -> Color(0xFFF43F5E)
                                    else -> Color(0xFF10B981)
                                }
                                val shape = when {
                                    todo.recurring == "daily_repeat" -> "triangle"
                                    todo.taskType == TaskType.WEEKLY_CHECKIN -> "diamond"
                                    todo.taskType == TaskType.MONTHLY_CHECKIN -> "star"
                                    else -> "circle"
                                }
                                var showTooltip by remember { mutableStateOf(false) }
                                Box(
                                    modifier = Modifier
                                        .size(22.dp)
                                        .pointerInput(todo, dateStr) {
                                            detectTapGestures(
                                                onTap = { onEditTodo(todo) },
                                                onLongPress = { showTooltip = true }
                                            )
                                        },
                                    contentAlignment = Alignment.Center
                                ) {
                                    MakeupIcon(shape = shape, color = color, dotRadius = dotRadiusDp, modifier = Modifier.size(22.dp))
                                    
                                    if (showTooltip) {
                                        Popup(
                                            alignment = Alignment.TopStart,
                                            offset = IntOffset(0, -40.dp.value.toInt()),
                                            onDismissRequest = { showTooltip = false }
                                        ) {
                                            Card(
                                                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.inverseSurface),
                                                elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
                                                shape = RoundedCornerShape(8.dp)
                                            ) {
                                                Column(modifier = Modifier.padding(10.dp)) {
                                                    Text(todo.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.inverseOnSurface, fontWeight = FontWeight.Bold)
                                                    Text("完成日期: $dateStr", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.8f))
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Right column for makeup check-ins
                        Column(
                            modifier = Modifier
                                .align(Alignment.CenterEnd)
                                .padding(end = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            makeupCheckins.filterIndexed { idx, _ -> idx % 2 == 1 }.forEach { (todo, dateStr) ->
                                val color = when {
                                    todo.recurring == "daily_repeat" -> Color(0xFFF59E0B)
                                    todo.taskType == TaskType.WEEKLY_CHECKIN -> Color(0xFF6366F1)
                                    todo.taskType == TaskType.MONTHLY_CHECKIN -> Color(0xFFF43F5E)
                                    else -> Color(0xFF10B981)
                                }
                                val shape = when {
                                    todo.recurring == "daily_repeat" -> "triangle"
                                    todo.taskType == TaskType.WEEKLY_CHECKIN -> "diamond"
                                    todo.taskType == TaskType.MONTHLY_CHECKIN -> "star"
                                    else -> "circle"
                                }
                                var showTooltip by remember { mutableStateOf(false) }
                                Box(
                                    modifier = Modifier
                                        .size(22.dp)
                                        .pointerInput(todo, dateStr) {
                                            detectTapGestures(
                                                onTap = { onEditTodo(todo) },
                                                onLongPress = { showTooltip = true }
                                            )
                                        },
                                    contentAlignment = Alignment.Center
                                ) {
                                    MakeupIcon(shape = shape, color = color, dotRadius = dotRadiusDp, modifier = Modifier.size(22.dp))
                                    
                                    if (showTooltip) {
                                        Popup(
                                            alignment = Alignment.TopEnd,
                                            offset = IntOffset(0, -40.dp.value.toInt()),
                                            onDismissRequest = { showTooltip = false }
                                        ) {
                                            Card(
                                                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.inverseSurface),
                                                elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
                                                shape = RoundedCornerShape(8.dp)
                                            ) {
                                                Column(modifier = Modifier.padding(10.dp)) {
                                                    Text(todo.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.inverseOnSurface, fontWeight = FontWeight.Bold)
                                                    Text("完成日期: $dateStr", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.8f))
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (makeupCheckinCount > 0) {
                        val periodText = when (period) {
                            "day" -> "本日"
                            "week" -> "本周"
                            else -> "本月"
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = "* ${periodText}包含 ${makeupCheckinCount} 项补打卡，已列在左右两侧，不计入时段分布统计",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                            modifier = Modifier.fillMaxWidth(),
                            textAlign = TextAlign.Center
                        )
                    }
                }
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
                    when (period) {
                        "day" -> todo.completedDates.find { it.startsWith(targetDate.toString()) }
                        "week" -> todo.completedDates.filter { dStr ->
                            try {
                                val checkDate = LocalDate.parse(dStr.take(10))
                                checkDate.get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR) && 
                                checkDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)
                            } catch (_: Exception) { false }
                        }.maxOrNull()
                        else -> todo.completedDates.filter { it.startsWith(targetMonthStr) }.maxOrNull()
                    }
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
    val todos by viewModel.todos.collectAsState()
    var throughputDays by remember { mutableIntStateOf(30) }
    var expandedDropdown by remember { mutableStateOf(false) }

    val activeTodos = remember(todos) {
        todos.filter { 
            !it.deleted && 
            it.taskType != TaskType.WEEKLY_CHECKIN && 
            it.taskType != TaskType.MONTHLY_CHECKIN &&
            it.recurring != "daily_repeat"
        }
    }
    val incompleteTodos = remember(activeTodos) {
        activeTodos.filter { !it.completed }
    }

    val nowTime = OffsetDateTime.now()
    val localTodayStart = LocalDate.now().atStartOfDay(java.time.ZoneId.systemDefault()).toOffsetDateTime()

    // Helpers to parse dates robustly
    fun parseOffsetDateTime(dtStr: String?, defaultVal: OffsetDateTime): OffsetDateTime {
        if (dtStr.isNullOrEmpty()) return defaultVal
        return try {
            OffsetDateTime.parse(dtStr)
        } catch (_: Exception) {
            try {
                OffsetDateTime.ofInstant(java.time.Instant.parse(dtStr), java.time.ZoneId.systemDefault())
            } catch (_: Exception) {
                try {
                    LocalDate.parse(dtStr.take(10)).atStartOfDay(java.time.ZoneId.systemDefault()).toOffsetDateTime()
                } catch (_: Exception) {
                    defaultVal
                }
            }
        }
    }

    // 1. Calculate current metrics
    // 1.1 平均任务寿命 (all completed tasks from creation to completion)
    val completedTodos = remember(activeTodos) {
        activeTodos.filter { it.completed && !it.completedAt.isNullOrEmpty() }
    }
    val currentAvgCompletedLife = remember(completedTodos) {
        if (completedTodos.isEmpty()) 0.0 else {
            val total = completedTodos.sumOf { t ->
                val compTime = parseOffsetDateTime(t.completedAt, nowTime)
                calcTaskAgeDays(t.createdAt, compTime).toDouble()
            }
            total / completedTodos.size
        }
    }

    // 1.2 积压任务平均时长 (incomplete tasks from creation to now)
    val currentAvgBacklogLife = remember(incompleteTodos, nowTime) {
        if (incompleteTodos.isEmpty()) 0.0 else {
            val total = incompleteTodos.sumOf { calcTaskAgeDays(it.createdAt, nowTime).toDouble() }
            total / incompleteTodos.size
        }
    }

    // 1.3 沉睡任务已在下面定义为 sleepingTodos.size

    // 2. Calculate baseline values (start of today)
    val baselineData = remember(activeTodos) {
        var baselineCompletedSum = 0.0
        var baselineCompletedCount = 0
        var baselineIncompleteSum = 0.0
        var baselineIncompleteCount = 0
        var baselineSleepingCount = 0

        activeTodos.forEach { t ->
            val createdTime = parseOffsetDateTime(t.createdAt, nowTime)
            if (createdTime.isBefore(localTodayStart)) {
                val completedTime = if (t.completed && !t.completedAt.isNullOrEmpty()) {
                    parseOffsetDateTime(t.completedAt, nowTime)
                } else null

                val wasCompletedBeforeToday = t.completed && (completedTime == null || completedTime.isBefore(localTodayStart))

                if (wasCompletedBeforeToday) {
                    if (completedTime != null) {
                        val age = calcTaskAgeDays(t.createdAt, completedTime).toDouble()
                        if (age >= 0) {
                            baselineCompletedSum += age
                            baselineCompletedCount++
                        }
                    }
                } else {
                    val age = calcTaskAgeDays(t.createdAt, localTodayStart).toDouble()
                    if (age >= 0) {
                        baselineIncompleteSum += age
                        baselineIncompleteCount++
                        if (age >= 7) {
                            baselineSleepingCount++
                        }
                    }
                }
            }
        }

        val baseAvgCompleted = if (baselineCompletedCount == 0) currentAvgCompletedLife else baselineCompletedSum / baselineCompletedCount
        val baseAvgBacklog = if (baselineIncompleteCount == 0) currentAvgBacklogLife else baselineIncompleteSum / baselineIncompleteCount
        Triple(baseAvgCompleted, baseAvgBacklog, baselineSleepingCount)
    }

    val baselineAvgCompletedLife = baselineData.first
    val baselineAvgBacklogLife = baselineData.second
    val baselineSleepingCountVal = baselineData.third

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
                shape = RoundedCornerShape(12.dp)
            ) {
                Column(
                    modifier = Modifier.padding(20.dp).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Text("清单健康度", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                shape = RoundedCornerShape(12.dp)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("新陈代谢", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
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
                        Text("新增 $addedCount 项", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("消灭 $completedCount 项", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }

                    Spacer(Modifier.height(8.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth().height(12.dp).clip(RoundedCornerShape(6.dp))
                    ) {
                        val totalThroughput = addedCount + completedCount
                        val addedWeight = if (totalThroughput == 0) 1f else addedCount.toFloat()
                        val completedWeight = if (totalThroughput == 0) 1f else completedCount.toFloat()

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
                    shape = RoundedCornerShape(12.dp)
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
                    shape = RoundedCornerShape(12.dp)
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
                    shape = RoundedCornerShape(12.dp)
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
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 8.dp)
            )
        }

        if (sleepingTodos.isEmpty()) {
            item {
                ElevatedCard(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.2f))
                ) {
                    Text(
                        text = "所有任务都在健康流转中，继续保持！",
                        style = MaterialTheme.typography.bodyMedium,
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
                            Text("已存活 $age 天", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    val color: Color,
    val shape: String
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

