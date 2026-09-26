package com.todo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
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
import androidx.glance.appwidget.AndroidRemoteViews
import androidx.glance.appwidget.SizeMode
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
import com.todo.app.WidgetTimerActivity
import com.todo.app.R
import com.todo.app.data.model.Learning
import android.os.SystemClock
import android.widget.RemoteViews
import android.widget.Toast
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.todo.app.data.model.Todo
import com.todo.app.data.model.DateStrings
import com.todo.app.data.model.classifyForTodayFocus
import com.todo.app.data.model.TodoComparator
import com.todo.app.data.model.isOverdue
import com.todo.app.data.model.TaskType
import java.time.LocalDate
import java.util.Locale

// ====== Widget Theme (extracted colors) ======

object WidgetTheme {
    val Background = Color(0xB3121212)
    val Surface = Color(0x26FFFFFF)
    val TextPrimary = Color.White
    val TextVariant = Color(0xFFAAAAAA)
    val StatusSyncing = Color(0xFF1890FF)
    val StatusError = Color(0xFFFA8C16)
    val StatusSuccess = Color(0xFF52C41A)
    val SeparatorLine = Color(0x33FFFFFF)
    val OpenButtonBg = Color(0x33FFFFFF)
    val SubtaskDone = Color(0xFF666666)
}

// ====== Glance key constants ======

val TodoIdKey = ActionParameters.Key<String>("todoId")
val TimeEntryIdKey = ActionParameters.Key<String>("timeEntryId")

/** Widget 渲染模型：区分真实 Todo 和 UI 分隔线，避免污染领域模型 */
sealed class WidgetItem {
    data class TodoItem(val todo: Todo) : WidgetItem()
    data class Separator(val id: String) : WidgetItem()
}

// Glance 状态版本号 key，每次数据变更递增，用于触发 Compose recomposition
private val VERSION_KEY = intPreferencesKey("widget_data_version")
val EXPANDED_TODOS_KEY = stringSetPreferencesKey("expanded_todos")

// ====== Base widget ======

abstract class BaseTodoWidget(private val maxItems: Int, private val showHeader: Boolean) : GlanceAppWidget() {
    companion object {
        private val DATE_FORMATTER = java.time.format.DateTimeFormatter.ofPattern("M月d日 EEEE", Locale.CHINESE)
    }

    override val stateDefinition = PreferencesGlanceStateDefinition
    override val sizeMode = SizeMode.Exact

    @android.annotation.SuppressLint("StateFlowValueCalledInComposition")
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repository = TodoApplication.instance.repository
        try {
            repository.ensureDataLoaded()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            android.util.Log.e("TodoWidget", "Widget ensureDataLoaded 失败: ${e.message}", e)
        }

