@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Surface
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
import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.burnoutcrew.reorderable.rememberReorderableLazyListState
import org.burnoutcrew.reorderable.reorderable
import org.burnoutcrew.reorderable.ReorderableItem
import org.burnoutcrew.reorderable.detectReorderAfterLongPress

// ====== Public utility composable ======

@Composable
fun rememberDebouncedAutoSave(delayMs: Long = 300, onSave: (Todo) -> Unit): (Todo) -> Unit {
    val scope = rememberCoroutineScope()
    var job by remember { mutableStateOf<Job?>(null) }
    return { todo ->
        job?.cancel()
        job = scope.launch {
            delay(delayMs)
            onSave(todo)
        }
    }
}

// ====== buildUpdatedTodo (top-level private) ======

private fun buildUpdatedTodo(
    todo: Todo,
    content: String,
    date: String,
    time: String,
    selectedTypeUi: String,
    targetCount: Int?,
    parentCompleted: Boolean,
    parentCompletedAt: String?,
    completedDates: List<String>,
    subtasks: List<Subtask>
): Todo {
    var mappedTaskType = if (selectedTypeUi == TaskType.DAILY_REPEAT) TaskType.NORMAL else selectedTypeUi
    var mappedRecurring = if (selectedTypeUi == TaskType.DAILY_REPEAT) RecurringType.DAILY_REPEAT else RecurringType.NONE

    var finalDate = date.takeIf { it.isNotBlank() }
    var finalTime = time.takeIf { it.isNotBlank() }

    if (selectedTypeUi == TaskType.DAILY_REPEAT) {
        finalTime = null
        if (finalDate.isNullOrEmpty() || isWeekDate(finalDate) || isMonthDate(finalDate)) {
            finalDate = LocalDate.now().toString()
        }
    } else if (mappedTaskType == TaskType.NORMAL && finalDate != null && (isWeekDate(finalDate) || isMonthDate(finalDate))) {
        finalTime = null
        if (isWeekDate(finalDate)) {
            mappedTaskType = TaskType.WEEKLY_CHECKIN
            mappedRecurring = RecurringType.NONE
        } else {
            mappedTaskType = TaskType.MONTHLY_CHECKIN
            mappedRecurring = RecurringType.NONE
        }
    } else if (selectedTypeUi == TaskType.WEEKLY_CHECKIN) {
        finalTime = null
        if (finalDate == null || !isWeekDate(finalDate)) {
            finalDate = weekStringOf(LocalDate.now())
        }
    } else if (selectedTypeUi == TaskType.MONTHLY_CHECKIN) {
        finalTime = null
        if (finalDate == null || !isMonthDate(finalDate)) {
            finalDate = monthStringOf(LocalDate.now())
        }
    }

    val isCompletedNow = if (mappedTaskType == TaskType.WEEKLY_CHECKIN || mappedTaskType == TaskType.MONTHLY_CHECKIN) {
        val tempTodo = todo.copy(completedDates = completedDates, date = finalDate)
        val completedCount = if (mappedTaskType == TaskType.WEEKLY_CHECKIN) {
            tempTodo.getWeeklyCompletedCount()
        } else {
            tempTodo.getMonthlyCompletedCount()
        }
        targetCount != null && completedCount >= targetCount
    } else {
        parentCompleted
    }
    return todo.copy(
        content = content.takeIf { it.isNotBlank() } ?: todo.content,
        date = finalDate,
        time = finalTime,
        recurring = mappedRecurring,
        taskType = mappedTaskType,
        targetCount = targetCount,
        completedDates = completedDates,
        completed = isCompletedNow,
        completedAt = if (isCompletedNow) {
            if (mappedTaskType == TaskType.WEEKLY_CHECKIN || mappedTaskType == TaskType.MONTHLY_CHECKIN) {
                todo.completedAt ?: nowIso()
            } else {
                parentCompletedAt ?: todo.completedAt ?: nowIso()
            }
        } else null,
        subtasks = subtasks,
        updatedAt = nowIso()
    )
}

// ====== Clipboard utility ======

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("todo subtasks", text)
    clipboard.setPrimaryClip(clip)
    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
}

