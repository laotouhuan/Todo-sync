package com.todo.app.ui.view

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Todo
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.LocalDate
import java.time.temporal.WeekFields
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListView(viewModel: TodoViewModel) {
    val todos by viewModel.todos.collectAsState()
    val isSyncing by viewModel.isSyncing.collectAsState()
    var selectedTab by remember { mutableStateOf(0) }
    var showEditDialogFor by remember { mutableStateOf<Todo?>(null) }
    
    var expandToday by remember { mutableStateOf(true) }
    var expandWeek by remember { mutableStateOf(false) }
    var expandMonth by remember { mutableStateOf(false) }
    
    val todayStr = LocalDate.now().toString()
    val thisWeekStr = run {
        val date = LocalDate.now()
        val week = date.get(WeekFields.of(Locale.getDefault()).weekOfYear())
        "${date.year}-W${week.toString().padStart(2, '0')}"
    }
    val thisMonthStr = run {
        val date = LocalDate.now()
        "${date.year}-${date.monthValue.toString().padStart(2, '0')}"
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TabRow(selectedTabIndex = selectedTab, modifier = Modifier.weight(1f)) {
                Tab(selected = selectedTab == 0, onClick = { selectedTab = 0 }, text = { Text("今天聚焦") })
                Tab(selected = selectedTab == 1, onClick = { selectedTab = 1 }, text = { Text("全部待办") })
            }
            IconButton(onClick = { viewModel.syncWithCloud() }) {
                if (isSyncing) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Filled.Refresh, contentDescription = "同步", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
        
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                if (selectedTab == 0) {
                    val filtered = todos.filter {
                        val isOverdue = it.date != null && it.date!! < todayStr && !it.completed && !it.date!!.contains("-W") && it.date!!.length != 7
                        it.date == todayStr || isOverdue || it.date == null || it.date == thisWeekStr || it.date == thisMonthStr
                    }.sortedWith(TodoComparator)
                    
                    item { GroupHeader("今日任务", Color(0xFF1890FF), expandToday) { expandToday = !expandToday } }
                    if (expandToday) {
                        items(filtered.filter { it.date != thisWeekStr && it.date != thisMonthStr }) { 
                            TodoItemRow(it, viewModel) { showEditDialogFor = it }
                        }
                    }
                    item { GroupHeader("本周任务", Color(0xFFFADB14), expandWeek) { expandWeek = !expandWeek } }
                    if (expandWeek) {
                        items(filtered.filter { it.date == thisWeekStr }) { 
                            TodoItemRow(it, viewModel) { showEditDialogFor = it }
                        }
                    }
                    item { GroupHeader("本月任务", Color(0xFFFF7A45), expandMonth) { expandMonth = !expandMonth } }
                    if (expandMonth) {
                        items(filtered.filter { it.date == thisMonthStr }) { 
                            TodoItemRow(it, viewModel) { showEditDialogFor = it }
                        }
                    }
                } else {
                    val sorted = todos.sortedWith(TodoComparator)
                    item { GroupHeader("所有任务", Color.Gray, true, null) }
                    items(sorted) { 
                        TodoItemRow(it, viewModel) { showEditDialogFor = it }
                    }
                }
            }
        }
        
        // Smart Add Input
        var addInput by remember { mutableStateOf("") }
        Surface(tonalElevation = 8.dp) {
            Row(modifier = Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = addInput,
                    onValueChange = { addInput = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("添加待办") },
                    singleLine = true
                )
                Spacer(modifier = Modifier.width(8.dp))
                IconButton(onClick = {
                    viewModel.addTodoSmart(addInput)
                    addInput = ""
                }) {
                    Icon(Icons.Filled.Add, contentDescription = "Add")
                }
            }
        }
    }

    showEditDialogFor?.let { todo ->
        EditTodoDialog(
            todo = todo,
            onDismiss = { showEditDialogFor = null },
            onSave = { updated -> 
                viewModel.updateTodo(updated)
                showEditDialogFor = null 
            },
            onDelete = {
                viewModel.deleteTodo(todo.id)
                showEditDialogFor = null
            }
        )
    }
}

val TodoComparator = Comparator<Todo> { a, b ->
    if (a.completed != b.completed) return@Comparator if (a.completed) 1 else -1
    val scoreA = a.importance + a.urgency
    val scoreB = b.importance + b.urgency
    if (scoreA != scoreB) return@Comparator scoreB - scoreA
    b.created_at.compareTo(a.created_at)
}

@Composable
fun GroupHeader(title: String, color: Color, isExpanded: Boolean = true, onClick: (() -> Unit)? = null) {
    Surface(
        color = color.copy(alpha = 0.1f),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = title, 
                color = color, 
                style = MaterialTheme.typography.titleMedium
            )
            if (onClick != null) {
                Icon(
                    imageVector = if (isExpanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                    contentDescription = "Toggle",
                    tint = color
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodoItemRow(todo: Todo, viewModel: TodoViewModel, onClick: () -> Unit) {
    val coroutineScope = rememberCoroutineScope()
    val offsetX = remember { Animatable(0f) }
    val density = androidx.compose.ui.platform.LocalDensity.current.density
    val maxSwipePx = -80f * density

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .background(Color.Red, RoundedCornerShape(12.dp))
    ) {
        Box(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .width(80.dp)
                .clickable { viewModel.deleteTodo(todo.id) },
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Filled.Delete, contentDescription = "删除", tint = Color.White)
        }

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .offset { IntOffset(offsetX.value.roundToInt(), 0) }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            coroutineScope.launch {
                                if (offsetX.value < maxSwipePx / 2) {
                                    offsetX.animateTo(maxSwipePx)
                                } else {
                                    offsetX.animateTo(0f)
                                }
                            }
                        }
                    ) { change, dragAmount ->
                        change.consume()
                        coroutineScope.launch {
                            val newValue = (offsetX.value + dragAmount).coerceIn(maxSwipePx, 0f)
                            offsetX.snapTo(newValue)
                        }
                    }
                }
                .clickable {
                    if (offsetX.value < -5f) {
                        coroutineScope.launch { offsetX.animateTo(0f) }
                    } else {
                        onClick()
                    }
                },
            elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = todo.completed, onCheckedChange = { viewModel.toggleTodoStatus(todo.id) })
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = todo.content, 
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (todo.completed) Color.Gray else MaterialTheme.colorScheme.onSurface,
                    textDecoration = if (todo.completed) androidx.compose.ui.text.style.TextDecoration.LineThrough else null
                )
                val meta = mutableListOf<String>()
                todo.date?.let { meta.add("📅 $it") }
                if (todo.recurring != "none") meta.add("🔄")
                if (todo.subtasks.isNotEmpty()) meta.add("📋 ${todo.subtasks.count { it.completed }}/${todo.subtasks.size}")
                if (meta.isNotEmpty()) {
                    Text(text = meta.joinToString(" | "), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                }
            }
            val severityColor = when (todo.importance + todo.urgency) {
                6 -> Color(0xFFF5222D) // 高重要高紧急
                5 -> Color(0xFFFA8C16)
                4 -> Color(0xFFFADB14)
                3 -> Color(0xFF52C41A)
                else -> Color.Gray
            }
            Surface(modifier = Modifier.size(12.dp), shape = androidx.compose.foundation.shape.CircleShape, color = severityColor) {}
        }
    }
    }
}
