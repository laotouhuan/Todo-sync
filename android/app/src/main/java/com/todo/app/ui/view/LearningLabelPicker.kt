package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Learning

@Composable
fun LearningLabelPicker(value: String, candidates: List<String>, onChange: (String) -> Unit) {
    var choosing by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var search by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    Row {
        TextButton(onClick = { search = ""; choosing = true }) { Text("选择已有标签") }
        TextButton(onClick = { name = ""; creating = true }) { Text("新建标签") }
    }
    if (choosing) AlertDialog(onDismissRequest = { choosing = false }, title = { Text("选择标签") }, text = {
        Column {
            OutlinedTextField(search, { search = it }, label = { Text("搜索标签") })
            Column(Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState())) {
                (listOf<String?>(null) + candidates).filter { (it ?: "未分类").contains(search.trim()) }.forEach { label ->
                    TextButton(onClick = { onChange(label ?: ""); choosing = false }) {
                        Text((if (Learning.label(value) == label) "✓ " else "") + (label ?: "未分类"))
                    }
                }
            }
        }
    }, confirmButton = { TextButton(onClick = { choosing = false }) { Text("取消") } })
    if (creating) AlertDialog(onDismissRequest = { creating = false }, title = { Text("新建标签") }, text = {
        OutlinedTextField(name, { name = it }, label = { Text("标签名称") })
    }, confirmButton = { TextButton(onClick = { onChange(Learning.label(name) ?: ""); creating = false }) { Text("确认") } },
        dismissButton = { TextButton(onClick = { creating = false }) { Text("取消") } })
}