// ====== Main Dialog ======

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditTodoDialog(
    todo: Todo,
    onDismiss: () -> Unit,
    onAutoSave: (Todo) -> Unit,
    onDelete: () -> Unit
) {
    var content by remember(todo.content) { mutableStateOf(todo.content) }
    var date by remember(todo.id, todo.date) { mutableStateOf(todo.date ?: "") }
    var time by remember(todo.time) { mutableStateOf(todo.time ?: "") }
    var hasDateEnabled by remember(todo.id, todo.date) { mutableStateOf(!todo.date.isNullOrEmpty() && !isWeekDate(todo.date!!) && !isMonthDate(todo.date!!)) }
    var cachedDate by remember(todo.id) { mutableStateOf(if (!todo.date.isNullOrEmpty() && !isWeekDate(todo.date!!) && !isMonthDate(todo.date!!)) todo.date!! else "") }

    LaunchedEffect(date) {
        if (date.isNotBlank() && !isWeekDate(date) && !isMonthDate(date)) {
            cachedDate = date
        }
    }
    var completedDates by remember(todo.completedDates) { mutableStateOf(todo.completedDates) }
    var subtasks by remember(todo.subtasks) { mutableStateOf(todo.subtasks) }
    var editingSubtaskId by remember { mutableStateOf<String?>(null) }
    var targetCount by remember(todo.targetCount) { mutableStateOf(todo.targetCount) }
    var parentCompleted by remember(todo.completed) { mutableStateOf(todo.completed) }
    var parentCompletedAt by remember(todo.completedAt) { mutableStateOf(todo.completedAt) }

    var selectedTypeUi by remember(todo.taskType, todo.recurring) {
        mutableStateOf(if (todo.recurring == RecurringType.DAILY_REPEAT) TaskType.DAILY_REPEAT else todo.taskType)
    }

    val performAutoSave = rememberDebouncedAutoSave(delayMs = 300) { t ->
        onAutoSave(t)
    }

    val buildAndSave: () -> Unit = {
        val updated = buildUpdatedTodo(todo, content, date, time, selectedTypeUi, targetCount, parentCompleted, parentCompletedAt, completedDates, subtasks)
        performAutoSave(updated)
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
        val updated = buildUpdatedTodo(todo, content, date, time, selectedTypeUi, targetCount, parentCompleted, parentCompletedAt, currentDates, subtasks)
        performAutoSave(updated)
    }

    var showDeleteConfirm by remember { mutableStateOf(false) }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("确认删除") },
            text = { Text("您确定要删除这个待办事项吗？") },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    onDelete()
                }) {
                    Text("删除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text("取消")
                }
            }
        )
    }

    Dialog(onDismissRequest = {
        buildAndSave()
        onDismiss()
    }) {
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                EditTodoHeader(
                    onBack = {
                        buildAndSave()
                        onDismiss()
                    },
                    onDelete = { showDeleteConfirm = true }
                )

                EditTodoContentSection(
                    content = content,
                    onContentChange = { content = it },
                    date = date,
                    onDateChange = { date = it },
                    hasDateEnabled = hasDateEnabled,
                    onHasDateEnabledChange = { checked ->
                        if (checked) {
                            val targetDate = if (cachedDate.isNotBlank()) cachedDate else LocalDate.now().toString()
                            date = targetDate
                        } else {
                            date = ""
                        }
                        hasDateEnabled = checked
                        buildAndSave()
                    },
                    selectedTypeUi = selectedTypeUi,
                    performAutoSave = buildAndSave
                )

                EditTodoTypeSection(
                    selectedTypeUi = selectedTypeUi,
                    onTypeChange = { type ->
                        selectedTypeUi = type
                        buildAndSave()
                    }
                )

                if (selectedTypeUi == TaskType.WEEKLY_CHECKIN || selectedTypeUi == TaskType.MONTHLY_CHECKIN) {
                    EditTodoCheckinSection(
                        selectedTypeUi = selectedTypeUi,
                        todo = todo,
                        targetCount = targetCount,
                        onTargetCountChange = { targetCount = it; buildAndSave() },
                        completedDates = completedDates,
                        onToggleCheckinDate = onToggleCheckinDate,
                        date = date
                    )
                }

                EditTodoSubtasksSection(
                    todo = todo,
                    subtasks = subtasks,
                    onSubtasksChange = { subtasks = it },
                    editingSubtaskId = editingSubtaskId,
                    onEditingSubtaskIdChange = { editingSubtaskId = it },
                    parentCompleted = parentCompleted,
                    onParentCompletedChange = { parentCompleted = it },
                    parentCompletedAt = parentCompletedAt,
                    onParentCompletedAtChange = { parentCompletedAt = it },
                    performAutoSave = buildAndSave,
                    context = LocalContext.current
                )
            }
        }
    }
}

// ====== Extracted Sections ======

@Composable
private fun EditTodoHeader(onBack: () -> Unit, onDelete: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, contentDescription = "返回")
            }
            Text("编辑待办", style = MaterialTheme.typography.titleLarge)
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Filled.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
        }
    }
    Spacer(Modifier.height(16.dp))
}

