package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.*
import com.todo.app.ui.viewmodel.TodoViewModel
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.launch

private fun timelineTime(value: String?): String = Learning.instant(value)?.atZone(ZoneId.systemDefault())
    ?.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")) ?: ""

@Composable
internal fun TimelineSubtaskPicker(viewModel: TodoViewModel, items: List<Pair<Todo, Subtask>>, onDismiss: () -> Unit) {
    var selected by remember(items) { mutableStateOf(items.singleOrNull()) }
    val item = selected
    if (item != null) TimelineSubtaskEditor(viewModel, item.first, item.second, onDismiss)
    else AlertDialog(onDismissRequest = onDismiss, title = { Text("选择子步骤") }, text = {
        Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
            items.forEach { pair -> TextButton(onClick = { selected = pair }) { Text("${pair.first.content} / ${pair.second.content}") } }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

@Composable
internal fun TimelineRecordEditor(viewModel: TodoViewModel, ids: List<String>, onDismiss: () -> Unit) {
    val data by viewModel.todoData.collectAsState()
    val records = data.timeEntries.filter { it.id in ids && !it.deleted }
    var selected by remember(ids) { mutableStateOf(ids.distinct().singleOrNull()) }
    val entry = records.find { it.id == selected }
    if (entry != null) TimeEntryEditor(entry, viewModel, onDismiss)
    else AlertDialog(onDismissRequest = onDismiss, title = { Text("选择计时记录") }, text = {
        Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
            if (records.isEmpty()) Text("该计时记录已删除")
            records.forEach { record -> TextButton(onClick = { selected = record.id }) {
                Text("${record.task_content_snapshot}\n${timelineTime(record.started_at)} — ${timelineTime(record.ended_at)}")
            } }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

@Composable
internal fun TimelineSubtaskEditor(viewModel: TodoViewModel, todo: Todo, subtask: Subtask, onDismiss: () -> Unit) {
    val source = remember(todo.id, subtask.id) { viewModel.activeSource.value }
    var content by rememberSaveable(todo.id, subtask.id) { mutableStateOf(subtask.content) }
    val originalTime = remember(todo.id, subtask.id) { timelineTime(subtask.completedAt) }
    var time by rememberSaveable(todo.id, subtask.id) { mutableStateOf(originalTime) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("子步骤详情") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("所属任务：${todo.content}")
            OutlinedTextField(content, { content = it }, label = { Text("子步骤内容") }, enabled = !busy)
            OutlinedTextField(time, { time = it }, label = { Text("完成时间（无具体时间可留空）") }, enabled = !busy)
            Text("日期和时间格式：2026-09-10 09:30:00")
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = {
        scope.launch {
            busy = true
            try {
                require(content.isNotBlank()) { "子步骤内容不能为空" }
                check(viewModel.activeSource.value == source) { "清单已切换，请重新打开" }
                val current = viewModel.activeTodos.value.find { it.id == todo.id && !it.deleted }
                check(current != null && current.subtasks.any { it.id == subtask.id }) { "该子步骤已删除" }
                val completedAt = if (time == originalTime) subtask.completedAt else if (time.isBlank()) null else {
                    try { LocalDateTime.parse(time.trim().replace(' ', 'T')).atZone(ZoneId.systemDefault()).toInstant().toString() }
                    catch (_: Exception) { throw IllegalArgumentException("请输入有效的完成时间") }
                }
                viewModel.saveEditedTodo(current.copy(subtasks = current.subtasks.map {
                    if (it.id == subtask.id) it.copy(content = content.trim(), completedAt = completedAt) else it
                }, updatedAt = nowIso()))
                onDismiss()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = e.message ?: "保存失败"
            } finally { busy = false }
        }
    }) { Text("保存") } }, dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") } })
}
