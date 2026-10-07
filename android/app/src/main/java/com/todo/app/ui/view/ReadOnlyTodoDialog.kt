package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TaskType
import com.todo.app.ui.viewmodel.TodoViewModel

@Composable
internal fun ReadOnlyTodoDialog(todo: Todo, viewModel: TodoViewModel, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("任务详情") }, text = {
        Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(todo.content)
            val type = when {
                todo.recurring == "daily_repeat" -> "每天重复"
                todo.taskType == TaskType.WEEKLY_CHECKIN -> "周打卡"
                todo.taskType == TaskType.MONTHLY_CHECKIN -> "月打卡"
                else -> "普通待办"
            }
            Text("类型：$type")
            Text("截止日期：${todo.date ?: "未设置"} ${todo.time ?: ""}")
            Text("标签：${todo.label ?: "未分类"}")
            Text("状态：${if (todo.completed) "已完成" else "未完成"}")
            Text("完成时间：${todo.completedAt ?: "无"}")
            todo.reminder?.let { Text("提醒：${it.reminderDate ?: ""} ${it.reminderTime}${if (it.repeatDaily) " · 每日重复" else ""}") }
            todo.targetCount?.let { Text("目标打卡：$it 次") }
            todo.completedDates.forEach { Text("打卡：$it") }
            todo.subtasks.forEach { Text("${if (it.completed) "✓" else "○"} ${it.content}${it.completedAt?.let { time -> " · $time" } ?: ""}") }
            LearningTaskRecords(viewModel, todo)
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}
