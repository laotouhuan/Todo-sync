package com.todo.app.ui.view

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.Brush
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import com.todo.app.data.model.Subtask
import com.todo.app.data.model.Todo
import com.todo.app.data.model.nowIso
import com.todo.app.data.model.nowInstant
import com.todo.app.data.model.getWeeklyCompletedCount
import com.todo.app.data.model.getMonthlyCompletedCount
import com.todo.app.data.model.isWeekDate
import com.todo.app.data.model.isMonthDate
import com.todo.app.data.model.weekStringOf
import com.todo.app.data.model.monthStringOf
import com.todo.app.data.model.getMonthCalendarDates
import com.todo.app.data.model.getThisWeekDates
import com.todo.app.data.model.getThisMonthDates
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.RecurringType
import java.util.UUID
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditTodoDialog(
    todo: Todo,
    onDismiss: () -> Unit,
    onAutoSave: (Todo) -> Unit,
    onDelete: () -> Unit
) {
    var content by remember(todo.content) { mutableStateOf(todo.content) }
    var date by remember(todo.date) { mutableStateOf(todo.date ?: "") }
    var time by remember(todo.time) { mutableStateOf(todo.time ?: "") }
    var hasDateEnabled by remember(todo.date) { mutableStateOf(!todo.date.isNullOrEmpty() && !isWeekDate(todo.date!!) && !isMonthDate(todo.date!!)) }
    var cachedDate by remember(todo.id) { mutableStateOf(if (!todo.date.isNullOrEmpty() && !isWeekDate(todo.date!!) && !isMonthDate(todo.date!!)) todo.date!! else "") }

    LaunchedEffect(date) {
        if (date.isNotBlank() && !isWeekDate(date) && !isMonthDate(date)) {
            cachedDate = date
        }
    }
    var completedDates by remember(todo.completed_dates) { mutableStateOf(todo.completed_dates) }
    var subtasks by remember(todo.subtasks) { mutableStateOf(todo.subtasks) }
    var editingSubtaskId by remember { mutableStateOf<String?>(null) }
    var targetCount by remember(todo.target_count) { mutableStateOf(todo.target_count) }
    var parentCompleted by remember(todo.completed) { mutableStateOf(todo.completed) }
    var parentCompletedAt by remember(todo.completed_at) { mutableStateOf(todo.completed_at) }

    var selectedTypeUi by remember(todo.task_type, todo.recurring) {
        mutableStateOf(if (todo.recurring == RecurringType.DAILY_REPEAT) TaskType.DAILY_REPEAT else todo.task_type)
    }

    val context = LocalContext.current

    // 防抖 auto-save：300ms 内多次调用只执行最后一次，避免频繁磁盘写入
    val coroutineScope = rememberCoroutineScope()
    var autoSaveJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    /** 公共逻辑：根据当前编辑状态构建更新后的 Todo 对象 */
    fun buildUpdatedTodo(completedDatesList: List<String>): Todo {
        val mappedTaskType = if (selectedTypeUi == TaskType.DAILY_REPEAT) TaskType.NORMAL else selectedTypeUi
        val mappedRecurring = if (selectedTypeUi == TaskType.DAILY_REPEAT) RecurringType.DAILY_REPEAT else RecurringType.NONE

        var finalDate = date.takeIf { it.isNotBlank() }
        var finalTime = time.takeIf { it.isNotBlank() }

        if (selectedTypeUi == TaskType.DAILY_REPEAT) {
            finalTime = null
            if (finalDate.isNullOrEmpty() || isWeekDate(finalDate) || isMonthDate(finalDate)) {
                finalDate = java.time.LocalDate.now().toString()
            }
        } else if (mappedTaskType == TaskType.NORMAL && finalDate != null && (isWeekDate(finalDate) || isMonthDate(finalDate))) {
            // 用户将打卡任务切换为普通任务时，周/月格式日期不适用于普通任务，强制回退到对应的打卡类型
            if (isWeekDate(finalDate)) {
                return todo.copy(task_type = TaskType.WEEKLY_CHECKIN, recurring = RecurringType.NONE, date = finalDate, updated_at = nowIso())
            } else {
                return todo.copy(task_type = TaskType.MONTHLY_CHECKIN, recurring = RecurringType.NONE, date = finalDate, updated_at = nowIso())
            }
        } else if (selectedTypeUi == TaskType.WEEKLY_CHECKIN) {
            finalTime = null
            if (finalDate == null || !isWeekDate(finalDate)) {
                finalDate = weekStringOf(java.time.LocalDate.now())
            }
        } else if (selectedTypeUi == TaskType.MONTHLY_CHECKIN) {
            finalTime = null
            if (finalDate == null || !isMonthDate(finalDate)) {
                finalDate = monthStringOf(java.time.LocalDate.now())
            }
        }

        val isCompletedNow = if (mappedTaskType == TaskType.WEEKLY_CHECKIN || mappedTaskType == TaskType.MONTHLY_CHECKIN) {
            val tempTodo = todo.copy(completed_dates = completedDatesList, date = finalDate)
            val completedCount = if (mappedTaskType == TaskType.WEEKLY_CHECKIN) {
                tempTodo.getWeeklyCompletedCount()
            } else {
                tempTodo.getMonthlyCompletedCount()
            }
            targetCount != null && completedCount >= targetCount!!
        } else {
            parentCompleted
        }
        return todo.copy(
            content = content.takeIf { it.isNotBlank() } ?: todo.content,
            date = finalDate,
            time = finalTime,
            recurring = mappedRecurring,
            task_type = mappedTaskType,
            target_count = targetCount,
            completed_dates = completedDatesList,
            completed = isCompletedNow,
            completed_at = if (isCompletedNow) {
                if (mappedTaskType == TaskType.WEEKLY_CHECKIN || mappedTaskType == TaskType.MONTHLY_CHECKIN) {
                    todo.completed_at ?: nowIso()
                } else {
                    parentCompletedAt ?: todo.completed_at ?: nowIso()
                }
            } else null,
            subtasks = subtasks,
            updated_at = nowIso()
        )
    }

    val performAutoSave = {
        autoSaveJob?.cancel()
        autoSaveJob = coroutineScope.launch {
            kotlinx.coroutines.delay(300)
            onAutoSave(buildUpdatedTodo(completedDates))
        }
    }

    val onToggleCheckinDate = { dateStr: String ->
        val currentDates = completedDates.toMutableList()
        if (currentDates.contains(dateStr)) {
            currentDates.remove(dateStr)
        } else {
            currentDates.add(dateStr)
        }
        currentDates.sort()
        completedDates = currentDates

        autoSaveJob?.cancel()
        autoSaveJob = coroutineScope.launch {
            kotlinx.coroutines.delay(300)
            onAutoSave(buildUpdatedTodo(currentDates))
        }
    }

    var showDeleteConfirm by remember { mutableStateOf(false) }

    if (showDeleteConfirm) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("确认删除") },
            text = { Text("您确定要删除这个待办事项吗？") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    showDeleteConfirm = false
                    onDelete()
                }) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { showDeleteConfirm = false }) {
                    Text("取消")
                }
            }
        )
    }

    Dialog(onDismissRequest = {
        performAutoSave()
        onDismiss()
    }) {
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { 
                            performAutoSave()
                            onDismiss() 
                        }) {
                            Icon(Icons.Filled.ArrowBack, contentDescription = "返回")
                        }
                        Text("编辑待办", style = MaterialTheme.typography.titleLarge)
                    }
                    IconButton(onClick = { showDeleteConfirm = true }) {
                        Icon(Icons.Filled.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
                    }
                }
                Spacer(Modifier.height(16.dp))

                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it },
                    modifier = Modifier.fillMaxWidth().onFocusChanged { if (!it.isFocused) performAutoSave() },
                    label = { Text("待办内容") },
                    trailingIcon = {
                        IconButton(onClick = { performAutoSave() }) {
                            Icon(Icons.Filled.Check, contentDescription = "确认保存")
                        }
                    }
                )

                if (selectedTypeUi == TaskType.NORMAL) {
                    Spacer(Modifier.height(8.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("设置截止日期", style = MaterialTheme.typography.bodyLarge)
                        Switch(
                            checked = hasDateEnabled,
                            onCheckedChange = { checked ->
                                if (checked) {
                                    val targetDate = if (cachedDate.isNotBlank()) cachedDate else java.time.LocalDate.now().toString()
                                    date = targetDate
                                } else {
                                    date = ""
                                }
                                hasDateEnabled = checked
                                performAutoSave()
                            }
                        )
                    }

                    if (hasDateEnabled) {
                        Spacer(Modifier.height(8.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(), 
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            OutlinedTextField(
                                value = date,
                                onValueChange = { date = it },
                                label = { Text("截止日期 (YYYY-MM-DD)") },
                                modifier = Modifier.weight(1f).onFocusChanged { if (!it.isFocused) performAutoSave() }
                            )
                            Button(
                                onClick = {
                                    date = java.time.LocalDate.now().plusDays(1).toString()
                                    performAutoSave()
                                },
                                modifier = Modifier.height(56.dp).padding(top = 6.dp),
                                shape = RoundedCornerShape(8.dp),
                                contentPadding = PaddingValues(horizontal = 16.dp)
                            ) {
                                Text("明天")
                            }
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))
                Text("任务类型", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                
                val types = listOf(TaskType.NORMAL, TaskType.DAILY_REPEAT, TaskType.WEEKLY_CHECKIN, TaskType.MONTHLY_CHECKIN)
                val typeLabels = listOf("普通待办", "每天重复", "周打卡", "月打卡")
                val selectedTypeIndex = types.indexOf(selectedTypeUi).takeIf { it >= 0 } ?: 0
                SegmentedButton(typeLabels, selectedTypeIndex) { 
                    selectedTypeUi = types[it]
                    performAutoSave()
                }

                if (selectedTypeUi == TaskType.WEEKLY_CHECKIN || selectedTypeUi == TaskType.MONTHLY_CHECKIN) {
                    Spacer(Modifier.height(12.dp))
                    var targetCountText by remember(targetCount) { mutableStateOf(targetCount?.toString() ?: "") }
                    OutlinedTextField(
                        value = targetCountText,
                        onValueChange = {
                            targetCountText = it
                            val parsed = it.toIntOrNull()
                            targetCount = if (parsed != null && parsed > 0) parsed else null
                            performAutoSave()
                        },
                        label = { Text("目标打卡次数 (不填为纯打卡)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )

                    Spacer(Modifier.height(12.dp))
                    Text("打卡记录 (点击补卡/消卡)", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(4.dp))
                    if (selectedTypeUi == TaskType.WEEKLY_CHECKIN) {
                        EditWeekCheckinGrid(completedDates, onToggleCheckinDate, todo.date)
                    } else {
                        EditMonthCheckinGrid(date, completedDates, onToggleCheckinDate)
                    }
                }

                Spacer(Modifier.height(16.dp))
                var copyOnlyUncompleted by remember { mutableStateOf(true) }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("子步骤/备注", style = MaterialTheme.typography.titleMedium)
                    
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.clickable { copyOnlyUncompleted = !copyOnlyUncompleted }.padding(end = 8.dp)
                        ) {
                            Checkbox(
                                checked = copyOnlyUncompleted,
                                onCheckedChange = { copyOnlyUncompleted = it }
                            )
                            Text("仅未完成", style = MaterialTheme.typography.bodySmall)
                        }

                        var expandedCopyMenu by remember { mutableStateOf(false) }
                        Box {
                            TextButton(onClick = { expandedCopyMenu = true }) { Text("复制") }
                            DropdownMenu(expanded = expandedCopyMenu, onDismissRequest = { expandedCopyMenu = false }) {
                                DropdownMenuItem(text = { Text("纯文本") }, onClick = { 
                                    val filteredSubs = if (copyOnlyUncompleted) subtasks.filter { !it.completed } else subtasks
                                    val text = filteredSubs.joinToString("\n") { it.content }
                                    copyToClipboard(context, text)
                                    expandedCopyMenu = false 
                                })
                                DropdownMenuItem(text = { Text("无序列表") }, onClick = { 
                                    val text = (if (copyOnlyUncompleted) subtasks.filter { !it.completed } else subtasks).joinToString("\n") { "- ${it.content}" }
                                    copyToClipboard(context, text)
                                    expandedCopyMenu = false 
                                })
                                DropdownMenuItem(text = { Text("有序列表") }, onClick = { 
                                    val filteredSubs = if (copyOnlyUncompleted) subtasks.filter { !it.completed } else subtasks
                                    val text = filteredSubs.mapIndexed { i, s -> "${i + 1}. ${s.content}" }.joinToString("\n")
                                    copyToClipboard(context, text)
                                    expandedCopyMenu = false 
                                })
                            }
                        }
                    }
                }
                
                LazyColumn(modifier = Modifier.heightIn(max = 150.dp).fillMaxWidth()) {
                    items(subtasks, key = { it.id }) { sub ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Checkbox(checked = sub.completed, onCheckedChange = { chk ->
                                val updatedSubtasks = subtasks.map { 
                                    if (it.id == sub.id) it.copy(completed = chk, completed_at = if (chk) nowIso() else null) else it 
                                }
                                subtasks = updatedSubtasks
                                val allCompleted = updatedSubtasks.isNotEmpty() && updatedSubtasks.all { it.completed }
                                if (allCompleted) {
                                    parentCompleted = true
                                    parentCompletedAt = nowInstant()
                                }
                                performAutoSave()
                            })
                            if (editingSubtaskId == sub.id) {
                                var editContent by remember(sub.content) { mutableStateOf(sub.content) }
                                BasicTextFieldWithHint(
                                    value = editContent,
                                    onValueChange = { editContent = it },
                                    modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                                    textStyle = LocalTextStyle.current.copy(color = MaterialTheme.colorScheme.onSurface),
                                    hint = ""
                                )
                                IconButton(onClick = { 
                                    subtasks = subtasks.map { s -> if (s.id == sub.id) s.copy(content = editContent) else s }
                                    performAutoSave()
                                    editingSubtaskId = null
                                }) {
                                    Icon(Icons.Filled.Check, contentDescription = "保存", modifier = Modifier.size(20.dp))
                                }
                            } else {
                                Text(
                                    text = sub.content,
                                    modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                                    color = if (sub.completed) Color.Gray else MaterialTheme.colorScheme.onSurface,
                                    textDecoration = if (sub.completed) TextDecoration.LineThrough else null
                                )
                                IconButton(onClick = { editingSubtaskId = sub.id }) {
                                    Icon(Icons.Filled.Edit, contentDescription = "编辑", modifier = Modifier.size(20.dp))
                                }
                                IconButton(onClick = { 
                                    subtasks = subtasks.filter { it.id != sub.id }
                                    performAutoSave()
                                }) {
                                    Icon(Icons.Filled.Close, contentDescription = "删除子任务", modifier = Modifier.size(20.dp))
                                }
                            }
                        }
                    }
                }
                
                var newSubtaskContent by remember { mutableStateOf("") }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = newSubtaskContent,
                        onValueChange = { newSubtaskContent = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("添加新子步骤...") },
                        singleLine = true
                    )
                    IconButton(onClick = {
                        if (newSubtaskContent.isNotBlank()) {
                            subtasks = subtasks + Subtask(UUID.randomUUID().toString(), newSubtaskContent, false)
                            newSubtaskContent = ""
                            performAutoSave()
                        }
                    }) {
                        Icon(Icons.Filled.Add, contentDescription = "添加")
                    }
                }
            }
        }
    }
}

