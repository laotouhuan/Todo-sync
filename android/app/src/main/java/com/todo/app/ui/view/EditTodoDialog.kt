package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.todo.app.data.model.Subtask
import com.todo.app.data.model.Todo
import java.util.UUID

@Composable
fun EditTodoDialog(
    todo: Todo,
    onDismiss: () -> Unit,
    onSave: (Todo) -> Unit,
    onDelete: () -> Unit
) {
    var content by remember { mutableStateOf(todo.content) }
    var importance by remember { mutableStateOf(todo.importance) }
    var urgency by remember { mutableStateOf(todo.urgency) }
    var date by remember { mutableStateOf(todo.date ?: "") }
    var time by remember { mutableStateOf(todo.time ?: "") }
    var recurring by remember { mutableStateOf(todo.recurring) }
    var subtasks by remember { mutableStateOf(todo.subtasks) }

    Dialog(onDismissRequest = onDismiss) {
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("编辑待办", style = MaterialTheme.typography.titleLarge)
                Spacer(Modifier.height(16.dp))

                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it },
                    label = { Text("待办内容") },
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("重要性:")
                    Spacer(Modifier.width(8.dp))
                    PriorityChipGroup(listOf("低", "中", "高"), importance - 1) { importance = it + 1 }
                }

                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("紧急性:")
                    Spacer(Modifier.width(8.dp))
                    PriorityChipGroup(listOf("低", "中", "高"), urgency - 1) { urgency = it + 1 }
                }

                Spacer(Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = date,
                        onValueChange = { date = it },
                        label = { Text("截止日期 (YYYY-MM-DD)") },
                        modifier = Modifier.weight(1f)
                    )
                }

                Spacer(Modifier.height(8.dp))
                // 重复规则简易选择
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("重复规则:")
                    Spacer(Modifier.width(8.dp))
                    val rules = listOf("none", "daily", "weekly", "monthly")
                    val labels = listOf("不重复", "每天", "每周", "每月")
                    val selectedIndex = rules.indexOf(recurring).takeIf { it >= 0 } ?: 0
                    SegmentedButton(labels, selectedIndex) { recurring = rules[it] }
                }

                Spacer(Modifier.height(16.dp))
                Text("子步骤拆解", style = MaterialTheme.typography.titleMedium)
                LazyColumn(modifier = Modifier.heightIn(max = 150.dp).fillMaxWidth()) {
                    items(subtasks) { sub ->
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                            Checkbox(checked = sub.completed, onCheckedChange = { chk ->
                                subtasks = subtasks.map { if (it.id == sub.id) it.copy(completed = chk) else it }
                            })
                            Text(
                                text = sub.content, 
                                modifier = Modifier.weight(1f),
                                color = if (sub.completed) Color.Gray else MaterialTheme.colorScheme.onSurface,
                                textDecoration = if (sub.completed) TextDecoration.LineThrough else null
                            )
                            IconButton(onClick = { subtasks = subtasks.filter { it.id != sub.id } }) {
                                Icon(Icons.Filled.Close, contentDescription = "删除子任务")
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
                        placeholder = { Text("添加新子步骤...") }
                    )
                    IconButton(onClick = {
                        if (newSubtaskContent.isNotBlank()) {
                            subtasks = subtasks + Subtask(UUID.randomUUID().toString(), newSubtaskContent, false)
                            newSubtaskContent = ""
                        }
                    }) {
                        Icon(Icons.Filled.Add, contentDescription = "添加")
                    }
                }

                Spacer(Modifier.height(24.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = onDelete, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                        Icon(Icons.Filled.Delete, contentDescription = null)
                        Spacer(Modifier.width(4.dp))
                        Text("删除")
                    }
                    Row {
                        TextButton(onClick = onDismiss) { Text("取消") }
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = {
                            if (content.isNotBlank()) {
                                onSave(todo.copy(
                                    content = content,
                                    importance = importance,
                                    urgency = urgency,
                                    date = date.takeIf { it.isNotBlank() },
                                    time = time.takeIf { it.isNotBlank() },
                                    recurring = recurring,
                                    subtasks = subtasks
                                ))
                            }
                        }) {
                            Text("确定")
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SegmentedButton(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { index, text ->
            val isSelected = index == selectedIndex
            FilterChip(
                selected = isSelected,
                onClick = { onSelect(index) },
                label = { Text(text) }
            )
        }
    }
}

@Composable
fun PriorityChipGroup(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { index, text ->
            val isSelected = index == selectedIndex
            val color = when (index) {
                2 -> Color(0xFFF5222D) // High
                1 -> Color(0xFFFA8C16) // Medium
                else -> Color(0xFF52C41A) // Low
            }
            FilterChip(
                selected = isSelected,
                onClick = { onSelect(index) },
                label = { Text(text) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = color.copy(alpha = 0.2f),
                    selectedLabelColor = color
                )
            )
        }
    }
}
