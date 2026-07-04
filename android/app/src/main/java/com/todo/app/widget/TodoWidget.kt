package com.todo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.glance.*
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.layout.*
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.todo.app.MainActivity
import com.todo.app.TodoApplication
import com.todo.app.WidgetAddActivity
import com.todo.app.data.model.Todo
import com.todo.app.data.model.DateStrings
import com.todo.app.data.model.classifyForTodayFocus
import com.todo.app.data.model.TodoComparator
import com.todo.app.data.model.isOverdue
import java.time.LocalDate
import java.util.Locale

// 全局唯一的 Key 常量，保证 actionRunCallback 绑定时和 ToggleActionCallback 取值时用同一个实例
val TodoIdKey = ActionParameters.Key<String>("todoId")

/** Widget 渲染模型：区分真实 Todo 和 UI 分隔线，避免污染领域模型 */
sealed class WidgetItem {
    data class TodoItem(val todo: Todo) : WidgetItem()
    data class Separator(val id: String) : WidgetItem()
}

// Glance 状态版本号 key，每次数据变更递增，用于触发 Compose recomposition
private val VERSION_KEY = intPreferencesKey("widget_data_version")
val EXPANDED_TODOS_KEY = stringSetPreferencesKey("expanded_todos")

abstract class BaseTodoWidget(private val maxItems: Int, private val showHeader: Boolean) : GlanceAppWidget() {
    companion object {
        private val DATE_FORMATTER = java.time.format.DateTimeFormatter.ofPattern("M月d日 EEEE", Locale.CHINESE)
    }

    // 使用 Glance 内置的 Preferences 状态定义
    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            // 读取 Glance Preferences 状态 —— 这是关键！
            // currentState 返回一个 Compose State 对象，Compose 运行时会跟踪它。
            // 当 ToggleActionCallback 通过 updateAppWidgetState 修改版本号后，
            // Compose 运行时检测到状态变化，会真正重新执行这个 composable 函数体。
            val prefs = currentState<Preferences>()
            @Suppress("UNUSED_VARIABLE")
            val version = prefs[VERSION_KEY] ?: 0

            // 从内存中同步读取最新数据
            val repository = TodoApplication.instance.repository
            val currentData = try {
                repository.getCurrentData()
            } catch (e: Exception) {
                android.util.Log.e("TodoWidget", "Widget getCurrentData 失败: ${e.message}", e)
                com.todo.app.data.model.TodoData(version = 1, last_updated = "", todos = emptyList())
            }
            val expandedTodos = prefs[EXPANDED_TODOS_KEY] ?: emptySet()

            val dates = DateStrings.now()
            val todayStr = dates.today

            val todayFocus = run {
                val focusGroups = classifyForTodayFocus(currentData.todos, dates.today, dates.thisWeek, dates.thisMonth)
                val todayTasks = focusGroups.todayTasks
                val weekTasks = focusGroups.weekTasks
                val monthTasks = focusGroups.monthTasks

                val list = mutableListOf<WidgetItem>()

                fun addGroup(todos: List<Todo>, separatorId: String) {
                    if (todos.isEmpty()) return
                    if (list.isNotEmpty()) list.add(WidgetItem.Separator(separatorId))
                    list.addAll(todos.map { WidgetItem.TodoItem(it) })
                }

                addGroup(todayTasks, "SEPARATOR_WEEK")
                addGroup(weekTasks, "SEPARATOR_MONTH")
                addGroup(monthTasks, "SEPARATOR_END")

                list.take(maxItems)
            }

            val widgetBackground = ColorProvider(Color(0xB3121212))
            val surfaceColor = ColorProvider(Color(0x26FFFFFF))
            val textColor = ColorProvider(Color.White)
            val textVariantColor = ColorProvider(Color(0xFFAAAAAA))

            val dateObj = LocalDate.now()
            val dateString = dateObj.format(DATE_FORMATTER)