@Composable
fun SegmentedButton(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(40.dp)
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(20.dp))
            .clip(RoundedCornerShape(20.dp))
    ) {
        options.forEachIndexed { index, text ->
            val isSelected = index == selectedIndex
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .background(
                        if (isSelected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent
                    )
                    .clickable { onSelect(index) },
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = text,
                    style = MaterialTheme.typography.labelLarge,
                    color = if (isSelected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (index < options.size - 1) {
                Box(
                    modifier = Modifier
                        .width(1.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.outline)
                )
            }
        }
    }
}

@Composable
fun BasicTextFieldWithHint(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    textStyle: androidx.compose.ui.text.TextStyle,
    hint: String
) {
    Box(modifier = modifier) {
        androidx.compose.foundation.text.BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = textStyle,
            modifier = Modifier.fillMaxWidth()
        )
        if (value.isEmpty()) {
            Text(text = hint, color = Color.Gray, style = textStyle)
        }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("todo subtasks", text)
    clipboard.setPrimaryClip(clip)
    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
}

// getThisWeekDates() / getThisMonthDates() 已移至 TodoDateUtils.kt 共享

@Composable
fun EditWeekCheckinGrid(
    completedDates: List<String>,
    onToggleDate: (String) -> Unit,
    todoDate: String? = null
) {
    val dates = remember(todoDate) {
        if (todoDate != null && isWeekDate(todoDate)) {
            // 从 todo 的周日期派生该周的 7 天（周一到周日）
            try {
                val parts = todoDate.split("-W")
                val year = parts[0].toInt()
                val week = parts[1].toInt()
                val jan4 = java.time.LocalDate.ofYearDay(year, 1).with(java.time.temporal.IsoFields.WEEK_OF_WEEK_BASED_YEAR, week.toLong())
                val monday = jan4.with(java.time.DayOfWeek.MONDAY)
                (0..6).map { monday.plusDays(it.toLong()) }
            } catch (_: Exception) { getThisWeekDates() }
        } else {
            getThisWeekDates()
        }
    }
    val labels = listOf("一", "二", "三", "四", "五", "六", "日")
    val todayStr = java.time.LocalDate.now().toString()

    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        dates.forEachIndexed { idx, date ->
            val dateStr = date.toString()
            val isChecked = completedDates.contains(dateStr)
            val isToday = dateStr == todayStr

            Box(
                modifier = Modifier
                    .weight(1f)
                    .aspectRatio(1f)
                    .clip(RoundedCornerShape(6.dp))
                    .background(
                        if (isChecked) MaterialTheme.colorScheme.primary 
                        else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    )
                    .border(
                        width = if (isToday) 2.dp else 1.dp,
                        color = if (isToday) MaterialTheme.colorScheme.primary else if (isChecked) Color.Transparent else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                        shape = RoundedCornerShape(6.dp)
                    )
                    .clickable { onToggleDate(dateStr) },
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = labels[idx],
                    color = if (isChecked) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }
    }
}

@Composable
fun EditMonthCheckinGrid(
    todoDate: String?,
    completedDates: List<String>,
    onToggleDate: (String) -> Unit
) {
    val dates = remember(todoDate) { getMonthCalendarDates(todoDate) }
    val todayStr = java.time.LocalDate.now().toString()
    
    val targetMonth = remember(todoDate) {
        try {
            val parts = (todoDate ?: "").split("-")
            parts[1].toInt()
        } catch (e: Exception) {
            java.time.LocalDate.now().monthValue
        }
    }
    
    val chunks = dates.chunked(7)
    val weekLabels = listOf("一", "二", "三", "四", "五", "六", "日")

    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        // Weekday Headers
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            weekLabels.forEach { label ->
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold),
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                    )
                }
            }
        }
        
        chunks.forEach { rowDates ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                rowDates.forEach { date ->
                    val dateStr = date.toString()
                    val isChecked = completedDates.contains(dateStr)
                    val isToday = dateStr == todayStr
                    val isCurrentMonth = date.monthValue == targetMonth

                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .aspectRatio(1f)
                            .clip(RoundedCornerShape(6.dp))
                            .background(
                                if (isChecked) {
                                    if (isCurrentMonth) MaterialTheme.colorScheme.primary 
                                    else MaterialTheme.colorScheme.primary.copy(alpha = 0.4f)
                                } else {
                                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (isCurrentMonth) 0.5f else 0.2f)
                                }
                            )
                            .border(
                                width = if (isToday) 2.dp else 1.dp,
                                color = if (isToday) {
                                    MaterialTheme.colorScheme.primary
                                } else if (isChecked) {
                                    Color.Transparent
                                } else {
                                    MaterialTheme.colorScheme.outline.copy(alpha = if (isCurrentMonth) 0.3f else 0.1f)
                                },
                                shape = RoundedCornerShape(6.dp)
                            )
                            .then(
                                if (isCurrentMonth || isChecked) {
                                    Modifier.clickable { onToggleDate(dateStr) }
                                } else {
                                    Modifier
                                }
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = date.dayOfMonth.toString(),
                            color = if (isChecked) {
                                if (isCurrentMonth) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.6f)
                            } else {
                                MaterialTheme.colorScheme.onSurface.copy(alpha = if (isCurrentMonth) 1.0f else 0.3f)
                            },
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }
        }
    }
}
