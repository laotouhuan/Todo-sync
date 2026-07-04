package com.todo.app.ui.view

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Clear
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
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.draw.clip
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
import com.todo.app.data.model.getWeeklyCompletedCount
import com.todo.app.data.model.getMonthlyCompletedCount
import com.todo.app.data.model.getMonthCalendarDates
import com.todo.app.data.model.getThisWeekDates
import com.todo.app.data.model.getThisMonthDates
import com.todo.app.data.model.withToggledCheckinDate
import com.todo.app.data.model.classifyForTodayFocus
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.LocalDate

sealed class FocusItem {
    abstract val key: String

    data class Header(
        override val key: String,
        val title: String,
        val color: androidx.compose.ui.graphics.Color,
        val isExpanded: Boolean,
        val onToggleExpand: () -> Unit
    ) : FocusItem()

    data class Task(
        val todo: Todo
    ) : FocusItem() {
        override val key: String get() = todo.id
    }

    data class EmptyPlaceholder(
        override val key: String,
        val message: String,
        val period: String
    ) : FocusItem()
}

@Composable
fun ListView(viewModel: TodoViewModel) {
    ClassicListView(viewModel)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClassicListView(viewModel: TodoViewModel) {
    val todos by viewModel.todos.collectAsState()
    val isSyncing by viewModel.isSyncing.collectAsState()
    var selectedTab by remember { mutableStateOf(0) }
    var showEditDialogFor by remember { mutableStateOf<Todo?>(null) }

    var expandToday by remember { mutableStateOf(true) }
    var expandWeek by remember { mutableStateOf(false) }
    var expandMonth by remember { mutableStateOf(false) }
    var expandFuture by remember { mutableStateOf(false) }
    var expandNoDate by remember { mutableStateOf(true) }
    var expandPast by remember { mutableStateOf(false) }
    val completedCollapsed = remember { mutableStateMapOf<String, Boolean>() }

    val dates = remember { DateStrings.now() }
    val todayStr = dates.today
    val thisWeekStr = dates.thisWeek
    val thisMonthStr = dates.thisMonth

    // Search and All Todos states
    var searchQuery by remember { mutableStateOf("") }
    var showSearchBar by remember { mutableStateOf(false) }
    var allTabMode by remember { mutableStateOf("uncompleted") } // "uncompleted", "completed"
    var showAllHistory by remember { mutableStateOf(false) }
    var hoveredHeaderKey by remember { mutableStateOf<String?>(null) }

    val filteredTodos = remember(todos, searchQuery) {
        if (searchQuery.isBlank()) todos else todos.filter { it.content.contains(searchQuery, ignoreCase = true) }
    }

    val filtered = remember(filteredTodos, todayStr, thisWeekStr, thisMonthStr) {
        filteredTodos.filter {
            val completedToday = it.completed && it.completed_at?.startsWith(todayStr) == true
            val wasOverdue = it.date != null && it.date!! < todayStr && !isWeekDate(it.date!!) && !isMonthDate(it.date!!)
            val isOverdueCompletedToday = completedToday && wasOverdue

            it.date == todayStr 
                || it.isOverdue(todayStr) 
                || it.date == null 
                || it.date == thisWeekStr 
                || it.date == thisMonthStr 
                || isOverdueCompletedToday
        }.sortedWith(TodoComparator)
    }

    val focusItemsOriginal = remember(filtered, todayStr, thisWeekStr, thisMonthStr, expandToday, expandNoDate, expandWeek, expandMonth) {
        val groups = classifyForTodayFocus(filtered, todayStr, thisWeekStr, thisMonthStr)
        val todayTasks = groups.todayTasks
        val noDateTasks = groups.noDateTasks
        val weekTasks = groups.weekTasks
        val monthTasks = groups.monthTasks

        val list = mutableListOf<FocusItem>()

        // 1. Today Tasks
        list.add(FocusItem.Header("HEADER_TODAY", "今日任务", Color(0xFF1890FF), expandToday, { expandToday = !expandToday }))
        if (expandToday) {
            list.addAll(todayTasks.map { FocusItem.Task(it) })
        }

        // 2. No Date Tasks
        list.add(FocusItem.Header("HEADER_NODATE", "无日期任务", Color.Gray, expandNoDate, { expandNoDate = !expandNoDate }))
        if (expandNoDate) {
            list.addAll(noDateTasks.map { FocusItem.Task(it) })
        }

        // 3. Week Tasks
        list.add(FocusItem.Header("HEADER_WEEK", "本周任务", Color(0xFFFADB14), expandWeek, { expandWeek = !expandWeek }))
        if (expandWeek) {
            if (weekTasks.isEmpty()) {
                list.add(FocusItem.EmptyPlaceholder("PLACEHOLDER_WEEK", "本周无打卡计划，您可从上期导入", "weekly"))
            } else {
                list.addAll(weekTasks.map { FocusItem.Task(it) })
            }
        }

        // 4. Month Tasks
        list.add(FocusItem.Header("HEADER_MONTH", "本月任务", Color(0xFFFF7A45), expandMonth, { expandMonth = !expandMonth }))
        if (expandMonth) {
            if (monthTasks.isEmpty()) {
                list.add(FocusItem.EmptyPlaceholder("PLACEHOLDER_MONTH", "本月无打卡计划，您可从上期导入", "monthly"))
            } else {
                list.addAll(monthTasks.map { FocusItem.Task(it) })
            }
        }

        list
    }

    var reorderableFocusItems by remember { mutableStateOf<List<FocusItem>>(emptyList()) }
    var activeDraggingKey by remember { mutableStateOf<String?>(null) }
    val reorderState = rememberReorderableLazyListState(
        onMove = { from, to ->
            val fromKey = from.key as? String ?: return@rememberReorderableLazyListState
            val toKey = to.key as? String ?: return@rememberReorderableLazyListState

            // Set hover state during drag (do NOT expand immediately)
            if (toKey.startsWith("HEADER_")) {
                hoveredHeaderKey = toKey
            } else {
                hoveredHeaderKey = null
            }

            val fromIndex = reorderableFocusItems.indexOfFirst { it.key == fromKey }
            val toIndex = reorderableFocusItems.indexOfFirst { it.key == toKey }
            if (fromIndex != -1 && toIndex != -1) {
                if (reorderableFocusItems[fromIndex] is FocusItem.Task) {
                    reorderableFocusItems = reorderableFocusItems.toMutableList().apply {
                        add(toIndex, removeAt(fromIndex))
                    }
                }
            }
        },
        onDragEnd = { _, _ ->
            val droppedHeader = hoveredHeaderKey
            hoveredHeaderKey = null

            val draggedKey = activeDraggingKey
            activeDraggingKey = null

            // If dropped on a header, transfer category and auto-expand
            if (droppedHeader != null && draggedKey != null) {
                when (droppedHeader) {
                    "HEADER_TODAY" -> if (!expandToday) expandToday = true
                    "HEADER_NODATE" -> if (!expandNoDate) expandNoDate = true
                    "HEADER_WEEK" -> if (!expandWeek) expandWeek = true
                    "HEADER_MONTH" -> if (!expandMonth) expandMonth = true
                }

                val targetTodo = todos.find { it.id == draggedKey }
                if (targetTodo != null) {
                    var targetDate = targetTodo.date
                    var targetType = targetTodo.task_type
                    var targetRecurring = targetTodo.recurring

                    when (droppedHeader) {
                        "HEADER_TODAY" -> {
                            targetType = "normal"
                            if (targetTodo.task_type == "weekly_checkin" || targetTodo.task_type == "monthly_checkin") {
                                targetRecurring = "none"
                            }
                            if (targetDate == null || isWeekDate(targetDate) || isMonthDate(targetDate)) {
                                targetDate = todayStr
                            }
                        }
                        "HEADER_NODATE" -> {
                            targetType = "normal"
                            if (targetTodo.task_type == "weekly_checkin" || targetTodo.task_type == "monthly_checkin") {
                                targetRecurring = "none"
                            }
                            targetDate = null
                        }
                        "HEADER_WEEK" -> {
                            targetType = "weekly_checkin"
                            targetRecurring = "none"
                            if (targetDate == null || !isWeekDate(targetDate)) {
                                targetDate = thisWeekStr
                            }
                        }
                        "HEADER_MONTH" -> {
                            targetType = "monthly_checkin"
                            targetRecurring = "none"
                            if (targetDate == null || !isMonthDate(targetDate)) {
                                targetDate = thisMonthStr
                            }
                        }
                    }

                    viewModel.updateTodo(targetTodo.copy(
                        date = targetDate,
                        task_type = targetType,
                        recurring = targetRecurring,
                        updated_at = nowIso()
                    ))
                }
            } else {
                // Normal drag and drop reordering between tasks
                var currentSection = "today"
                val updatedList = mutableListOf<Todo>()

                reorderableFocusItems.forEachIndexed { index, item ->
                    when (item) {
                        is FocusItem.Header -> {
                            currentSection = when (item.key) {
                                "HEADER_TODAY" -> "today"
                                "HEADER_NODATE" -> "nodate"
                                "HEADER_WEEK" -> "week"
                                "HEADER_MONTH" -> "month"
                                else -> currentSection
                            }
                        }
                        is FocusItem.Task -> {
                            val todo = item.todo
                            var targetDate = todo.date
                            var targetType = todo.task_type
                            var targetRecurring = todo.recurring

                            when (currentSection) {
                                "today" -> {
                                    targetType = "normal"
                                    if (todo.task_type == "weekly_checkin" || todo.task_type == "monthly_checkin") {
                                        targetRecurring = "none"
                                    }
                                    if (targetDate == null || isWeekDate(targetDate) || isMonthDate(targetDate)) {
                                        targetDate = todayStr
                                    }
                                }
                                "nodate" -> {
                                    targetType = "normal"
                                    if (todo.task_type == "weekly_checkin" || todo.task_type == "monthly_checkin") {
                                        targetRecurring = "none"
                                    }
                                    targetDate = null
                                }
                                "week" -> {
                                    targetType = "weekly_checkin"
                                    targetRecurring = "none"
                                    if (targetDate == null || !isWeekDate(targetDate)) {
                                        targetDate = thisWeekStr
                                    }
                                }
                                "month" -> {
                                    targetType = "monthly_checkin"
                                    targetRecurring = "none"
                                    if (targetDate == null || !isMonthDate(targetDate)) {
                                        targetDate = thisMonthStr
                                    }
                                }
                            }

                            val newOrder = index.toDouble()
                            if (todo.order != newOrder || todo.date != targetDate || todo.task_type != targetType || todo.recurring != targetRecurring) {
                                updatedList.add(todo.copy(
                                    order = newOrder,
                                    date = targetDate,
                                    task_type = targetType,
                                    recurring = targetRecurring,
                                    updated_at = nowIso()
                                ))
                            }
                        }
                        is FocusItem.EmptyPlaceholder -> {}
                    }
                }

                if (updatedList.isNotEmpty()) {
                    viewModel.batchUpdateTodos(updatedList)
                }
            }
        }
    )

    LaunchedEffect(reorderState.draggingItemKey) {
        if (reorderState.draggingItemKey != null) {
            activeDraggingKey = reorderState.draggingItemKey as? String
        }
    }

    val isDragging = reorderState.draggingItemKey != null
    LaunchedEffect(focusItemsOriginal) {
        reorderableFocusItems = focusItemsOriginal
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TabRow(selectedTabIndex = selectedTab, modifier = Modifier.weight(1f)) {
                Tab(selected = selectedTab == 0, onClick = { selectedTab = 0 }, text = { Text("今天聚焦") })
                Tab(selected = selectedTab == 1, onClick = { selectedTab = 1 }, text = { Text("全部待办") })
            }
            // Search toggle button
            IconButton(onClick = { 
                showSearchBar = !showSearchBar 
                if (!showSearchBar) searchQuery = ""
            }) {
                Icon(
                    imageVector = if (showSearchBar) Icons.Filled.Close else Icons.Filled.Search, 
                    contentDescription = "搜索", 
                    tint = MaterialTheme.colorScheme.primary
                )
            }
            IconButton(onClick = { viewModel.syncWithCloud() }) {
                if (isSyncing) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Filled.Refresh, contentDescription = "同步", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }

        // Real-time Search Input Bar
        if (showSearchBar) {
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                placeholder = { Text("搜索待办...") },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    if (searchQuery.isNotEmpty()) {
                        IconButton(onClick = { searchQuery = "" }) {
                            Icon(Icons.Filled.Clear, contentDescription = "清除")
                        }
                    }
                },
                shape = RoundedCornerShape(12.dp)
            )
        }
        
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            val uncompletedTodos = remember(filteredTodos) { filteredTodos.filter { !it.completed } }
            val sortedUncompletedGroups = remember(uncompletedTodos, todayStr) {
                val groups = groupTodosByDate(uncompletedTodos, todayStr)
                val dateComparatorAsc = Comparator<Todo> { a, b ->
                    val da = a.date ?: ""
                    val db = b.date ?: ""
                    da.compareTo(db)
                }
                val dateComparatorDesc = Comparator<Todo> { a, b ->
                    val da = a.date ?: ""
                    val db = b.date ?: ""
                    db.compareTo(da)
                }
                groups.copy(
                    future = groups.future.sortedWith(dateComparatorAsc),
                    past = groups.past.sortedWith(dateComparatorDesc) // 逾期任务按日期降序，最近逾期优先
                )
            }

            val uncompletedToday = sortedUncompletedGroups.today
            val uncompletedNoDate = sortedUncompletedGroups.noDate
            val uncompletedWeek = sortedUncompletedGroups.week
            val uncompletedMonth = sortedUncompletedGroups.month
            val uncompletedFuture = sortedUncompletedGroups.future
            val uncompletedPast = sortedUncompletedGroups.past

            val completedMap = remember(filteredTodos, todayStr) {
                val map = mutableMapOf<String, MutableList<Pair<Todo, String?>>>()
                filteredTodos.forEach { todo ->
                    if (todo.task_type == "weekly_checkin" || todo.task_type == "monthly_checkin") {
                        todo.completed_dates.forEach { checkinDate ->
                            val label = checkinDate
                            map.getOrPut(label) { mutableListOf() }.add(Pair(todo, checkinDate))
                        }
                    } else if (todo.completed) {
                        val completedAt = todo.completed_at ?: todo.created_at
                        val dateLabel = if (completedAt.length >= 10) completedAt.substring(0, 10) else "未知日期"
                        map.getOrPut(dateLabel) { mutableListOf() }.add(Pair(todo, null))
                    }
                }
                map.mapValues { (_, list) ->
                    list.sortedWith { a, b ->
                        val ua = a.first.updated_at ?: a.first.created_at
                        val ub = b.first.updated_at ?: b.first.created_at
                        ub.compareTo(ua)
                    }
                }.toSortedMap(reverseOrder())
            }

            val todoItem = @Composable { todo: Todo ->
                TodoItemRow(
                    todo = todo,
                    viewModel = viewModel,
                    onEdit = { showEditDialogFor = todo },
                    onMoveToTomorrow = { viewModel.updateTodo(todo.copy(date = dates.tomorrow)) },
                    todayStr = todayStr,
                    tomorrowStr = dates.tomorrow
                )
            }

            if (selectedTab == 0) {
                LazyColumn(
                    state = reorderState.listState,
                    modifier = Modifier.reorderable(reorderState).fillMaxSize().padding(horizontal = 16.dp)
                ) {
                    items(items = reorderableFocusItems, key = { it.key }) { item ->
                        ReorderableItem(reorderableState = reorderState, key = item.key) { isDragging ->
                            val elevation = animateDpAsState(if (isDragging) 8.dp else 0.dp)
                            Surface(shadowElevation = elevation.value) {
                                when (item) {
                                    is FocusItem.Header -> {
                                        GroupHeader(
                                            title = item.title,
                                            color = item.color,
                                            isExpanded = item.isExpanded,
                                            isHovered = (hoveredHeaderKey == item.key),
                                            onClick = item.onToggleExpand
                                        )
                                    }
                                    is FocusItem.Task -> {
                                        Box(modifier = Modifier.detectReorderAfterLongPress(reorderState)) {
                                            TodoItemRow(
                                                todo = item.todo,
                                                viewModel = viewModel,
                                                onEdit = { showEditDialogFor = item.todo },
                                                onMoveToTomorrow = { viewModel.updateTodo(item.todo.copy(date = dates.tomorrow)) },
                                                todayStr = todayStr,
                                                tomorrowStr = dates.tomorrow
                                            )
                                        }
                                    }
                                    is FocusItem.EmptyPlaceholder -> {
                                        ImportLastPeriodCard(
                                            message = item.message,
                                            type = item.period,
                                            viewModel = viewModel
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                // "全部待办" (selectedTab == 1)
                Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                    // Subtabs: 待完成 vs 已完成
                    TabRow(
                        selectedTabIndex = if (allTabMode == "uncompleted") 0 else 1,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                        containerColor = Color.Transparent
                    ) {
                        Tab(
                            selected = allTabMode == "uncompleted",
                            onClick = { allTabMode = "uncompleted" },
                            text = { Text("待完成", style = MaterialTheme.typography.bodyMedium) }
                        )
                        Tab(
                            selected = allTabMode == "completed",
                            onClick = { allTabMode = "completed" },
                            text = { Text("已完成", style = MaterialTheme.typography.bodyMedium) }
                        )
                    }

                    LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
                        if (allTabMode == "uncompleted") {
                            if (uncompletedToday.isNotEmpty()) {
                                item { GroupHeader("今天/逾期", Color(0xFF1890FF), expandToday) { expandToday = !expandToday } }
                                if (expandToday) {
                                    items(items = uncompletedToday, key = { "uncompleted_today_${it.id}" }) { todoItem(it) }
                                }
                            }
                            if (uncompletedWeek.isNotEmpty()) {
                                item { GroupHeader("本周", Color(0xFFFADB14), expandWeek) { expandWeek = !expandWeek } }
                                if (expandWeek) {
                                    items(items = uncompletedWeek, key = { "uncompleted_week_${it.id}" }) { todoItem(it) }
                                }
                            }
                            if (uncompletedMonth.isNotEmpty()) {
                                item { GroupHeader("本月", Color(0xFFFF7A45), expandMonth) { expandMonth = !expandMonth } }
                                if (expandMonth) {
                                    items(items = uncompletedMonth, key = { "uncompleted_month_${it.id}" }) { todoItem(it) }
                                }
                            }
                            if (uncompletedFuture.isNotEmpty()) {
                                item { GroupHeader("以后", Color(0xFF1890FF), expandFuture) { expandFuture = !expandFuture } }
                                if (expandFuture) {
                                    items(items = uncompletedFuture, key = { "uncompleted_future_${it.id}" }) { todoItem(it) }
                                }
                            }
                            if (uncompletedNoDate.isNotEmpty()) {
                                item { GroupHeader("无日期", Color.Gray, expandNoDate) { expandNoDate = !expandNoDate } }
                                if (expandNoDate) {
                                    items(items = uncompletedNoDate, key = { "uncompleted_nodate_${it.id}" }) { todoItem(it) }
                                }
                            }
                            if (uncompletedPast.isNotEmpty()) {
                                item { GroupHeader("已过期", Color(0xFFFF4D4F), expandPast) { expandPast = !expandPast } }
                                if (expandPast) {
                                    items(items = uncompletedPast, key = { "uncompleted_past_${it.id}" }) { todoItem(it) }
                                }
                            }
                        } else {
                            // "completed" tab
                            val sortedCompletionDates = completedMap.keys.toList()
                            val showDates = if (showAllHistory) sortedCompletionDates else sortedCompletionDates.take(3)
                            
                            showDates.forEach { dateStr ->
                                val itemsList = completedMap[dateStr] ?: emptyList()
                                item {
                                    Text(
                                        text = dateStr,
                                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                                        color = Color(0xFF52C41A),
                                        modifier = Modifier.padding(vertical = 12.dp)
                                    )
                                }
                                
                                items(
                                    items = itemsList,
                                    key = { (todo, checkinDate) ->
                                        if (checkinDate != null) "completed_checkin_${todo.id}_$checkinDate" else "completed_normal_${todo.id}"
                                    }
                                ) { (todo, checkinDate) ->
                                    TodoItemRow(
                                        todo = todo,
                                        viewModel = viewModel,
                                        onEdit = { showEditDialogFor = todo },
                                        onMoveToTomorrow = { viewModel.updateTodo(todo.copy(date = dates.tomorrow)) },
                                        todayStr = todayStr,
                                        tomorrowStr = dates.tomorrow,
                                        checkinDate = checkinDate
                                    )
                                }
                            }
                            
                            if (sortedCompletionDates.size > 3) {
                                item {
                                    Box(
                                        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        TextButton(onClick = { showAllHistory = !showAllHistory }) {
                                            Text(if (showAllHistory) "收起历史归档" else "展开历史归档 (共 ${sortedCompletionDates.size} 天)")
                                        }
                                    }
                                }
                            }
                        }
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
        DisposableEffect(todo.id) {
            viewModel.isEditingDialogShowing.value = true
            onDispose {
                viewModel.isEditingDialogShowing.value = false
                if (viewModel.pendingMidnightRefresh) {
                    viewModel.pendingMidnightRefresh = false
                    viewModel.refreshTodayDate()
                }
            }
        }

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
fun GroupHeader(
    title: String, 
    color: Color, 
    isExpanded: Boolean = true, 
    isHovered: Boolean = false, 
    onClick: (() -> Unit)? = null
) {
    Surface(
        color = if (isHovered) color.copy(alpha = 0.25f) else color.copy(alpha = 0.1f),
        shape = RoundedCornerShape(8.dp),
        border = if (isHovered) BorderStroke(2.dp, color) else null,
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
    tomorrowStr: String = "",
    checkinDate: String? = null
) {
    val coroutineScope = rememberCoroutineScope()
    val offsetX = remember { Animatable(0f) }
    val density = androidx.compose.ui.platform.LocalDensity.current.density
    val maxSwipePx = -60f * density
    var expanded by remember { mutableStateOf(false) }
    var calendarExpanded by remember { mutableStateOf(false) }

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
                val isVisualCompleted = if (checkinDate != null) {
                    true
                } else {
                    todo.completed || ((todo.task_type == "weekly_checkin" || todo.task_type == "monthly_checkin") && todo.completed_dates.contains(todayStr))
                }
                Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = isVisualCompleted,
                        onCheckedChange = {
                            if (checkinDate != null) {
                                viewModel.updateTodo(todo.withToggledCheckinDate(checkinDate))
                            } else {
                                viewModel.toggleTodoStatus(todo.id)
                            }
                        }
                    )
                    Column(modifier = Modifier.weight(1f).clickable { 
                        if (todo.task_type == "monthly_checkin") {
                            calendarExpanded = !calendarExpanded
                        } else if (todo.subtasks.isNotEmpty()) {
                            expanded = !expanded
                        }
                    }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = todo.content, 
                                style = MaterialTheme.typography.bodyLarge,
                                color = if (isVisualCompleted) Color.Gray else MaterialTheme.colorScheme.onSurface,
                                textDecoration = if (isVisualCompleted) androidx.compose.ui.text.style.TextDecoration.LineThrough else null,
                                modifier = Modifier.weight(1f, fill = false)
                            )
                            if (todo.recurring == "daily_repeat") {
                                Spacer(Modifier.width(6.dp))
                                Box(
                                    modifier = Modifier
                                        .background(
                                            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.1f),
                                            shape = RoundedCornerShape(10.dp)
                                        )
                                        .border(
                                            width = 0.5.dp,
                                            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.3f),
                                            shape = RoundedCornerShape(10.dp)
                                        )
                                        .padding(horizontal = 6.dp, vertical = 2.dp)
                                ) {
                                    Text(
                                        text = "每天重复",
                                        color = MaterialTheme.colorScheme.primary,
                                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Medium)
                                    )
                                }
                            }
                        }
                        val meta = mutableListOf<String>()
                        todo.date?.let {
                            val dateLabel = todo.getDateLabel(todayStr, tomorrowStr)
                            val statusLabel = todo.getCompletionStatusLabel()
                            val label = if (statusLabel != null) "📅 $dateLabel ($statusLabel)" else "📅 $dateLabel"
                            meta.add(label)
                        }
                        if (todo.completed && todo.completed_at != null) {
                            val completedAt = todo.completed_at!!
                            if (completedAt.length >= 10) {
                                val mmdd = completedAt.substring(5, 10)
                                meta.add("✓ 完成于 $mmdd")
                            }
                        }
                        if (todo.recurring != "none") meta.add("🔄")
                        if (todo.subtasks.isNotEmpty()) meta.add("📋 ${todo.subtasks.count { it.completed }}/${todo.subtasks.size}")
                        if (meta.isNotEmpty()) {
                            Text(text = meta.joinToString(" | "), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                        }

                        if (todo.task_type == "weekly_checkin") {
                            Spacer(Modifier.height(6.dp))
                            val dates = remember { getThisWeekDates() }
                            val labels = listOf("一", "二", "三", "四", "五", "六", "日")
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                dates.forEachIndexed { idx, date ->
                                    val dateStr = date.toString()
                                    val isChecked = todo.completed_dates.contains(dateStr)
                                    val isToday = dateStr == todayStr
                                    Box(
                                        modifier = Modifier
                                            .size(20.dp)
                                            .clip(RoundedCornerShape(4.dp))
                                            .background(
                                                if (isChecked) MaterialTheme.colorScheme.primary.copy(alpha = 0.8f) 
                                                else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
                                            )
                                            .border(
                                                width = if (isToday) 1.5.dp else 0.5.dp,
                                                color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline.copy(alpha = 0.2f),
                                                shape = RoundedCornerShape(4.dp)
                                            )
                                            .clickable {
                                                viewModel.updateTodo(todo.withToggledCheckinDate(dateStr))
                                            },
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Text(
                                            text = labels[idx],
                                            color = if (isChecked) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.sp)
                                        )
                                    }
                                }
                            }
                        } else if (todo.task_type == "monthly_checkin") {
                            Spacer(Modifier.height(6.dp))
                            val count = todo.getMonthlyCompletedCount()
                            val target = todo.target_count ?: 30
                            val progress = if (target > 0) count.toFloat() / target.toFloat() else 0f
                            
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                LinearProgressIndicator(
                                    progress = { progress.coerceIn(0f, 1f) },
                                    modifier = Modifier.weight(1f).height(6.dp).clip(RoundedCornerShape(3.dp)),
                                    color = MaterialTheme.colorScheme.primary,
                                    trackColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)
                                )
                                Text(
                                    text = "$count/$target 天",
                                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.sp),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            
                            if (calendarExpanded) {
                                Spacer(Modifier.height(6.dp))
                                val dates = remember(todo.date) { getMonthCalendarDates(todo.date) }
                                
                                val targetMonth = remember(todo.date) {
                                    try {
                                        val parts = (todo.date ?: "").split("-")
                                        parts[1].toInt()
                                    } catch (e: Exception) {
                                        LocalDate.now().monthValue
                                    }
                                }
                                
                                val chunks = dates.chunked(7)
                                val weekLabels = listOf("一", "二", "三", "四", "五", "六", "日")
                                
                                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    // Weekday Headers
                                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        weekLabels.forEach { label ->
                                            Box(
                                                modifier = Modifier.size(20.dp),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(
                                                    text = label,
                                                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 9.sp, fontWeight = FontWeight.Bold),
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                                                )
                                            }
                                        }
                                    }
                                    
                                    chunks.forEach { rowDates ->
                                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                            rowDates.forEach { date ->
                                                val dateStr = date.toString()
                                                val isChecked = todo.completed_dates.contains(dateStr)
                                                val isToday = dateStr == todayStr
                                                val isCurrentMonth = date.monthValue == targetMonth
                                                
                                                Box(
                                                    modifier = Modifier
                                                        .size(20.dp)
                                                        .clip(RoundedCornerShape(4.dp))
                                                        .background(
                                                            if (isChecked) {
                                                                if (isCurrentMonth) MaterialTheme.colorScheme.primary.copy(alpha = 0.8f)
                                                                else MaterialTheme.colorScheme.primary.copy(alpha = 0.3f)
                                                            } else {
                                                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (isCurrentMonth) 0.4f else 0.15f)
                                                            }
                                                        )
                                                        .border(
                                                            width = if (isToday) 1.5.dp else 0.5.dp,
                                                            color = if (isToday) {
                                                                MaterialTheme.colorScheme.primary
                                                            } else {
                                                                MaterialTheme.colorScheme.outline.copy(alpha = if (isCurrentMonth) 0.2f else 0.05f)
                                                            },
                                                            shape = RoundedCornerShape(4.dp)
                                                        )
                                                        .then(
                                                            if (isCurrentMonth || isChecked) {
                                                                Modifier.clickable {
                                                                    viewModel.updateTodo(todo.withToggledCheckinDate(dateStr))
                                                                }
                                                            } else {
                                                                Modifier
                                                            }
                                                        ),
                                                    contentAlignment = Alignment.Center
                                                ) {
                                                    Text(
                                                        text = date.dayOfMonth.toString(),
                                                        color = if (isChecked) {
                                                            if (isCurrentMonth) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.5f)
                                                        } else {
                                                            MaterialTheme.colorScheme.onSurface.copy(alpha = if (isCurrentMonth) 0.8f else 0.25f)
                                                        },
                                                        style = MaterialTheme.typography.bodySmall.copy(fontSize = 9.sp)
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
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
                                        newSubs[index] = sub.copy(
                                            completed = isChecked,
                                            completed_at = if (isChecked) nowIso() else null
                                        )

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
                                    text = if (sub.completed && sub.completed_at != null && sub.completed_at!!.length >= 10) {
                                        "${sub.content} (完成于 ${sub.completed_at!!.substring(5, 10)})"
                                    } else {
                                        sub.content
                                    },
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

// getThisWeekDates() / getThisMonthDates() 已移至 TodoDateUtils.kt 共享

@Composable
fun ImportLastPeriodCard(
    message: String,
    type: String,
    viewModel: TodoViewModel
) {
    val coroutineScope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    var showDialog by remember { mutableStateOf(false) }

    val todos by viewModel.todos.collectAsState(initial = emptyList())
    val today = java.time.LocalDate.now()
    val sourcePeriodStr = remember(type, today) {
        if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today.minusWeeks(1))
        } else {
            com.todo.app.data.model.monthStringOf(today.minusMonths(1))
        }
    }
    val targetPeriodStr = remember(type, today) {
        if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today)
        } else {
            com.todo.app.data.model.monthStringOf(today)
        }
    }
    val candidates = remember(todos, sourcePeriodStr, targetPeriodStr) {
        val existingTitles = todos.filter { !it.deleted && it.date == targetPeriodStr }.map { it.content }.toSet()
        todos.filter {
            !it.deleted &&
            (it.task_type == "weekly_checkin" || it.task_type == "monthly_checkin") &&
            it.date == sourcePeriodStr &&
            !existingTitles.contains(it.content)
        }
    }

    val selectedIds = remember(candidates) {
        val map = mutableStateMapOf<String, Boolean>()
        candidates.forEach { map[it.id] = true }
        map
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp, horizontal = 12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)),
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(10.dp))
            Button(
                onClick = {
                    if (candidates.isEmpty()) {
                        android.widget.Toast.makeText(context, "上一周期没有打卡任务可供导入", android.widget.Toast.LENGTH_SHORT).show()
                    } else {
                        showDialog = true
                    }
                },
                shape = RoundedCornerShape(8.dp)
            ) {
                Text("从上期导入", style = MaterialTheme.typography.labelLarge)
            }
        }
    }

    if (showDialog) {
        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(if (type == "weekly") "从上周导入" else "从上月导入") },
            text = {
                Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    candidates.forEach { todo ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedIds[todo.id] = !(selectedIds[todo.id] ?: false) }
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = selectedIds[todo.id] ?: false,
                                onCheckedChange = { checked -> selectedIds[todo.id] = checked }
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = todo.content, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val chosenIds = selectedIds.filter { it.value }.keys.toList()
                        if (chosenIds.isNotEmpty()) {
                            coroutineScope.launch {
                                viewModel.importSelectedFromLastPeriod(type, chosenIds, context)
                            }
                        }
                        showDialog = false
                    }
                ) {
                    Text("导入选中项")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDialog = false }) {
                    Text("取消")
                }
            }
        )
    }
}
