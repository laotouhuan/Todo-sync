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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.draw.shadow
import androidx.compose.animation.core.animateDpAsState
import org.burnoutcrew.reorderable.rememberReorderableLazyListState
import org.burnoutcrew.reorderable.reorderable
import org.burnoutcrew.reorderable.ReorderableItem
import org.burnoutcrew.reorderable.detectReorderAfterLongPress
import com.todo.app.data.model.Todo
import com.todo.app.data.model.DateStrings
import com.todo.app.data.model.TodoComparator
import com.todo.app.data.model.isOverdue
import com.todo.app.data.model.groupTodosByDate
import com.todo.app.data.model.getDateLabel
import com.todo.app.data.model.getCompletionStatusLabel
import com.todo.app.data.model.isWeekDate
import com.todo.app.data.model.isMonthDate
import com.todo.app.data.model.nowInstant
import com.todo.app.data.model.nowIso
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.LocalDate

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

    val dates = remember { DateStrings.now() }
    val todayStr = dates.today
    val thisWeekStr = dates.thisWeek
    val thisMonthStr = dates.thisMonth

    val todayTasksOriginal = remember(todos, todayStr) {
        val filtered = todos.filter {
            it.date == todayStr || it.isOverdue(todayStr) || it.date == null
        }
        val hasDate = filtered.filter { it.date != null }.sortedWith(TodoComparator)
        val noDate = filtered.filter { it.date == null }.sortedWith(TodoComparator)
        
        val list = mutableListOf<Todo>()
        list.addAll(hasDate)
        list.add(Todo(id = "SEPARATOR", content = "SEPARATOR", created_at = "", updated_at = ""))
        list.addAll(noDate)
        list
    }
    var reorderableTodayTasks by remember { mutableStateOf(todayTasksOriginal) }
    
    val reorderState = rememberReorderableLazyListState(
        onMove = { from, to ->
            val fromId = from.key as? String ?: return@rememberReorderableLazyListState
            val toId = to.key as? String ?: return@rememberReorderableLazyListState
            val fromIndex = reorderableTodayTasks.indexOfFirst { it.id == fromId }
            val toIndex = reorderableTodayTasks.indexOfFirst { it.id == toId }
            if (fromIndex != -1 && toIndex != -1) {
                if (fromId == "SEPARATOR") return@rememberReorderableLazyListState
                reorderableTodayTasks = reorderableTodayTasks.toMutableList().apply {
                    add(toIndex, removeAt(fromIndex))
                }
            }
        },
        canDragOver = { draggedOver, _ -> 
            reorderableTodayTasks.any { it.id == draggedOver.key }
        },
        onDragEnd = { _, _ ->
            val sepIndex = reorderableTodayTasks.indexOfFirst { it.id == "SEPARATOR" }
            val updatedList = mutableListOf<Todo>()
            reorderableTodayTasks.forEachIndexed { index, todo ->
                if (todo.id == "SEPARATOR") return@forEachIndexed
                var newDate = todo.date
                if (sepIndex != -1) {
                    if (index < sepIndex && todo.date == null) {
                        newDate = todayStr
                    } else if (index > sepIndex && todo.date != null && !isWeekDate(todo.date) && !isMonthDate(todo.date)) {
                        newDate = null
                    }
                }
                val newOrder = index.toDouble()
                if (todo.order != newOrder || todo.date != newDate) {
                    updatedList.add(todo.copy(order = newOrder, date = newDate))
                }
            }
            if (updatedList.isNotEmpty()) {
                viewModel.batchUpdateTodos(updatedList)
            }
        }
    )

    val isDragging = reorderState.draggingItemKey != null
    LaunchedEffect(todayTasksOriginal) {
        if (!isDragging) {
            reorderableTodayTasks = todayTasksOriginal
        }
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
            val filtered = remember(todos, todayStr, thisWeekStr, thisMonthStr) {
                todos.filter {
                    it.date == todayStr || it.isOverdue(todayStr) || it.date == null || it.date == thisWeekStr || it.date == thisMonthStr
                }.sortedWith(TodoComparator)
            }

            val sortedGroups = remember(todos, todayStr) {
                val groups = groupTodosByDate(todos, todayStr)
                val dateComparatorAsc = Comparator<Todo> { a, b ->
                    val dateCmp = (a.date ?: "").compareTo(b.date ?: "")
                    if (dateCmp != 0) dateCmp else TodoComparator.compare(a, b)
                }
                val pastComparator = Comparator<Todo> { a, b ->
                    if (a.completed != b.completed) return@Comparator if (a.completed) 1 else -1
                    val dateCmp = (b.date ?: "").compareTo(a.date ?: "")
                    if (dateCmp != 0) dateCmp else TodoComparator.compare(a, b)
                }
                listOf(
                    groups.today.sortedWith(TodoComparator),
                    groups.noDate.sortedWith(TodoComparator),
                    groups.week.sortedWith(TodoComparator),
                    groups.month.sortedWith(TodoComparator),
                    groups.future.sortedWith(dateComparatorAsc),
                    groups.past.sortedWith(pastComparator)
                )
            }
            val sortedToday = sortedGroups[0]
            val sortedNoDate = sortedGroups[1]
            val sortedWeek = sortedGroups[2]
            val sortedMonth = sortedGroups[3]
            val sortedFuture = sortedGroups[4]
            val sortedPast = sortedGroups[5]

            LazyColumn(
                state = reorderState.listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).reorderable(reorderState)
            ) {
                val tomorrowStr = dates.tomorrow
                val todoItem: @Composable (Todo) -> Unit = { todo ->
                    TodoItemRow(
                        todo = todo,
                        viewModel = viewModel,
                        onEdit = { showEditDialogFor = todo },
                        onMoveToTomorrow = { viewModel.updateTodo(todo.copy(date = tomorrowStr)) },
                        todayStr = todayStr,
                        tomorrowStr = tomorrowStr
                    )
                }

                if (selectedTab == 0) {

                    
                    item { GroupHeader("今日任务", Color(0xFF1890FF), expandToday) { expandToday = !expandToday } }
                    if (expandToday) {
                        items(
                            items = reorderableTodayTasks,
                            key = { it.id }
                        ) { item ->
                            if (item.id == "SEPARATOR") {
                                ReorderableItem(reorderState, key = item.id) {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 12.dp, vertical = 12.dp)
                                            .height(2.dp)
                                            .background(Color.LightGray.copy(alpha = 0.5f), RoundedCornerShape(2.dp))
                                    )
                                }
                            } else {
                                ReorderableItem(reorderState, key = item.id) { isDragging ->
                                    val elevation by animateDpAsState(if (isDragging) 8.dp else 0.dp)
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .shadow(elevation, RoundedCornerShape(12.dp))
                                            .detectReorderAfterLongPress(reorderState)
                                    ) {
                                        TodoItemRow(
                                            todo = item,
                                            viewModel = viewModel,
                                            onEdit = { showEditDialogFor = item },
                                            onMoveToTomorrow = {
                                                viewModel.updateTodo(item.copy(date = dates.tomorrow))
                                            },
                                            todayStr = todayStr,
                                            tomorrowStr = dates.tomorrow
                                        )
                                    }
                                }
                            }
                        }
                    }


                    item { GroupHeader("本周任务", Color(0xFFFADB14), expandWeek) { expandWeek = !expandWeek } }
                    if (expandWeek) {
                        items(
                            items = filtered.filter { it.date == thisWeekStr },
                            key = { it.id }
                        ) { todoItem(it) }
                    }
                    item { GroupHeader("本月任务", Color(0xFFFF7A45), expandMonth) { expandMonth = !expandMonth } }
                    if (expandMonth) {
                        items(
                            items = filtered.filter { it.date == thisMonthStr },
                            key = { it.id }
                        ) { todoItem(it) }
                    }
                } else {

                    if (sortedToday.isNotEmpty()) {
                        item { GroupHeader("今天", MaterialTheme.colorScheme.onSurface, true, null) }
                        items(items = sortedToday, key = { it.id }) { todoItem(it) }
                    }
                    if (sortedNoDate.isNotEmpty()) {
                        item { GroupHeader("无日期", Color.Gray, true, null) }
                        items(items = sortedNoDate, key = { it.id }) { todoItem(it) }
                    }
                    if (sortedWeek.isNotEmpty()) {
                        item { GroupHeader("周任务", Color(0xFFFADB14), true, null) }
                        items(items = sortedWeek, key = { it.id }) { todoItem(it) }
                    }
                    if (sortedMonth.isNotEmpty()) {
                        item { GroupHeader("月任务", Color(0xFFFADB14), true, null) }
                        items(items = sortedMonth, key = { it.id }) { todoItem(it) }
                    }
                    if (sortedFuture.isNotEmpty()) {
                        item { GroupHeader("未来计划", MaterialTheme.colorScheme.onSurface, true, null) }
                        items(items = sortedFuture, key = { it.id }) { todoItem(it) }
                    }
                    if (sortedPast.isNotEmpty()) {
                        item { GroupHeader("过往记忆", Color.Gray, true, null) }
                        items(items = sortedPast, key = { it.id }) { todoItem(it) }
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
fun TodoItemRow(
    todo: Todo,
    viewModel: TodoViewModel,
    onEdit: () -> Unit,
    onMoveToTomorrow: () -> Unit,
    todayStr: String = "",
    tomorrowStr: String = ""
) {
    val coroutineScope = rememberCoroutineScope()
    val offsetX = remember { Animatable(0f) }
    val density = androidx.compose.ui.platform.LocalDensity.current.density
    val maxSwipePx = -60f * density
    var expanded by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .background(Color.Transparent)
    ) {
        Row(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .padding(end = 16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = { 
                    coroutineScope.launch { offsetX.animateTo(0f) }
                    onEdit() 
                },
                modifier = Modifier.size(40.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape)
            ) {
                Icon(Icons.Filled.Edit, contentDescription = "修改", tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(20.dp))
            }
        }

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .offset { IntOffset(offsetX.value.roundToInt(), 0) }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            coroutineScope.launch {
                                // 降低触发阈值，用户只要滑动 20% 即可自动弹开
                                if (offsetX.value < maxSwipePx / 5) {
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
                },
            elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column {
                Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = todo.completed, onCheckedChange = { viewModel.toggleTodoStatus(todo.id) })
                    Column(modifier = Modifier.weight(1f).clickable { 
                        if (todo.subtasks.isNotEmpty()) expanded = !expanded
                    }) {
                        Text(
                            text = todo.content, 
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (todo.completed) Color.Gray else MaterialTheme.colorScheme.onSurface,
                            textDecoration = if (todo.completed) androidx.compose.ui.text.style.TextDecoration.LineThrough else null
                        )
                        val meta = mutableListOf<String>()
                        todo.date?.let {
                            val dateLabel = todo.getDateLabel(todayStr, tomorrowStr)
                            val statusLabel = todo.getCompletionStatusLabel()
                            val label = if (statusLabel != null) "📅 $dateLabel ($statusLabel)" else "📅 $dateLabel"
                            meta.add(label)
                        }
                        if (todo.recurring != "none") meta.add("🔄")
                        if (todo.subtasks.isNotEmpty()) meta.add("📋 ${todo.subtasks.count { it.completed }}/${todo.subtasks.size}")
                        if (meta.isNotEmpty()) {
                            Text(text = meta.joinToString(" | "), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                        }
                    }
                }
                
                if (expanded && todo.subtasks.isNotEmpty()) {
                    Divider(modifier = Modifier.padding(horizontal = 12.dp))
                    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                        todo.subtasks.forEachIndexed { index, sub ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                                Checkbox(
                                    checked = sub.completed,
                                    onCheckedChange = { isChecked ->
                                        val newSubs = todo.subtasks.toMutableList()
                                        newSubs[index] = sub.copy(completed = isChecked)
                                        
                                        val allCompleted = newSubs.isNotEmpty() && newSubs.all { s -> s.completed }
                                        val parentCompleted = if (allCompleted && !todo.completed) true else todo.completed
                                        val parentCompletedAt = if (allCompleted && !todo.completed) nowInstant() else todo.completed_at

                                        viewModel.updateTodo(todo.copy(
                                            subtasks = newSubs,
                                            completed = parentCompleted,
                                            completed_at = parentCompletedAt,
                                            updated_at = nowIso()
                                        ))
                                    },
                                    modifier = Modifier.size(24.dp)
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = sub.content,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = if (sub.completed) Color.Gray else MaterialTheme.colorScheme.onSurface,
                                    textDecoration = if (sub.completed) androidx.compose.ui.text.style.TextDecoration.LineThrough else null
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