        provideContent {
            val prefs = currentState<Preferences>()
            @Suppress("UNUSED_VARIABLE")
            val version = prefs[VERSION_KEY] ?: 0

            val currentData = repository.getCurrentData()
            val loadFailure = repository.loadError.value
            val timerState = widgetTimerState(currentData, repository.timeTrackingEnabled.value)
            val size = LocalSize.current
            val actionSize = if (size.width < 180.dp) 30.dp else 48.dp
            val fullHeader = showHeader && size.width >= 260.dp && size.height >= 300.dp
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

            val widgetBackground = ColorProvider(WidgetTheme.Background)
            val surfaceColor = ColorProvider(WidgetTheme.Surface)
            val textColor = ColorProvider(WidgetTheme.TextPrimary)
            val textVariantColor = ColorProvider(WidgetTheme.TextVariant)

            val dateObj = LocalDate.now()
            val dateString = dateObj.format(DATE_FORMATTER)

            val syncStatus = repository.syncStatus.value
            val statusColor = ColorProvider(when (syncStatus) {
                1 -> WidgetTheme.StatusSyncing
                2 -> WidgetTheme.StatusError
                else -> WidgetTheme.StatusSuccess
            })

            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(widgetBackground)
                    .cornerRadius(20.dp)
                    .padding(if (size.width < 200.dp || size.height < 200.dp) 8.dp else 16.dp)
            ) {
                if (loadFailure != null) {
                    Text("数据加载失败", style = TextStyle(color = textColor, fontSize = 15.sp))
                    Text("请重试或打开应用，在设置中恢复备份。", style = TextStyle(color = textVariantColor))
                    Text("重试", modifier = GlanceModifier.padding(12.dp)
                        .clickable(actionRunCallback<RetryLoadActionCallback>()), style = TextStyle(color = textColor))
                    Text("打开应用", modifier = GlanceModifier.padding(12.dp)
                        .clickable(actionStartActivity<MainActivity>()), style = TextStyle(color = textColor))
                    return@Column
                }
                if (fullHeader) {
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
                            TimerStartButton(timerState, textColor)
                            WidgetRefreshButton(textColor)
                            Text(
                                text = "打开",
                                style = TextStyle(color = textColor, fontSize = 12.sp, fontWeight = FontWeight.Bold),
                                modifier = GlanceModifier
                                    .padding(horizontal = 8.dp, vertical = 4.dp)
                                    .background(ColorProvider(WidgetTheme.OpenButtonBg))
                                    .cornerRadius(8.dp)
                                    .clickable(actionStartActivity<MainActivity>())
                            )
                            Spacer(modifier = GlanceModifier.width(12.dp))
                            Box(modifier = GlanceModifier.size(8.dp).background(statusColor).cornerRadius(4.dp)) {}
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
                        modifier = GlanceModifier.fillMaxWidth().padding(bottom = if (size.height < 200.dp) 4.dp else 12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (size.width >= 260.dp) Text(
                            text = "今天聚焦",
                            style = TextStyle(color = textColor, fontSize = 15.sp, fontWeight = FontWeight.Bold),
                            modifier = GlanceModifier.defaultWeight()
                        )
                        TimerStartButton(timerState, textColor, actionSize)
                        WidgetRefreshButton(textColor, actionSize)
                        if (size.width < 180.dp) {
                            Box(GlanceModifier.size(actionSize).clickable(actionStartActivity<MainActivity>()),
                                contentAlignment = Alignment.Center) {
                                Image(ImageProvider(android.R.drawable.ic_menu_view), contentDescription = "打开应用",
                                    modifier = GlanceModifier.size(24.dp), colorFilter = ColorFilter.tint(textColor))
                            }
                        } else {
                            Text(
                                text = "打开",
                                style = TextStyle(color = textColor, fontSize = 12.sp, fontWeight = FontWeight.Bold),
                                modifier = GlanceModifier
                                    .padding(horizontal = 8.dp, vertical = 4.dp)
                                    .background(ColorProvider(WidgetTheme.OpenButtonBg))
                                    .cornerRadius(8.dp)
                                    .clickable(actionStartActivity<MainActivity>())
                            )
                        }
                    }
                }

                WidgetTimerBar(timerState, textColor, surfaceColor)
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
                                is WidgetItem.TodoItem -> {
                                    item.todo.id.hashCode().toLong()
                                }
                            }}
                        ) { item ->
                            when (item) {
                                is WidgetItem.Separator -> {
                                    Column(modifier = GlanceModifier.fillMaxWidth()) {
                                        Box(
                                            modifier = GlanceModifier
                                                .fillMaxWidth()
                                                .height(1.dp)
                                                .background(ColorProvider(WidgetTheme.SeparatorLine))
                                        ) {}
                                        Spacer(modifier = GlanceModifier.height(8.dp))
                                    }
                                }
                                is WidgetItem.TodoItem -> {
                                    TodoItemWidget(item.todo, surfaceColor, textColor, textVariantColor,
                                        expandedTodos.contains(item.todo.id), todayStr, isWidgetTimingTodo(timerState, item.todo.id))
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
fun TodoItemWidget(todo: Todo, surfaceColor: ColorProvider, textColor: ColorProvider, textVariantColor: ColorProvider, isExpanded: Boolean, todayStr: String, isTiming: Boolean = false) {
    val isCompletedToShow = todo.completed || (
        (todo.taskType == TaskType.WEEKLY_CHECKIN || todo.taskType == TaskType.MONTHLY_CHECKIN) &&
        todo.completedDates.any { it.startsWith(todayStr) }
    )

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

            Box(
                modifier = GlanceModifier
                    .size(44.dp)
                    .clickable(
                        actionRunCallback<ToggleActionCallback>(actionParametersOf(TodoIdKey to todo.id))
                    ),
                contentAlignment = Alignment.Center
            ) {
                Image(
                    provider = ImageProvider(
                        if (isCompletedToShow) android.R.drawable.checkbox_on_background
                        else android.R.drawable.checkbox_off_background
                    ),
                    contentDescription = "Toggle",
                    modifier = GlanceModifier.size(24.dp)
                )
            }
            Text(
                text = if (isTiming) "⏱ ${todo.content}" else todo.content,
                style = TextStyle(
                    color = if (isCompletedToShow) textVariantColor else textColor,
                    textDecoration = if (isCompletedToShow) androidx.glance.text.TextDecoration.LineThrough else androidx.glance.text.TextDecoration.None,
                    fontSize = 15.sp
                ),
                maxLines = 1,
                modifier = GlanceModifier.defaultWeight().padding(end = 12.dp, top = 12.dp, bottom = 12.dp)
            )
        }
        if (isExpanded && todo.subtasks.isNotEmpty()) {
            Column(modifier = GlanceModifier.padding(start = 38.dp, top = 4.dp, bottom = 4.dp, end = 12.dp)) {
                todo.subtasks.forEach { sub ->
                    val color = if (sub.completed) ColorProvider(WidgetTheme.SubtaskDone) else textVariantColor
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

// ====== Widget concrete classes ======

@Composable
private fun WidgetRefreshButton(color: ColorProvider, buttonSize: Dp = 48.dp) {
    Box(GlanceModifier.size(buttonSize).clickable(actionRunCallback<SyncActionCallback>()),
        contentAlignment = Alignment.Center) {
        Image(ImageProvider(android.R.drawable.ic_popup_sync), contentDescription = "同步并刷新",
            modifier = GlanceModifier.size(24.dp), colorFilter = ColorFilter.tint(color))
    }
}

@Composable
private fun TimerStartButton(state: WidgetTimerState, color: ColorProvider, buttonSize: Dp = 48.dp) {
    if (state == WidgetTimerState.Idle) {
        Box(GlanceModifier.size(buttonSize).clickable(actionStartActivity<WidgetTimerActivity>()),
            contentAlignment = Alignment.Center) {
            Image(ImageProvider(android.R.drawable.ic_media_play), contentDescription = "开始任务计时",
                modifier = GlanceModifier.size(24.dp), colorFilter = ColorFilter.tint(color))
        }
    }
}

@Composable
private fun WidgetTimerBar(state: WidgetTimerState, color: ColorProvider, surface: ColorProvider) {
    when (state) {
        is WidgetTimerState.Running -> {
            val entry = state.entry
            val context = LocalContext.current
            val start = Learning.instant(entry.started_at)!!.toEpochMilli()
            val clock = RemoteViews(context.packageName, R.layout.widget_timer_chronometer).apply {
                setChronometer(R.id.widget_chronometer,
                    SystemClock.elapsedRealtime() - (System.currentTimeMillis() - start).coerceAtLeast(0), null, true)
                setContentDescription(R.id.widget_chronometer, "当前任务已计时时长")
            }
            Column(GlanceModifier.fillMaxWidth().background(surface).cornerRadius(12.dp).padding(8.dp)) {
                Text("⏱ ${widgetTimerTitle(entry)}", maxLines = 1,
                    style = TextStyle(color = color, fontSize = 14.sp),
                    modifier = GlanceModifier.fillMaxWidth().padding(vertical = 6.dp)
                        .clickable(actionStartActivity<MainActivity>()))
                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    AndroidRemoteViews(clock, modifier = GlanceModifier.defaultWeight())
                    Box(GlanceModifier.width(56.dp).height(48.dp)
                        .clickable(actionRunCallback<StopTimerActionCallback>(actionParametersOf(TimeEntryIdKey to entry.id))),
                        contentAlignment = Alignment.Center) {
                        Text("结束", style = TextStyle(color = color, fontWeight = FontWeight.Bold))
                    }
                }
            }
            Spacer(GlanceModifier.height(8.dp))
        }
        is WidgetTimerState.Attention -> {
            Text(state.message, style = TextStyle(color = color, fontSize = 14.sp),
                modifier = GlanceModifier.fillMaxWidth().padding(vertical = 16.dp)
                    .clickable(actionStartActivity<MainActivity>()))
        }
        else -> Unit
    }
}

class TodoCompactWidget : BaseTodoWidget(maxItems = 3, showHeader = false)
class TodoNormalWidget : BaseTodoWidget(maxItems = 20, showHeader = true)

// ====== Action callbacks ======

class ToggleActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        try {
            val todoId = parameters[TodoIdKey] ?: return
            TodoApplication.instance.repository.toggleTodoStatus(todoId)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            android.util.Log.e("TodoWidget", "ToggleActionCallback onAction 失败: ${e.message}", e)
            widgetMessage(context, e.message ?: "操作失败，请重试")
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
            refreshAllWidgets(context)
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

private suspend fun widgetMessage(context: Context, message: String) = withContext(Dispatchers.Main) {
    Toast.makeText(context, message, Toast.LENGTH_LONG).show()
}

class StopTimerActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[TimeEntryIdKey] ?: return
        val result = TodoApplication.instance.repository.stopLearning(id)
        result.fold(onSuccess = { discarded ->
            if (discarded > 0) widgetMessage(context, Learning.SHORT_TIME_ENTRY_MESSAGE)
        }, onFailure = { widgetMessage(context, it.message ?: "结束计时失败，请重试") })
        // 始终根据最新记录重新渲染，旧按钮不意味着当前已无计时。
        refreshAllWidgets(context)
    }
}

class RetryLoadActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        try {
            TodoApplication.instance.repository.ensureDataLoaded()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            widgetMessage(context, "加载失败，请在设置中恢复备份")
        }
        refreshAllWidgets(context)
    }
}

// ====== Generic widget refresh ======

/** 递增所有小组件的版本号并触发刷新 */
suspend fun refreshAllWidgets(context: Context) {
    try {
        val manager = GlanceAppWidgetManager(context)
        refreshWidgetType(context, manager, TodoCompactWidget::class.java, "CompactWidget")
        refreshWidgetType(context, manager, TodoNormalWidget::class.java, "NormalWidget")
    } catch (e: Exception) {
        android.util.Log.e("TodoWidget", "refreshAllWidgets 失败: ${e.message}", e)
    }
}

private suspend fun refreshWidgetType(
    context: Context,
    manager: GlanceAppWidgetManager,
    widgetClass: Class<out GlanceAppWidget>,
    label: String
) {
    for (id in manager.getGlanceIds(widgetClass)) {
        try {
            updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
                prefs.toMutablePreferences().apply {
                    this[VERSION_KEY] = (prefs[VERSION_KEY] ?: 0) + 1
                }
            }
            widgetClass.getDeclaredConstructor().newInstance().update(context, id)
        } catch (e: Exception) {
            android.util.Log.e("TodoWidget", "刷新 ${label} 失败: ${e.message}", e)
        }
    }
}
