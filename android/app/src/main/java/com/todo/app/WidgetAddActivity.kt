package com.todo.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.todo.app.ui.theme.TodoAppTheme
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class WidgetAddActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        setContent {
            TodoAppTheme {
                var addInput by remember { mutableStateOf("") }
                val focusRequester = remember { FocusRequester() }
                
                LaunchedEffect(Unit) {
                    focusRequester.requestFocus()
                }

                // 替代底层的 Dialog，使用纯 Compose 的 Box 避免任何由于 Theme.AppCompat 引起的崩溃
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { finish() } // 点击外部退出
                        .background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.3f))
                ) {
                    LaunchedEffect(Unit) {
                        try {
                            // 延迟一小段时间，确保组件已挂载再获取焦点
                            kotlinx.coroutines.delay(100)
                            focusRequester.requestFocus()
                        } catch (e: Exception) {
                            android.util.Log.d("WidgetAdd", "焦点请求失败", e)
                        }
                    }

                    Surface(
                        shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .align(Alignment.BottomCenter) // 贴近底部
                            .imePadding() // 键盘弹出时自动顶起
                            .clickable(enabled = false) {} // 阻挡点击穿透
                            .wrapContentHeight(),
                        tonalElevation = 8.dp
                    ) {
                        Row(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(
                                value = addInput,
                                onValueChange = { addInput = it },
                                modifier = Modifier.weight(1f).focusRequester(focusRequester),
                                placeholder = { Text("添加待办") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = {
                                    saveAndExit(addInput)
                                })
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            IconButton(onClick = {
                                saveAndExit(addInput)
                            }) {
                                Icon(Icons.Filled.Add, contentDescription = "Add")
                            }
                        }
                    }
                }
            }
        }
    }

    private fun saveAndExit(rawContent: String) {
        val trimmed = rawContent.trim()
        if (trimmed.isNotBlank()) {
            val parsed = com.todo.app.data.model.parseDateSyntax(trimmed)

            if (parsed.content.isBlank()) {
                finish()
                return
            }

            val repository = TodoApplication.instance.repository
            lifecycleScope.launch {
                try {
                    val newTodo = com.todo.app.data.model.Todo.create(parsed.content, parsed.date).copy(
                        task_type = parsed.taskType,
                        target_count = parsed.targetCount,
                        recurring = if (parsed.taskType == "daily_repeat") "daily_repeat" else "none"
                    )
                    repository.addTodo(newTodo)
                    
                    com.todo.app.widget.refreshAllWidgets(applicationContext)
                } catch (e: Exception) {
                    android.util.Log.e("WidgetAdd", "保存待办失败", e)
                }
                finish()
            }
        } else {
            finish()
        }
    }
}