            val syncStatus = repository.syncStatus.value
            val statusColor = ColorProvider(when (syncStatus) {
                1 -> Color(0xFF1890FF)
                2 -> Color(0xFFFA8C16)
                else -> Color(0xFF52C41A)
            })

            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(widgetBackground)
                    .cornerRadius(20.dp)
                    .padding(16.dp)
            ) {
                if (showHeader) {
                    Row(
                        modifier = GlanceModifier.fillMaxWidth().padding(bottom = 14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = GlanceModifier.defaultWeight()) {
                            Text(
                                text = "Todo",
                                style = TextStyle(color = textColor, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                            )
                            Spacer(modifier = GlanceModifier.height(2.dp))
                            Text(
                                text = dateString,
                                style = TextStyle(color = textVariantColor, fontSize = 12.sp)
                            )
                        }
                        
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "打开",
                                style = TextStyle(color = textColor, fontSize = 12.sp, fontWeight = FontWeight.Bold),
                                modifier = GlanceModifier
                                    .padding(horizontal = 8.dp, vertical = 4.dp)
                                    .background(ColorProvider(Color(0x33FFFFFF)))
                                    .cornerRadius(8.dp)
                                    .clickable(actionStartActivity<MainActivity>())
                            )
                            Spacer(modifier = GlanceModifier.width(12.dp))
                            Box(modifier = GlanceModifier.size(8.dp).background(statusColor).cornerRadius(4.dp)) {}
                            Spacer(modifier = GlanceModifier.width(8.dp))
                            Image(
                                provider = ImageProvider(android.R.drawable.ic_popup_sync),
                                contentDescription = "Sync",
                                modifier = GlanceModifier
                                    .size(28.dp)
                                    .padding(4.dp)
                                    .clickable(actionRunCallback<SyncActionCallback>())
                            )
                        }
                    }

                    Row(
                        modifier = GlanceModifier
                            .fillMaxWidth()
                            .background(surfaceColor)
                            .cornerRadius(12.dp)
                            .padding(horizontal = 12.dp, vertical = 10.dp)
                            .clickable(actionStartActivity<WidgetAddActivity>()),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "+ 快速添加新任务...",
                            style = TextStyle(color = textVariantColor, fontSize = 14.sp)
                        )
                    }
                    Spacer(modifier = GlanceModifier.height(16.dp))
                } else {
                    Row(
                        modifier = GlanceModifier.fillMaxWidth().padding(bottom = 12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "今天聚焦",
                            style = TextStyle(color = textColor, fontSize = 15.sp, fontWeight = FontWeight.Bold),
                            modifier = GlanceModifier.defaultWeight()
                        )
                        Text(
                            text = "打开",
                            style = TextStyle(color = textColor, fontSize = 12.sp, fontWeight = FontWeight.Bold),
                            modifier = GlanceModifier
                                .padding(horizontal = 8.dp, vertical = 4.dp)
                                .background(ColorProvider(Color(0x33FFFFFF)))
                                .cornerRadius(8.dp)
                                .clickable(actionStartActivity<MainActivity>())
                        )
                    }
                }

                if (todayFocus.isEmpty()) {
                    Box(modifier = GlanceModifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            text = "☕ 任务全搞定啦！",
                            style = TextStyle(color = textVariantColor, fontSize = 14.sp)
                        )
                    }
                } else {
                    LazyColumn(modifier = GlanceModifier.fillMaxSize()) {
                        items(
                            items = todayFocus,
                            itemId = { item -> when (item) {
                                is WidgetItem.Separator -> item.id.hashCode().toLong()
                                is WidgetItem.TodoItem -> item.todo.id.hashCode().toLong()
                            }}
                        ) { item ->
                            when (item) {
                                is WidgetItem.Separator -> {
                                    Column(modifier = GlanceModifier.fillMaxWidth()) {
                                        Box(
                                            modifier = GlanceModifier
                                                .fillMaxWidth()
                                                .height(1.dp)
                                                .background(ColorProvider(Color(0x33FFFFFF)))
                                        ) {}
                                        Spacer(modifier = GlanceModifier.height(8.dp))
                                    }
                                }
                                is WidgetItem.TodoItem -> {
                                    TodoItemWidget(item.todo, surfaceColor, textColor, textVariantColor, expandedTodos.contains(item.todo.id))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TodoItemWidget(todo: Todo, surfaceColor: ColorProvider, textColor: ColorProvider, textVariantColor: ColorProvider, isExpanded: Boolean) {
    Column(modifier = GlanceModifier.fillMaxWidth()) {
        Row(
            modifier = GlanceModifier
                .fillMaxWidth()
                .background(surfaceColor)
                .cornerRadius(12.dp)
                .let {
                    if (todo.subtasks.isNotEmpty()) {
                        it.clickable(actionRunCallback<ExpandActionCallback>(actionParametersOf(TodoIdKey to todo.id)))
                    } else {
                        it.clickable(actionStartActivity<MainActivity>())
                    }
                },
            verticalAlignment = Alignment.CenterVertically
        ) {

            Image(
                provider = ImageProvider(
                    if (todo.completed) android.R.drawable.checkbox_on_background
                    else android.R.drawable.checkbox_off_background
                ),
                contentDescription = "Toggle",
                modifier = GlanceModifier
                    .size(38.dp)
                    .padding(10.dp)
                    .clickable(
                        actionRunCallback<ToggleActionCallback>(actionParametersOf(TodoIdKey to todo.id))
                    )
            )
            Text(
                text = todo.content,
                style = TextStyle(
                    color = if (todo.completed) textVariantColor else textColor,
                    textDecoration = if (todo.completed) androidx.glance.text.TextDecoration.LineThrough else androidx.glance.text.TextDecoration.None,
                    fontSize = 15.sp
                ),
                maxLines = 1,
                modifier = GlanceModifier.defaultWeight().padding(end = 12.dp, top = 12.dp, bottom = 12.dp)
            )
        }
        if (isExpanded && todo.subtasks.isNotEmpty()) {
            Column(modifier = GlanceModifier.padding(start = 38.dp, top = 4.dp, bottom = 4.dp, end = 12.dp)) {
                todo.subtasks.forEach { sub ->
                    val color = if (sub.completed) ColorProvider(Color(0xFF666666)) else textVariantColor
                    val decoration = if (sub.completed) androidx.glance.text.TextDecoration.LineThrough else androidx.glance.text.TextDecoration.None
                    Text(
                        text = "- ${sub.content}", 
                        style = TextStyle(color = color, fontSize = 13.sp, textDecoration = decoration),
                        modifier = GlanceModifier.padding(vertical = 2.dp)
                    )
                }
            }
        }
        Spacer(modifier = GlanceModifier.height(8.dp))
    }
}

class TodoCompactWidget : BaseTodoWidget(maxItems = 3, showHeader = false)
class TodoNormalWidget : BaseTodoWidget(maxItems = 20, showHeader = true)

class ToggleActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        try {
            val todoId = parameters[TodoIdKey] ?: return
            TodoApplication.instance.repository.toggleTodoStatus(todoId)
            refreshAllWidgets(context)
        } catch (e: Exception) {
            android.util.Log.e("TodoWidget", "ToggleActionCallback onAction 失败: ${e.message}", e)
        }
    }
}

class ExpandActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        try {
            val todoId = parameters[TodoIdKey] ?: return
            updateAppWidgetState(context, PreferencesGlanceStateDefinition, glanceId) { prefs ->
                prefs.toMutablePreferences().apply {
                    val currentSet = this[EXPANDED_TODOS_KEY]?.toMutableSet() ?: mutableSetOf()
                    if (currentSet.contains(todoId)) {
                        currentSet.remove(todoId)
                    } else {
                        currentSet.add(todoId)
                    }
                    this[EXPANDED_TODOS_KEY] = currentSet
                }
            }
            try { TodoNormalWidget().update(context, glanceId) } catch (_: Exception) {}
            try { TodoCompactWidget().update(context, glanceId) } catch (_: Exception) {}
        } catch (e: Exception) {
            android.util.Log.e("TodoWidget", "ExpandActionCallback onAction 失败: ${e.message}", e)
        }
    }
}

class SyncActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        try {
            TodoApplication.instance.repository.syncWithCloud()
            refreshAllWidgets(context)
        } catch (e: Exception) {
            android.util.Log.e("TodoWidget", "SyncActionCallback onAction 失败: ${e.message}", e)
        }
    }
}

