package com.todo.app

import android.app.Application
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.todo.app.data.model.TaskReference
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.ui.theme.TodoAppTheme
import com.todo.app.widget.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** 只保留当前面板的一次提交；重建只重新加载，不重放任务选择。 */
class WidgetTimerViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as TodoApplication).repository
    val data = repository.getTodoData()
    val enabled = repository.timeTrackingEnabled
    var busy by mutableStateOf(false)
        private set
    var loading by mutableStateOf(false)
        private set
    var ready by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var started by mutableStateOf(false)
        private set

    fun reload() {
        if (busy || loading || started) return
        loading = true
        viewModelScope.launch {
            try {
                repository.ensureDataLoaded()
                ready = true
                error = null
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                ready = false
                error = repository.loadError.value ?: e.message ?: "数据加载失败"
            } finally { loading = false }
        }
    }

    fun start(todo: Todo) {
        if (busy || loading || !ready || started) return
        busy = true
        error = null
        viewModelScope.launch {
            try {
                repository.startLearning(todo, TaskReference(todo.id)).getOrThrow()
                started = true
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.message ?: "开始计时失败，请重试"
            } finally { busy = false }
        }
    }
}

class WidgetTimerActivity : ComponentActivity() {
    private val model: WidgetTimerViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            TodoAppTheme {
                val data by model.data.collectAsState(initial = TodoData(1, "", emptyList()))
                val enabled by model.enabled.collectAsState()
                val timer = widgetTimerState(data, enabled)
                BackHandler(enabled = model.busy) { }
                LaunchedEffect(model.started) { if (model.started) finish() }
                BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.3f))
                    .clickable(enabled = !model.busy) { finish() }) {
                    Surface(modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                        .heightIn(max = maxHeight * 0.85f).navigationBarsPadding().clickable { },
                        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)) {
                        Column(Modifier.padding(20.dp)) {
                            Text("选择要计时的任务", style = MaterialTheme.typography.titleLarge)
                            Text("点击任务开始计时", style = MaterialTheme.typography.bodySmall)
                            if (model.busy || model.loading) {
                                LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 12.dp))
                                Text("正在处理，请稍候…")
                            }
                            model.error?.let {
                                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
                                if (!model.ready) TextButton(enabled = !model.busy && !model.loading, onClick = model::reload) { Text("重试加载") }
                            }
                            if (model.ready) {
                                when (timer) {
                                    WidgetTimerState.Disabled -> Text("请在设置中启用计时")
                                    WidgetTimerState.Idle -> {
                                        val candidates = widgetTimerCandidates(data)
                                        if (candidates.isEmpty()) Text("暂无可选任务")
                                        LazyColumn(Modifier.weight(1f, fill = false)) {
                                            items(candidates, key = { it.id }) { todo ->
                                                TextButton(onClick = { model.start(todo) }, enabled = !model.busy && !model.loading,
                                                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                                    Text(todo.content, modifier = Modifier.fillMaxWidth())
                                                }
                                            }
                                        }
                                    }
                                    is WidgetTimerState.Running -> Text("已有任务正在计时，请先结束或处理记录")
                                    is WidgetTimerState.Attention -> Text(timer.message)
                                }
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                TextButton(enabled = !model.busy, onClick = {
                                    startActivity(Intent(this@WidgetTimerActivity, MainActivity::class.java))
                                    finish()
                                }) { Text("打开应用") }
                                TextButton(enabled = !model.busy, onClick = { finish() }) { Text("取消") }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        model.reload()
    }
}
