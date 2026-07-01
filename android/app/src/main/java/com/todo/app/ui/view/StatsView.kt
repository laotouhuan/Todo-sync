package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import com.todo.app.ui.viewmodel.TodoViewModel
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoComparator
import com.todo.app.data.model.isOverdue
import com.todo.app.data.model.weekStringOf
import com.todo.app.data.model.monthStringOf
import java.time.LocalDate
import java.time.temporal.IsoFields
import java.util.Locale

@Composable
fun StatsView(viewModel: TodoViewModel) {
    val todos by viewModel.todos.collectAsState()
    var period by remember { mutableStateOf("day") }
    var targetDate by remember { mutableStateOf(LocalDate.now()) }
    var filterStatus by remember { mutableStateOf("all") } // all, completed, uncompleted
    var showEditDialogFor by remember { mutableStateOf<Todo?>(null) }

    val targetWeekStr = weekStringOf(targetDate)
    val targetMonthStr = monthStringOf(targetDate)

    val periodTodos = when (period) {
        "day" -> todos.filter { it.date == targetDate.toString() }
        "week" -> todos.filter { t ->
            val dateStr = t.date
            dateStr == targetWeekStr || (dateStr?.length == 10 && dateStr.startsWith(targetWeekStr.substring(0,4)) && 
                LocalDate.parse(dateStr).get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) &&
                LocalDate.parse(dateStr).get(IsoFields.WEEK_BASED_YEAR) == targetDate.get(IsoFields.WEEK_BASED_YEAR))
        }
        else -> todos.filter { t ->
            val dateStr = t.date
            dateStr == targetMonthStr || (dateStr?.length == 10 && dateStr.startsWith(targetMonthStr))
        }
    }

    var totalDouble = 0.0
    var completedDouble = 0.0
    var overdueCount = 0

    periodTodos.forEach { t ->
        totalDouble += 1.0
        
        if (t.task_type == "weekly_checkin" || t.task_type == "monthly_checkin") {
            var periodCheckinCount = 0
            t.completed_dates.forEach { dStr ->
                when (period) {
                    "day" -> {
                        if (dStr == targetDate.toString()) periodCheckinCount++
                    }
                    "week" -> {
                        try {
                            val checkDate = LocalDate.parse(dStr)
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

            if (t.target_count != null) {
                completedDouble += Math.min(1.0, periodCheckinCount.toDouble() / t.target_count!!.toDouble())
            } else {
                completedDouble += if (periodCheckinCount >= 1) 1.0 else 0.0
            }
        } else {
            if (t.completed) completedDouble += 1.0
            if (t.isOverdue(LocalDate.now().toString())) overdueCount++
        }
    }

    val progress = if (totalDouble == 0.0) 0f else (completedDouble / totalDouble).toFloat()
    
    fun formatVal(valDouble: Double): String {
        return if (valDouble % 1.0 == 0.0) valDouble.toInt().toString() else String.format(Locale.US, "%.1f", valDouble)
    }

    val displayTodos = when (filterStatus) {
        "completed" -> periodTodos.filter { it.completed }
        "uncompleted" -> periodTodos.filter { !it.completed }
        else -> periodTodos
    }.sortedWith(TodoComparator)

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        // Period Tabs
        val tabIndex = when (period) { "day" -> 0; "week" -> 1; else -> 2 }
        TabRow(selectedTabIndex = tabIndex) {
            Tab(selected = period == "day", onClick = { period = "day" }, text = { Text("日") })
            Tab(selected = period == "week", onClick = { period = "week" }, text = { Text("周") })
            Tab(selected = period == "month", onClick = { period = "month" }, text = { Text("月") })
        }

        Spacer(Modifier.height(16.dp))

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

        // Filter Status
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            SegmentedButton(listOf("全部", "已完成", "待完成"), when (filterStatus) {
                "completed" -> 1
                "uncompleted" -> 2
                else -> 0
            }) { idx ->
                filterStatus = when (idx) {
                    1 -> "completed"
                    2 -> "uncompleted"
                    else -> "all"
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Summary Bar
        ElevatedCard(
            modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
            shape = RoundedCornerShape(16.dp),
            elevation = CardDefaults.elevatedCardElevation(defaultElevation = 6.dp)
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("共 ${formatVal(totalDouble)} 项，已完成 ${formatVal(completedDouble)} 项，其中逾期 $overdueCount 项", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    LinearProgressIndicator(
                        progress = { progress }, 
                        modifier = Modifier.weight(1f).height(12.dp),
                        strokeCap = StrokeCap.Round,
                        color = MaterialTheme.colorScheme.primary,
                        trackColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                    Spacer(Modifier.width(16.dp))
                    Text("${(progress * 100).toInt()}%", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                }
            }
        }

        // List
        val todayStr = LocalDate.now().toString()
        val tomorrowStr = LocalDate.now().plusDays(1).toString()
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(displayTodos) { todo ->
                TodoItemRow(
                    todo = todo,
                    viewModel = viewModel,
                    onEdit = { showEditDialogFor = todo },
                    onMoveToTomorrow = {
                        viewModel.updateTodo(todo.copy(date = tomorrowStr))
                    },
                    todayStr = todayStr,
                    tomorrowStr = tomorrowStr
                )
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
