package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.*
import com.todo.app.ui.viewmodel.TodoViewModel
import kotlinx.coroutines.launch

@Composable
fun LabelManagerView(viewModel: TodoViewModel) {
    val data by viewModel.todoData.collectAsState()
    var query by remember { mutableStateOf("") }
    var label by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var plan by remember { mutableStateOf<LabelChangePlan?>(null) }
    var target by remember { mutableStateOf("") }
    var clearing by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var detail by remember { mutableStateOf<Todo?>(null) }
    val scope = rememberCoroutineScope()
    val groups = remember(data.todos) { LabelUtils.groups(data.todos) }
    val members = data.todos.filter { !it.deleted && Learning.label(it.label) == label }
    LaunchedEffect(data.todos) { selected = selected.intersect(members.map { it.id }.toSet()) }
    fun propose(caption: String, whole: Boolean, clear: Boolean = false) {
        val next = LabelUtils.plan(data.todos, label, if (whole) null else selected)
        if (next.expected.isEmpty()) return
        plan = next; target = if (clear) "" else label.orEmpty(); clearing = clear; title = caption; error = ""
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("个人清单 · 标签管理", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(query, { query = it; selected = emptySet() }, label = { Text("搜索标签") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        groups.filter { (it.label ?: "未分类").contains(query.trim()) }.forEach { group ->
            FilterChip(selected = group.label == label, onClick = { label = group.label; selected = emptySet(); notice = "" },
                label = { Text("${group.label ?: "未分类"} · ${group.count}") })
        }
        HorizontalDivider()
        Text(label ?: "未分类", style = MaterialTheme.typography.titleMedium)
        if (notice.isNotEmpty()) Text(notice)
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { selected = members.map { it.id }.toSet() }) { Text("全选") }
            TextButton(onClick = { selected = emptySet() }) { Text("清除选择") }
            Text("已选 ${selected.size} 个")
        }
        Row {
            TextButton(enabled = selected.isNotEmpty(), onClick = { propose("批量修改标签", false) }) { Text("批量修改") }
            TextButton(enabled = selected.isNotEmpty(), onClick = { propose("移除所选任务标签", false, true) }) { Text("移除标签") }
        }
        if (label != null) Row {
            TextButton(enabled = members.isNotEmpty(), onClick = { propose("重命名 / 合并标签", true) }) { Text("重命名 / 合并") }
            TextButton(enabled = members.isNotEmpty(), onClick = { propose("清空标签（不删除任务）", true, true) }) { Text("清空标签") }
        }
        if (members.isEmpty()) Text("此标签暂无任务")
        members.forEach { todo ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(todo.id in selected, { checked -> selected = if (checked) selected + todo.id else selected - todo.id })
                TextButton(onClick = { detail = todo }, modifier = Modifier.weight(1f)) {
                    Column(Modifier.fillMaxWidth()) {
                        Text("${if (todo.completed) "✓ " else ""}${todo.content}")
                        Text("${todo.date ?: "无日期"} · ${if (todo.completed) "已完成" else "未完成"}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
    plan?.let { pending ->
        AlertDialog(onDismissRequest = { if (!busy) plan = null }, title = { Text(title) }, text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!clearing) {
                    OutlinedTextField(target, { target = it }, enabled = !busy, label = { Text("目标标签（可输入新名称）") })
                    groups.filter { it.label != null }.forEach { group ->
                        TextButton(enabled = !busy, onClick = { target = group.label.orEmpty() }) { Text(group.label.orEmpty()) }
                    }
                }
                val normalized = Learning.label(target)
                Text("个人清单 · ${pending.expected.size} 个任务 → ${normalized ?: "未分类"}")
                if (pending.wholeLabel && normalized != null && normalized != pending.label && groups.any { it.label == normalized }) Text("将合并到已有标签")
                Text("相关计时记录将在统计中按新标签归类，计时时长不变。", style = MaterialTheme.typography.bodySmall)
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        }, confirmButton = { TextButton(enabled = !busy, onClick = {
            busy = true
            scope.launch {
                try {
                    val result = viewModel.updatePersonalLabels(pending, if (clearing) null else target)
                    result.onSuccess { count ->
                        if (pending.wholeLabel) label = Learning.label(if (clearing) null else target)
                        notice = "已在本地修改 $count 个任务；云同步结果请查看同步状态。"; selected = emptySet(); plan = null
                    }
                        .onFailure { error = it.message ?: "保存失败，请重试" }
                } finally { busy = false }
            }
        }) { Text("确认修改") } }, dismissButton = { TextButton(enabled = !busy, onClick = { plan = null }) { Text("取消") } })
    }
    detail?.let { todo ->
        AlertDialog(onDismissRequest = { detail = null }, title = { Text("任务详情") }, text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text(todo.content)
                Text("${todo.date ?: "无日期"} ${todo.time ?: ""} · ${if (todo.completed) "已完成" else "未完成"}")
                todo.subtasks.forEach { Text("${if (it.completed) "✓" else "○"} ${it.content}") }
            }
        }, confirmButton = { TextButton(onClick = { detail = null }) { Text("关闭") } })
    }
}
