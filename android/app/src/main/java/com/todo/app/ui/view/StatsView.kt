package com.todo.app.ui.view

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
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
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.temporal.IsoFields
import java.util.Locale

// ====== Top-level private helper ======

private fun formatVal(valDouble: Double): String {
    return if (valDouble % 1.0 == 0.0) valDouble.toInt().toString() else String.format(Locale.US, "%.1f", valDouble)
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
                                LocalDate.parse(dateStr).get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) &&
                                LocalDate.parse(dateStr).get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR))
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

    var totalDouble = 0.0
    var completedDouble = 0.0

    periodTodos.forEach { t ->
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

    val displayTodos = periodTodos.sortedWith(TodoComparator)

    val todayStr = LocalDate.now().toString()
    val tomorrowStr = LocalDate.now().plusDays(1).toString()

    Column(modifier = Modifier.fillMaxSize()) {
        // Period Tabs
        val tabIndex = when (period) { "day" -> 0; "week" -> 1; else -> 2 }
        TabRow(selectedTabIndex = tabIndex) {
            Tab(selected = period == "day", onClick = { period = "day" }, text = { Text("日") })
            Tab(selected = period == "week", onClick = { period = "week" }, text = { Text("周") })
            Tab(selected = period == "month", onClick = { period = "month" }, text = { Text("月") })
        }

        Spacer(Modifier.height(12.dp))

        // Date Nav
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
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

        var morningCount = 0
        var afternoonCount = 0
        var eveningCount = 0
        var nightCount = 0
        var makeupCheckinCount = 0

        periodTodos.forEach { t ->
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

                    if (inPeriod) {
                        if (dStr.length > 10) {
                            val slot = categorizeByTimeSlot(dStr)
                            if (slot == "morning") morningCount++
                            else if (slot == "afternoon") afternoonCount++
                            else if (slot == "evening") eveningCount++
                            else if (slot == "night") nightCount++
                        } else {
                            makeupCheckinCount++
                        }
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

        // Summary Bar
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

        // 时段分布卡片
        ElevatedCard(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
        ) {
            Column(modifier = Modifier.padding(14.dp)) {
                val insightText = if (totalSlots == 0) {
                    "☀️ 暂无已完成的任务数据"
                } else {
                    var maxCount = morningCount
                    var maxSlotLabel = "清晨"
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
                        maxSlotLabel = "深夜" // Note: label was "深夜" in Compose code, mapped to "night"
                        maxPct = nightPct
                    }
                    "☀️ 当前周期内你的高效时段在 ${maxSlotLabel}，占已完成任务的 ${maxPct}%"
                }
                Text(insightText, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(8.dp))
                
                // Color bar
                Row(
                    modifier = Modifier.fillMaxWidth().height(16.dp).clip(RoundedCornerShape(8.dp))
                ) {
                    val weightMorning = if (morningCount == 0 && totalSlots == 0) 1f else morningCount.toFloat()
                    val weightAfternoon = if (afternoonCount == 0 && totalSlots == 0) 1f else afternoonCount.toFloat()
                    val weightEvening = if (eveningCount == 0 && totalSlots == 0) 1f else eveningCount.toFloat()
                    val weightNight = if (nightCount == 0 && totalSlots == 0) 1f else nightCount.toFloat()

                    Box(modifier = Modifier.weight(weightMorning).fillMaxHeight().background(Color(0xFFF59E0B)))
                    Box(modifier = Modifier.weight(weightAfternoon).fillMaxHeight().background(Color(0xFF7B61FF)))
                    Box(modifier = Modifier.weight(weightEvening).fillMaxHeight().background(Color(0xFF6366F1)))
                    Box(modifier = Modifier.weight(weightNight).fillMaxHeight().background(Color(0xFF3B82F6)))
                }
                
                Spacer(Modifier.height(4.dp))
                
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("清晨: $morningPct%", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("下午: $afternoonPct%", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("晚上: $eveningPct%", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("深夜: $nightPct%", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }

                if (makeupCheckinCount > 0) {
                    val periodText = when (period) {
                        "day" -> "本日"
                        "week" -> "本周"
                        else -> "本月"
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "* ${periodText}包含 ${makeupCheckinCount} 项补打卡，不计入时段分布统计",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.Center
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        // List
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(displayTodos, key = { it.id }) { todo ->
                TodoItemRow(
                    todo = todo,
                    viewModel = viewModel,
                    onEdit = { onEditTodo(todo) },
                    onMoveToTomorrow = {
                        viewModel.updateTodo(todo.copy(date = tomorrowStr, updatedAt = nowIso()))
                    },
                    todayStr = todayStr,
                    tomorrowStr = tomorrowStr
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

    val activeTodos = remember(todos) { todos.filter { !it.deleted } }
    val incompleteTodos = remember(activeTodos) {
        val currentWeekStr = weekStringOf(LocalDate.now())
        val currentMonthStr = monthStringOf(LocalDate.now())
        activeTodos.filter { t ->
            if (t.completed) {
                false
            } else {
                // 排除过期的周/月打卡任务 (不管是否限定了次数)
                if (t.taskType == TaskType.WEEKLY_CHECKIN && t.date != null && t.date!! < currentWeekStr) {
                    false
                } else if (t.taskType == TaskType.MONTHLY_CHECKIN && t.date != null && t.date!! < currentMonthStr) {
                    false
                } else {
                    // 排除没有设定次数目标的打卡任务 (未过期时)
                    !((t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) && t.targetCount == null)
                }
            }
        }
    }

    val nowTime = OffsetDateTime.now()

    // 1. Average age
    val totalAge = incompleteTodos.sumOf { calcTaskAgeDays(it.createdAt, nowTime).toDouble() }
    val avgAge = if (incompleteTodos.isEmpty()) 0.0 else totalAge / incompleteTodos.size

    // 2. Health Grade
    val healthGrade = getHealthGrade(avgAge)

    // 3. Throughput calculation
    val thresholdDate = nowTime.minusDays(throughputDays.toLong())
    var addedCount = 0
    var completedCount = 0
    
    activeTodos.forEach { t ->
        // 排除周/月打卡任务
        if (t.taskType == TaskType.WEEKLY_CHECKIN || t.taskType == TaskType.MONTHLY_CHECKIN) {
            return@forEach
        }
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

                        Box(modifier = Modifier.weight(addedWeight).fillMaxHeight().background(Color(0xFF3B82F6)))
                        Box(modifier = Modifier.weight(completedWeight).fillMaxHeight().background(Color(0xFF10B981)))
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
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                ElevatedCard(
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("⏱️", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text(String.format(Locale.US, "%.1f 天", avgAge), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(2.dp))
                        Text("平均任务寿命", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                ElevatedCard(
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(12.dp).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("💤", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(4.dp))
                        Text("${sleepingTodos.size} 项", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(2.dp))
                        Text("沉睡任务", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
