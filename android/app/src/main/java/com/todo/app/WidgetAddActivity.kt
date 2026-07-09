package com.todo.app

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Todo
import com.todo.app.data.model.parseDateSyntax
import com.todo.app.ui.theme.TodoAppTheme
import com.todo.app.widget.refreshAllWidgets
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first

class WidgetAddActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            TodoAppTheme {
                var addInput by remember { mutableStateOf("") }
                val focusRequester = remember { FocusRequester() }

                LaunchedEffect(Unit) {
                    try {
                        delay(100)
                        focusRequester.requestFocus()
                    } catch (e: Exception) {
                        android.util.Log.d("WidgetAdd", "焦点请求失败", e)
                    }
                }

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { finish() }
                        .background(Color.Black.copy(alpha = 0.3f))
                ) {
                    Surface(
                        shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .align(Alignment.BottomCenter)
                            .imePadding()
                            .clickable(enabled = false) {}
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
        if (trimmed.isBlank()) {
            Toast.makeText(this, "请输入待办内容", Toast.LENGTH_SHORT).show()
            return
        }

        val parsed = parseDateSyntax(trimmed)

        if (parsed.content.isBlank()) {
            Toast.makeText(this, "请输入待办内容", Toast.LENGTH_SHORT).show()
            return
        }

        val repository = TodoApplication.instance.repository
        lifecycleScope.launch {
            try {
                val currentData = repository.getTodoData().first()
                val minOrder = currentData.todos.filter { !it.deleted && !it.completed }.minOfOrNull { it.order } ?: System.currentTimeMillis().toDouble()
                val newTodo = Todo.create(parsed.content, parsed.date).copy(
                    taskType = parsed.taskType,
                    targetCount = parsed.targetCount,
                    recurring = if (parsed.taskType == "daily_repeat") "daily_repeat" else "none",
                    order = minOrder - 1.0
                )
                repository.addTodo(newTodo)

                refreshAllWidgets(applicationContext)
            } catch (e: Exception) {
                android.util.Log.e("WidgetAdd", "保存待办失败", e)
            } finally {
                finish()
            }
        }
    }
}
