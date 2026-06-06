package com.todo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.intPreferencesKey
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
import java.time.LocalDate
import java.time.temporal.WeekFields
import java.util.Locale

// 全局唯一的 Key 常量，保证 actionRunCallback 绑定时和 ToggleActionCallback 取值时用同一个实例
val TodoIdKey = ActionParameters.Key<String>("todoId")

// Glance 状态版本号 key，每次数据变更递增，用于触发 Compose recomposition
private val VERSION_KEY = intPreferencesKey("widget_data_version")

abstract class BaseTodoWidget(private val maxItems: Int, private val showHeader: Boolean) : GlanceAppWidget() {

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
            val currentData = repository.getCurrentData()

            val todayStr = LocalDate.now().toString()
            val thisWeekStr = run {
                val date = LocalDate.now()
                val week = date.get(WeekFields.of(Locale.getDefault()).weekOfYear())
                "${date.year}-W${week.toString().padStart(2, '0')}"
            }
            val thisMonthStr = "${LocalDate.now().year}-${LocalDate.now().monthValue.toString().padStart(2, '0')}"

            val todayFocus = currentData.todos.filter { t ->
                val dateStr = t.date
                val isOverdue = dateStr != null && dateStr < todayStr && !t.completed && !dateStr.contains("-W") && dateStr.length != 7
                dateStr == todayStr || isOverdue || dateStr == null || dateStr == thisWeekStr || dateStr == thisMonthStr
            }.sortedWith(Comparator { a, b ->
                if (a.completed != b.completed) return@Comparator if (a.completed) 1 else -1
                val scoreA = a.importance + a.urgency
                val scoreB = b.importance + b.urgency
                if (scoreA != scoreB) return@Comparator scoreB - scoreA
                b.created_at.compareTo(a.created_at)
            }).take(maxItems)

            val widgetBackground = ColorProvider(Color(0xB3121212))
            val surfaceColor = ColorProvider(Color(0x26FFFFFF))
            val textColor = ColorProvider(Color.White)
            val textVariantColor = ColorProvider(Color(0xFFAAAAAA))

            val dateObj = LocalDate.now()
            val formatter = java.time.format.DateTimeFormatter.ofPattern("M月d日 EEEE", Locale.CHINESE)
            val dateString = dateObj.format(formatter)

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
                    Text(
                        text = "今天聚焦",
                        style = TextStyle(color = textColor, fontSize = 15.sp, fontWeight = FontWeight.Bold),
                        modifier = GlanceModifier.padding(bottom = 12.dp)
                    )
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
                            itemId = { todo -> todo.id.hashCode().toLong() }
                        ) { todo ->
                            TodoItemWidget(todo, surfaceColor, textColor, textVariantColor)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TodoItemWidget(todo: Todo, surfaceColor: ColorProvider, textColor: ColorProvider, textVariantColor: ColorProvider) {
    Column(modifier = GlanceModifier.fillMaxWidth()) {
        val severityColor = ColorProvider(when (todo.importance + todo.urgency) {
            6 -> Color(0xFFF5222D)
            5 -> Color(0xFFFA8C16)
            4 -> Color(0xFFFADB14)
            3 -> Color(0xFF52C41A)
            else -> Color.Gray
        })

        Row(
            modifier = GlanceModifier
                .fillMaxWidth()
                .background(surfaceColor)
                .cornerRadius(12.dp)
                .clickable(actionStartActivity<MainActivity>()),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = GlanceModifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .padding(vertical = 6.dp)
                    .background(severityColor)
                    .cornerRadius(4.dp)
            ) {}

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
        Spacer(modifier = GlanceModifier.height(8.dp))
    }
}

class TodoCompactWidget : BaseTodoWidget(maxItems = 3, showHeader = false)
class TodoNormalWidget : BaseTodoWidget(maxItems = 20, showHeader = true)

class ToggleActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val todoId = parameters[TodoIdKey] ?: return
        TodoApplication.instance.repository.toggleTodoStatus(todoId)
        refreshAllWidgets(context)
    }
}

/** 递增所有小组件的版本号并触发刷新，供 ToggleActionCallback 和 TodoRepository 共用 */
suspend fun refreshAllWidgets(context: Context) {
    val manager = GlanceAppWidgetManager(context)

    for (id in manager.getGlanceIds(TodoCompactWidget::class.java)) {
        updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
            prefs.toMutablePreferences().apply {
                this[VERSION_KEY] = (prefs[VERSION_KEY] ?: 0) + 1
            }
        }
        TodoCompactWidget().update(context, id)
    }

    for (id in manager.getGlanceIds(TodoNormalWidget::class.java)) {
        updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
            prefs.toMutablePreferences().apply {
                this[VERSION_KEY] = (prefs[VERSION_KEY] ?: 0) + 1
            }
        }
        TodoNormalWidget().update(context, id)
    }
}