/** 递增所有小组件的版本号并触发刷新，供 ToggleActionCallback 和 TodoRepository 共用 */
suspend fun refreshAllWidgets(context: Context) {
    try {
        val manager = GlanceAppWidgetManager(context)

        for (id in manager.getGlanceIds(TodoCompactWidget::class.java)) {
            try {
                updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
                    prefs.toMutablePreferences().apply {
                        this[VERSION_KEY] = (prefs[VERSION_KEY] ?: 0) + 1
                    }
                }
                TodoCompactWidget().update(context, id)
            } catch (e: Exception) {
                android.util.Log.e("TodoWidget", "刷新 CompactWidget 失败: ${e.message}", e)
            }
        }

        for (id in manager.getGlanceIds(TodoNormalWidget::class.java)) {
            try {
                updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
                    prefs.toMutablePreferences().apply {
                        this[VERSION_KEY] = (prefs[VERSION_KEY] ?: 0) + 1
                    }
                }
                TodoNormalWidget().update(context, id)
            } catch (e: Exception) {
                android.util.Log.e("TodoWidget", "刷新 NormalWidget 失败: ${e.message}", e)
            }
        }
    } catch (e: Exception) {
        android.util.Log.e("TodoWidget", "refreshAllWidgets 失败: ${e.message}", e)
    }
}