@Composable
private fun EditTodoContentSection(
    content: String,
    onContentChange: (String) -> Unit,
    date: String,
    onDateChange: (String) -> Unit,
    hasDateEnabled: Boolean,
    onHasDateEnabledChange: (Boolean) -> Unit,
    selectedTypeUi: String,
    performAutoSave: () -> Unit
) {
    OutlinedTextField(
        value = content,
        onValueChange = onContentChange,
        modifier = Modifier.fillMaxWidth().onFocusChanged { if (!it.isFocused) performAutoSave() },
        label = { Text("待办内容") },
        trailingIcon = {
            IconButton(onClick = performAutoSave) {
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
                onCheckedChange = onHasDateEnabledChange
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
                    onValueChange = onDateChange,
                    label = { Text("截止日期 (YYYY-MM-DD)") },
                    modifier = Modifier.weight(1f).onFocusChanged { if (!it.isFocused) performAutoSave() }
                )
                Button(
                    onClick = {
                        onDateChange(LocalDate.now().plusDays(1).toString())
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
}

@Composable
private fun EditTodoTypeSection(
    selectedTypeUi: String,
    onTypeChange: (String) -> Unit
) {
    Text("任务类型", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(8.dp))

    val types = listOf(TaskType.NORMAL, TaskType.DAILY_REPEAT, TaskType.WEEKLY_CHECKIN, TaskType.MONTHLY_CHECKIN)
    val typeLabels = listOf("普通待办", "每天重复", "周打卡", "月打卡")
    val selectedTypeIndex = types.indexOf(selectedTypeUi).takeIf { it >= 0 } ?: 0
    SegmentedButton(typeLabels, selectedTypeIndex) {
        onTypeChange(types[it])
    }
}

@Composable
private fun EditTodoCheckinSection(
    selectedTypeUi: String,
    todo: Todo,
    targetCount: Int?,
    onTargetCountChange: (Int?) -> Unit,
    completedDates: List<String>,
    onToggleCheckinDate: (String) -> Unit,
    date: String
) {
    Spacer(Modifier.height(12.dp))
    var targetCountText by remember(targetCount) { mutableStateOf(targetCount?.toString() ?: "") }
    OutlinedTextField(
        value = targetCountText,
        onValueChange = {
            targetCountText = it
            val parsed = it.toIntOrNull()
            onTargetCountChange(if (parsed != null && parsed > 0) parsed else null)
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

@Composable
private fun EditTodoSubtasksSection(
    todo: Todo,
    subtasks: List<Subtask>,
    onSubtasksChange: (List<Subtask>) -> Unit,
    editingSubtaskId: String?,
    onEditingSubtaskIdChange: (String?) -> Unit,
    parentCompleted: Boolean,
    onParentCompletedChange: (Boolean) -> Unit,
    parentCompletedAt: String?,
    onParentCompletedAtChange: (String?) -> Unit,
    performAutoSave: () -> Unit,
    context: Context
) {
    Spacer(Modifier.height(16.dp))
    var showCopyDialog by remember { mutableStateOf(false) }
    var copyOnlyUncompleted by remember { mutableStateOf(true) }

    if (showCopyDialog) {
        AlertDialog(
            onDismissRequest = { showCopyDialog = false },
            title = { Text("复制子步骤") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.clickable { copyOnlyUncompleted = !copyOnlyUncompleted }.padding(bottom = 8.dp)
                    ) {
                        Checkbox(
                            checked = copyOnlyUncompleted,
                            onCheckedChange = { copyOnlyUncompleted = it }
                        )
                        Text("仅复制未完成项")
                    }
                    Text("选择复制格式：")
                    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = {
                                val filtered = if (copyOnlyUncompleted) subtasks.filter { !it.completed } else subtasks
                                copyToClipboard(context, filtered.joinToString("\n") { it.content })
                                showCopyDialog = false
                            }, modifier = Modifier.weight(1f)) { Text("纯文本") }
                            Button(onClick = {
                                val filtered = if (copyOnlyUncompleted) subtasks.filter { !it.completed } else subtasks
                                copyToClipboard(context, filtered.joinToString("\n") { "- ${it.content}" })
                                showCopyDialog = false
                            }, modifier = Modifier.weight(1f)) { Text("无序") }
                        }
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = {
                                val filtered = if (copyOnlyUncompleted) subtasks.filter { !it.completed } else subtasks
                                copyToClipboard(context, filtered.mapIndexed { i, s -> "${i + 1}. ${s.content}" }.joinToString("\n"))
                                showCopyDialog = false
                            }, modifier = Modifier.weight(1f)) { Text("有序") }
                            OutlinedButton(onClick = { showCopyDialog = false }, modifier = Modifier.weight(1f)) { Text("取消") }
                        }
                    }
                }
            },
            confirmButton = {}
        )
    }

    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text("子步骤/备注", style = MaterialTheme.typography.titleMedium)

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = {
                if (subtasks.isEmpty()) return@TextButton
                onSubtasksChange(subtasks.sortedBy { it.completed })
                performAutoSave()
            }) { Text("排序") }

            TextButton(onClick = { showCopyDialog = true }) { Text("复制") }
        }
    }

    val reorderState = rememberReorderableLazyListState(
        onMove = { from, to ->
            onSubtasksChange(subtasks.toMutableList().apply {
                add(to.index, removeAt(from.index))
            })
        },
        onDragEnd = { startIndex, endIndex ->
            if (startIndex != endIndex) performAutoSave()
        }
    )

    LazyColumn(
        state = reorderState.listState,
        modifier = Modifier.heightIn(max = 150.dp).fillMaxWidth().reorderable(reorderState)
    ) {
        items(subtasks, key = { it.id }) { sub ->
            ReorderableItem(reorderState, key = sub.id) { isDragging ->
                val elevation = if (isDragging) 4.dp else 0.dp
                Surface(
                    shadowElevation = elevation,
                    color = if (isDragging) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
                    modifier = Modifier.animateItemPlacement()
                ) {
                    val dragModifier = if (editingSubtaskId != sub.id) {
                        Modifier.detectReorderAfterLongPress(reorderState)
                    } else {
                        Modifier
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().then(dragModifier)) {
                        Checkbox(checked = sub.completed, onCheckedChange = { chk ->
                            val updatedSubtasks = subtasks.map {
                                if (it.id == sub.id) it.copy(completed = chk, completedAt = if (chk) nowIso() else null) else it
                            }
                            onSubtasksChange(updatedSubtasks)
                            val allCompleted = updatedSubtasks.isNotEmpty() && updatedSubtasks.all { it.completed }
                            if (allCompleted) {
                                onParentCompletedChange(true)
                                onParentCompletedChange(true)
                                onParentCompletedAtChange(nowInstant())
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
                                onSubtasksChange(subtasks.map { s -> if (s.id == sub.id) s.copy(content = editContent) else s })
                                performAutoSave()
                                onEditingSubtaskIdChange(null)
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
                            IconButton(onClick = { onEditingSubtaskIdChange(sub.id) }) {
                                Icon(Icons.Filled.Edit, contentDescription = "编辑", modifier = Modifier.size(20.dp))
                            }
                            IconButton(onClick = {
                                onSubtasksChange(subtasks.filter { it.id != sub.id })
                                performAutoSave()
                            }) {
                                Icon(Icons.Filled.Close, contentDescription = "删除子任务", modifier = Modifier.size(20.dp))
                            }
                        }
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
                onSubtasksChange(subtasks + Subtask(UUID.randomUUID().toString(), newSubtaskContent, false))
                newSubtaskContent = ""
                performAutoSave()
            }
        }) {
            Icon(Icons.Filled.Add, contentDescription = "添加")
        }
    }
}

// ====== Reusable sub-components ======

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

// getThisWeekDates() / getThisMonthDates() 已移至 TodoDateUtils.kt 共享

@Composable
fun EditWeekCheckinGrid(
    completedDates: List<String>,
    onToggleDate: (String) -> Unit,
    todoDate: String? = null
) {
    val dates = remember(todoDate) {
        if (todoDate != null && isWeekDate(todoDate)) {
            try {
                val parts = todoDate.split("-W")
                val year = parts[0].toInt()
                val week = parts[1].toInt()
                val jan4 = LocalDate.ofYearDay(year, 1).with(java.time.temporal.IsoFields.WEEK_OF_WEEK_BASED_YEAR, week.toLong())
                val monday = jan4.with(java.time.DayOfWeek.MONDAY)
                (0..6).map { monday.plusDays(it.toLong()) }
            } catch (_: Exception) { getThisWeekDates() }
        } else {
            getThisWeekDates()
        }
    }
    val labels = listOf("一", "二", "三", "四", "五", "六", "日")
    val todayStr = LocalDate.now().toString()

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
    val todayStr = LocalDate.now().toString()

    val targetMonth = remember(todoDate) {
        try {
            val parts = (todoDate ?: "").split("-")
            parts[1].toInt()
        } catch (e: Exception) {
            LocalDate.now().monthValue
        }
    }

    val chunks = dates.chunked(7)
    val weekLabels = listOf("一", "二", "三", "四", "五", "六", "日")

    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
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
                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold),
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
