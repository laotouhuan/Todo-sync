package com.todo.app.ui.view

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
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
    var recurring by remember(todo.recurring) { mutableStateOf(todo.recurring) }
    var subtasks by remember(todo.subtasks) { mutableStateOf(todo.subtasks) }
    var editingSubtaskId by remember { mutableStateOf<String?>(null) }

    val context = LocalContext.current

    // 防抖 auto-save：300ms 内多次调用只执行最后一次，避免频繁磁盘写入
    val coroutineScope = rememberCoroutineScope()
    var autoSaveJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    val performAutoSave = {
        autoSaveJob?.cancel()
        autoSaveJob = coroutineScope.launch {
            kotlinx.coroutines.delay(300)
            onAutoSave(todo.copy(
                content = content.takeIf { it.isNotBlank() } ?: todo.content,
                date = date.takeIf { it.isNotBlank() },
                time = time.takeIf { it.isNotBlank() },
                recurring = recurring,
                subtasks = subtasks,
                updated_at = nowIso()
            ))
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
                    label = { Text("待办内容") }
                )

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

                Spacer(Modifier.height(16.dp))
                Text("重复规则", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                
                val rules = listOf("none", "daily", "weekly", "monthly")
                val labels = listOf("不重复", "每天", "每周", "每月")
                val selectedIndex = rules.indexOf(recurring).takeIf { it >= 0 } ?: 0
                SegmentedButton(labels, selectedIndex) { 
                    recurring = rules[it]
                    performAutoSave()
                }

                Spacer(Modifier.height(16.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("子步骤/备注", style = MaterialTheme.typography.titleMedium)
                    
                    var expandedCopyMenu by remember { mutableStateOf(false) }
                    Box {
                        TextButton(onClick = { expandedCopyMenu = true }) { Text("复制") }
                        DropdownMenu(expanded = expandedCopyMenu, onDismissRequest = { expandedCopyMenu = false }) {
                            DropdownMenuItem(text = { Text("纯文本") }, onClick = { 
                                val text = subtasks.joinToString("\n") { it.content }
                                copyToClipboard(context, text)
                                expandedCopyMenu = false 
                            })
                            DropdownMenuItem(text = { Text("无序列表") }, onClick = { 
                                val text = subtasks.joinToString("\n") { "- ${it.content}" }
                                copyToClipboard(context, text)
                                expandedCopyMenu = false 
                            })
                            DropdownMenuItem(text = { Text("有序列表") }, onClick = { 
                                val text = subtasks.mapIndexed { i, s -> "${i + 1}. ${s.content}" }.joinToString("\n")
                                copyToClipboard(context, text)
                                expandedCopyMenu = false 
                            })
                        }
                    }
                }
                
                LazyColumn(modifier = Modifier.heightIn(max = 150.dp).fillMaxWidth()) {
                    items(subtasks, key = { it.id }) { sub ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Checkbox(checked = sub.completed, onCheckedChange = { chk ->
                                subtasks = subtasks.map { if (it.id == sub.id) it.copy(completed = chk) else it }
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
