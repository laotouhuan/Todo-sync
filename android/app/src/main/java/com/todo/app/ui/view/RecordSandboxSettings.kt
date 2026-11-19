package com.todo.app.ui.view

import com.todo.app.ui.theme.SupportingText

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.LocalPinnableContainer
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Learning
import com.todo.app.data.model.LearningViewData
import com.todo.app.data.model.TodoData
import com.todo.app.data.model.WeeklyPlanning
import com.todo.app.data.model.SyncPhase
import com.todo.app.data.repository.RecordSandbox
import com.todo.app.data.repository.RecordSandboxTarget
import com.todo.app.data.repository.RecordSandboxView
import com.todo.app.data.repository.PlanningCloudConnection
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

private val sandboxExportJson = Json { ignoreUnknownKeys = true }

internal class PersonalPlanningState(
    val target: Pair<String, PlanningCloudConnection?>,
    val data: JsonObject?,
    val busy: Boolean,
    val loadError: Boolean,
    val syncFailed: Boolean,
    val saveError: String,
    val actionDate: String?,
    val change: (JsonObject, Boolean, () -> Unit) -> Unit,
    val retry: () -> Unit,
    val reload: () -> Unit,
    val focusStatus: String,
    val canEnableFocus: Boolean,
    val cloudBacked: Boolean,
    val enableFocus: () -> Unit,
    val pendingRating: Boolean,
    val saveRating: suspend (String, Int?, JsonElement, Boolean) -> RatingSaveResult
) {
    fun rating(date: String): JsonElement? = data?.let { ratingRecord(it, date) }
}

internal data class RatingSaveResult(val record: JsonElement? = null, val error: String = "", val pending: Boolean = false)

private fun ratingRecord(data: JsonObject, date: String): JsonElement =
    data.getValue("daily_ratings").jsonArray.firstOrNull { it.jsonObject["date"] == JsonPrimitive(date) } ?: JsonNull

internal fun JsonElement?.ratingScore(): Int? = (this as? JsonObject)?.takeUnless {
    it["deleted"]?.jsonPrimitive?.booleanOrNull == true
}?.get("score")?.jsonPrimitive?.intOrNull

@Composable
internal fun rememberPersonalPlanning(viewModel: com.todo.app.ui.viewmodel.TodoViewModel): PersonalPlanningState {
    val config = viewModel.configManager
    val repository = viewModel.personalPlanning
    val targets = remember(config) { config.planningTargets() }
    val settings by targets.collectAsState(initial = config.planningSettings())
    val snapshot by repository.state.collectAsState()
    // 页面只管理编辑草稿；同步会话由 ViewModel 持有，返回列表后仍可手动同步。
    return key(settings) {
        val scope = rememberCoroutineScope()
        val current = snapshot.takeIf { it.settings == settings }
        var writing by remember { mutableStateOf(false) }
        var status by remember { mutableStateOf("") }
        var actionDate by remember { mutableStateOf<String?>(null) }
        var pendingRating by remember { mutableStateOf(false) }
        var afterSave by remember { mutableStateOf<(() -> Unit)?>(null) }
        LaunchedEffect(settings) {
            while (config.planningSettings() == settings) {
                if (!writing) repository.sync()
                delay(15000)
            }
        }
        fun write(operation: suspend () -> Pair<RecordSandboxView, Boolean>) {
            if (writing || config.planningSettings() != settings) return
            writing = true
            status = ""
            scope.launch {
                try {
                    val (_, saved) = operation()
                    if (config.planningSettings() != settings) return@launch
                    if (saved) {
                        afterSave?.invoke()
                        pendingRating = false
                    }
                    afterSave = null
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    status = "保存未确认（${error.message}）"
                } finally {
                    writing = false
                }
            }
        }
        suspend fun rate(date: String, score: Int?, baseline: JsonElement, retry: Boolean): RatingSaveResult {
            val view = current?.data
            if (writing || config.planningSettings() != settings || view == null) return RatingSaveResult(error = "评分暂不可用，请重试")
            val action = buildJsonObject {
                put("kind", "rate"); put("date", date); put("score", score?.let(::JsonPrimitive) ?: JsonNull)
                put("expectedRating", baseline)
            }
            writing = true
            status = ""
            actionDate = date
            return try {
                val (result, saved) = if (retry) repository.retry(settings) else {
                    try {
                        repository.change(settings, action, view.revision)
                    } catch (error: IllegalStateException) {
                        if (error.message != "RECORD_WRITE_STALE") throw error
                        repository.change(settings, action, view.revision)
                    }
                }
                check(saved) { "评分未保存，请重试" }
                pendingRating = false
                RatingSaveResult(ratingRecord(requireNotNull(result.preview.view), date))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                status = error.message ?: "评分未保存，请重试"
                try {
                    pendingRating = repository.hasPendingRating(settings, date)
                    if ("已更新" in status) repository.readLocal(settings)
                } catch (refreshError: CancellationException) {
                    throw refreshError
                } catch (_: Exception) {
                    // 保留原写入错误，由用户重试读取。
                }
                RatingSaveResult(error = status, pending = pendingRating)
            } finally {
                writing = false
            }
        }
        PersonalPlanningState(settings, current?.data?.preview?.view, writing || current?.loading == true,
            current?.loadError != null, current?.phase == SyncPhase.FAILED, status, actionDate,
            change = { action, activateFocus, onSaved ->
                if (!writing && current?.data != null) {
                    actionDate = action["date"]?.jsonPrimitive?.content
                    afterSave = onSaved
                    write {
                        val baseline = if (activateFocus) repository.enableFocus(settings).first else current.data
                        repository.change(settings, action, baseline.revision)
                    }
                }
            },
            retry = { write { repository.retry(settings) } },
            reload = { viewModel.refreshPlanning() },
            focusStatus = current?.data?.focusStatus ?: "unknown",
            canEnableFocus = current?.data?.canEnableFocus == true,
            cloudBacked = current?.data?.cloudBacked == true,
            enableFocus = {
                actionDate = null
                write { repository.enableFocus(settings) }
            },
            pendingRating = pendingRating,
            saveRating = ::rate)
    }
}

@Composable
internal fun PersonalPlanningStats(
    state: PersonalPlanningState, date: LocalDate, period: String, navigation: InsightsNavigation,
    detailOpen: Boolean, setDetailOpen: (Boolean) -> Unit, viewModel: com.todo.app.ui.viewmodel.TodoViewModel,
    selectDay: (LocalDate) -> Unit
) {
    var confirmation by remember { mutableStateOf<(() -> Unit)?>(null) }
    var exporting by remember(date, period) { mutableStateOf(false) }
    val data = state.data
    val week = WeeklyPlanning.monday(date.toString())
    val plan = remember(data, week) { data?.let { WeeklyPlanning.state(it, week) } }
    val learning = currentLearningData(viewModel)
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text(if (period == "week") "本周计划与回顾" else "月评分", style = MaterialTheme.typography.titleMedium)
            if (data != null) {
                if (state.syncFailed) SupportingText("计划与评分同步未完成")
                if (period == "week") {
                    Text("本周重点", style = MaterialTheme.typography.labelLarge)
                    CollapsibleInsightText(plan?.current?.get("focus")?.jsonPrimitive?.content.orEmpty().ifBlank { "未填写本周重点" }, 3)
                    if (plan?.status == "conflict") Text("周计划存在分歧")
                    Text("每日评分", style = MaterialTheme.typography.labelLarge)
                    RecordRatingCalendar(data, date, state.busy, {}, period, summary = false, interactive = false)
                    OutlinedButton(onClick = { setDetailOpen(true) }) { Text("查看本周详情") }
                } else RecordRatingCalendar(data, date, state.busy, { selectDay(LocalDate.parse(it)) }, period)
            } else PlanningReadStatus(state)
        }
    }
    if (period == "week" && detailOpen) {
        fun close() = navigation.request { setDetailOpen(false) }
        Dialog(onDismissRequest = ::close) {
            Surface(shape = MaterialTheme.shapes.large) {
                Column(Modifier.padding(16.dp).heightIn(max = 620.dp).verticalScroll(rememberScrollState())) {
                    Text("本周详情", style = MaterialTheme.typography.titleMedium)
                    if (data == null) PlanningReadStatus(state)
                    else {
                        var edit by remember(week) { mutableStateOf(plan?.status != "current") }
                        if (!edit) {
                            Text("本周重点", style = MaterialTheme.typography.labelLarge)
                            Text(plan?.current?.get("focus")?.jsonPrimitive?.content.orEmpty().ifBlank { "未填写本周重点" })
                            plan?.current?.get("days")?.jsonArray?.forEachIndexed { index, value ->
                                Text(planDayLabel(LocalDate.parse(week).plusDays(index.toLong())), style = MaterialTheme.typography.labelLarge)
                                Text(value.jsonPrimitive.content.ifBlank { "当天未安排" })
                            }
                            OutlinedButton(onClick = { edit = true }) { Text("编辑周计划与历史") }
                        }
                        if (edit) key(state.target) {
                            RecordSandboxPlanning(data, date.toString(), week, state.busy,
                                { action -> state.change(action, false) {} }, { confirmation = it }, {}, showRating = false,
                                navigation = navigation, savePlan = state.change, saveError = state.saveError, retry = state.retry,
                                focusStatus = state.focusStatus, canEnableFocus = state.canEnableFocus,
                                cloudBacked = state.cloudBacked, reload = state.reload)
                        }
                        if (state.saveError.isNotEmpty() && state.actionDate == null) {
                            Text(state.saveError, color = MaterialTheme.colorScheme.error)
                            OutlinedButton(enabled = !state.busy, onClick = state.retry) { Text("重试上次保存") }
                        }
                        Text("每日回顾", style = MaterialTheme.typography.labelLarge)
                        for (index in 0..6) {
                            val day = LocalDate.parse(week).plusDays(index.toLong())
                            val record = learning.data.dailyReviews.find { it.date == day.toString() && !it.deleted }
                            val score = state.rating(day.toString()).ratingScore()
                            TextButton(onClick = { selectDay(day) }) {
                                Column(Modifier.fillMaxWidth()) {
                                    Text("${planDayLabel(day)} · ${score?.let { "$it / 5" } ?: "未评分"}")
                                    Text(record?.let(Learning::preview) ?: "尚未填写复盘", maxLines = 2, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                        val (average, covered, days) = WeeklyPlanning.ratingSummary(data, week, LocalDate.parse(week).plusDays(6).toString())
                        Text("周平均 ${average ?: "—"} · 已评分 $covered/$days 天")
                        TextButton(onClick = { exporting = true }) { Text("导出 Markdown") }
                    }
                    TextButton(onClick = ::close) { Text("关闭详情") }
                }
            }
        }
    }
    if (exporting) ReviewExportDialog(viewModel, learning.data, "week", date, state) { exporting = false }
    confirmation?.let { action ->
        AlertDialog(onDismissRequest = { confirmation = null }, text = { Text("删除此历史版本？") },
            confirmButton = { OutlinedButton(onClick = { confirmation = null; action() }) { Text("删除") } },
            dismissButton = { OutlinedButton(onClick = { confirmation = null }) { Text("取消") } })
    }
}

internal fun chineseWeekday(date: LocalDate): String = "周" + "一二三四五六日"[date.dayOfWeek.value - 1]

private fun planDayLabel(date: LocalDate): String = "${chineseWeekday(date)} · ${date.monthValue}月${date.dayOfMonth}日"

@Composable
private fun PlanningReadStatus(state: PersonalPlanningState) {
    Text(if (state.loadError) "无法读取本机计划与评分" else "正在读取计划与评分…")
    if (state.loadError) OutlinedButton(onClick = state.reload) { Text("重试读取") }
}

@Composable
internal fun DailyPlanReference(state: PersonalPlanningState, date: LocalDate, openWeek: (() -> Unit)? = null) {
    Text("今日计划", style = MaterialTheme.typography.labelLarge)
    val data = state.data
    if (data == null) {
        PlanningReadStatus(state)
        if (openWeek != null) OutlinedButton(onClick = openWeek) { Text("查看周计划") }
        return
    }
    val week = WeeklyPlanning.monday(date.toString())
    val plan = remember(data, week) { WeeklyPlanning.state(data, week) }
    CollapsibleInsightText(when (plan.status) {
        "current" -> plan.current?.getValue("days")?.jsonArray?.get(date.dayOfWeek.value - 1)
            ?.jsonPrimitive?.content.orEmpty().ifEmpty { "当天未安排" }
        "conflict" -> "周计划存在分歧，请到周视图处理"
        "restart" -> "周计划需重新制定"
        else -> "本周尚未制定计划"
    }, 2)
    if (state.syncFailed) SupportingText("计划与评分同步未完成")
    if (openWeek != null) OutlinedButton(onClick = openWeek) { Text("查看周计划") }
}

@Composable
internal fun PlanningFocusSetting(viewModel: com.todo.app.ui.viewmodel.TodoViewModel) {
    val state = rememberPersonalPlanning(viewModel)
    if (!state.cloudBacked) return
    var confirm by remember(state.target) { mutableStateOf(false) }
    OutlinedButton(enabled = state.canEnableFocus && !state.busy, onClick = { confirm = true }) { Text("启用本周重点") }
    when {
        state.focusStatus == "enabled" -> SupportingText("当前计划数据集已启用本周重点")
        state.focusStatus in listOf("unknown", "invalid") -> {
            SupportingText("本周重点启用状态待核对")
            TextButton(enabled = !state.busy, onClick = state.reload) { Text("重试读取") }
        }
        !state.canEnableFocus -> SupportingText("云端本周重点尚不可启用")
    }
    if (state.saveError.isNotEmpty() && state.actionDate == null) Text(state.saveError, color = MaterialTheme.colorScheme.error)
    if (confirm) ConfirmPlanningFocusUpgrade({ confirm = false }) {
        confirm = false
        state.enableFocus()
    }
}

@Composable
private fun ConfirmPlanningFocusUpgrade(cancel: () -> Unit, confirm: () -> Unit) {
    AlertDialog(onDismissRequest = cancel, title = { Text("升级云端周计划格式") },
        text = { Text("请确认仍在使用此计划数据集的设备均已升级到兼容版本。") },
        confirmButton = { TextButton(onClick = confirm) { Text("确认升级") } },
        dismissButton = { TextButton(onClick = cancel) { Text("取消") } })
}

@Composable
internal fun DailyRating(state: PersonalPlanningState, date: LocalDate) {
    val rating = state.rating(date.toString())
    val score = rating.ratingScore()
    val scope = rememberCoroutineScope()
    val error = state.saveError.takeIf { state.actionDate == date.toString() }.orEmpty()
    if (score != null) {
        val fill = ratingFill(score)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("当日评分", style = MaterialTheme.typography.labelLarge)
            Box(Modifier.widthIn(min = 36.dp).heightIn(min = 30.dp)
                .background(fill, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
                contentAlignment = Alignment.Center) {
                Text(score.toString(), Modifier.clearAndSetSemantics { contentDescription = "$score 分" },
                    color = ratingTextColor(fill), style = MaterialTheme.typography.titleSmall)
            }
        }
    } else {
        Text("当日评分", style = MaterialTheme.typography.labelLarge)
        if (rating == null) Text("评分暂不可用")
        else Row(Modifier.fillMaxWidth()) {
            for (value in 1..5) androidx.compose.material3.FilterChip(
                selected = false, enabled = !state.busy && !state.pendingRating,
                onClick = { scope.launch { state.saveRating(date.toString(), value, rating, false) } }, label = { Text(value.toString()) },
                modifier = Modifier.weight(1f).padding(horizontal = 2.dp).semantics { contentDescription = "$value 分" }
            )
        }
    }
    if (state.busy && state.actionDate == date.toString()) Text("正在保存评分…")
    if (error.isNotEmpty()) {
        Text(error, color = MaterialTheme.colorScheme.error)
        if (state.pendingRating) OutlinedButton(enabled = !state.busy, onClick = state.retry) { Text("重试保存评分") }
    }
}

@Composable
private fun ratingFill(score: Int, inRange: Boolean = true): Color {
    val colors = MaterialTheme.colorScheme
    val strength = 0.06f + 0.16f * score
    return lerp(colors.surfaceContainer, colors.primary, if (inRange) strength else strength * 0.5f)
}

private fun ratingTextColor(fill: Color): Color = if (fill.luminance() >= 0.179f) Color.Black else Color.White

internal class InsightsNavigation {
    val guards = mutableListOf<(() -> Unit) -> Unit>()

    fun request(action: () -> Unit) {
        val guarded = guards.asReversed().foldRight(action) { confirm, next -> { confirm(next) } }
        guarded()
    }
}

@Composable
internal fun RegisterInsightsGuard(navigation: InsightsNavigation?, active: Boolean, guard: (() -> Unit) -> Unit) {
    val latest by rememberUpdatedState(guard)
    val container = LocalPinnableContainer.current
    DisposableEffect(navigation, active, container) {
        val callback: (() -> Unit) -> Unit = { action -> latest(action) }
        val pin = if (active && navigation != null) container?.pin() else null
        if (active) navigation?.guards?.add(callback)
        onDispose {
            navigation?.guards?.remove(callback)
            pin?.release()
        }
    }
}

@Composable
internal fun RecordSandboxSettings() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var session by remember { mutableStateOf<RecordSandbox?>(null) }
    var state by remember { mutableStateOf<RecordSandboxView?>(null) }
    var status by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var slot by remember { mutableIntStateOf(1) }
    var confirmation by remember { mutableStateOf<(() -> Unit)?>(null) }

    fun publish(next: RecordSandboxView) {
        state = next
        status = if (next.preview.journal.fault != null) "同步已暂停，请核对故障证据。"
        else "待上传 ${next.preview.journal.pending.size} 条" + if (next.uploadFailures > 0) "，稍后重试" else ""
    }

    fun run(action: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                action()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                status = "操作未确认（${error.message ?: "请重试"}）"
            } finally {
                busy = false
            }
        }
    }

    fun change(action: JsonObject, onSaved: () -> Unit = {}) {
        val selected = session ?: return
        val revision = state?.revision
        run { publish(selected.change(action, revision)); onSaved() }
    }

    LaunchedEffect(session) {
        val selected = session ?: return@LaunchedEffect
        while (true) {
            delay(5000)
            if (busy) continue
            try {
                val next = selected.sync()
                if (session === selected && !busy) {
                    val previous = state
                    if (previous != next) publish(next)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: com.todo.app.data.repository.RecordTransportIntegrityException) {
                status = "同步已暂停（${error.message}）"
                break
            } catch (error: Exception) {
                status = "同步未完成（${error.message}）"
            }
        }
    }
    Column {
        Text("独立记录试用（本机隔离）")
        if (session == null) {
            Row {
                for (number in 1..2) OutlinedButton(enabled = !busy && slot != number, onClick = { slot = number }) {
                    Text(if (number == 1) "清单一" else "清单二")
                }
            }
            OutlinedButton(enabled = !busy, onClick = { run {
                val selected = withContext(Dispatchers.IO) {
                    val preferences = context.getSharedPreferences("record-sandbox", android.content.Context.MODE_PRIVATE)
                    val key = "target-$slot"
                    val target = preferences.getString(key, null)?.let { Json.decodeFromString<RecordSandboxTarget>(it) }
                        ?: RecordSandboxTarget(UUID.randomUUID().toString(), UUID.randomUUID().toString(), Instant.now().toString())
                            .also { check(preferences.edit().putString(key, Json.encodeToString(RecordSandboxTarget.serializer(), it)).commit()) }
                    RecordSandbox(context.filesDir, target)
                }
                publish(selected.open())
                session = selected
            } }) { Text("打开试用清单") }
        } else {
            OutlinedButton(enabled = !busy, onClick = { run {
                session?.close()
                session = null
                state = null
                status = "试用清单已关闭。"
            } }) { Text("关闭试用清单") }
        }
        if (status.isNotEmpty()) SupportingText(status)
        val view = state?.preview?.view
        if (view != null) {
            OutlinedTextField(name, { name = it }, enabled = !busy, label = { Text("任务名称") })
            OutlinedButton(enabled = !busy && name.isNotBlank(), onClick = {
                change(buildJsonObject { put("kind", "add"); put("content", name) }) { name = "" }
            }) { Text("新增任务") }
            for (todo in view.getValue("todos").jsonArray.map { it.jsonObject }.filter {
                it["deleted"]?.jsonPrimitive?.booleanOrNull != true && it["task_type"]?.jsonPrimitive?.content == "normal"
            }) {
                val id = todo.getValue("id").jsonPrimitive.content
                val content = todo.getValue("content").jsonPrimitive.content
                key(id) {
                    var rename by remember(content) { mutableStateOf(content) }
                    OutlinedTextField(rename, { rename = it }, enabled = !busy, label = { Text("任务名称") })
                    Row {
                        OutlinedButton(enabled = !busy && rename.isNotBlank(), onClick = { change(buildJsonObject {
                            put("kind", "rename"); put("todoId", id); put("content", rename)
                        }) }) { Text("改名") }
                        OutlinedButton(enabled = !busy, onClick = { change(buildJsonObject {
                            put("kind", "remove"); put("todoId", id)
                        }) }) { Text("删除") }
                    }
                }
            }
            OutlinedTextField(date, { date = it }, enabled = !busy, label = { Text("日期 YYYY-MM-DD") }, singleLine = true)
            val week = remember(date) { runCatching { WeeklyPlanning.monday(date) }.getOrNull() }
            if (week != null) {
                RecordSandboxPlanning(view, date, week, busy, { change(it) }, { confirmation = it }, { date = it },
                    savePlan = { action, _, onSaved -> change(action, onSaved) })
                RecordSandboxExport(view, LocalDate.parse(date), busy, { status = it })
            }
            OutlinedButton(enabled = !busy, onClick = { run { session?.retry()?.let(::publish) } }) { Text("重试上次保存") }
        }
    }
    confirmation?.let { action ->
        AlertDialog(onDismissRequest = { confirmation = null }, text = { Text("删除此历史版本？") },
            confirmButton = { OutlinedButton(onClick = { confirmation = null; action() }) { Text("删除") } },
            dismissButton = { OutlinedButton(onClick = { confirmation = null }) { Text("取消") } })
    }
}

@Composable
private fun RecordSandboxPlanning(
    data: JsonObject, date: String, week: String, busy: Boolean, change: (JsonObject) -> Unit, confirm: (() -> Unit) -> Unit,
    selectDate: (String) -> Unit, showPlan: Boolean = true, calendarPeriod: String? = null, showRating: Boolean = true,
    navigation: InsightsNavigation? = null, savePlan: ((JsonObject, Boolean, () -> Unit) -> Unit)? = null,
    saveError: String = "", retry: () -> Unit = {}, focusStatus: String = "legacy",
    canEnableFocus: Boolean = false, cloudBacked: Boolean = false, reload: () -> Unit = {}
) {
    val plan = remember(data, week) { WeeklyPlanning.state(data, week) }
    fun operation(kind: String, versionId: String, fields: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("kind", kind)
        put("week", week)
        put("versionId", versionId)
        put("tips", JsonArray(plan.tips.map(::JsonPrimitive)))
        fields()
    }
    fun act(kind: String, versionId: String) = change(operation(kind, versionId))
    if (showPlan) {
        var draftDays by rememberSaveable(week) { mutableStateOf<ArrayList<String>?>(null) }
        var draftFocus by rememberSaveable(week) { mutableStateOf<String?>(null) }
        var draftTips by rememberSaveable(week) { mutableStateOf<ArrayList<String>?>(null) }
        var reason by rememberSaveable(week) { mutableStateOf("") }
        fun clearDraft() {
            draftDays = null
            draftFocus = null
            draftTips = null
            reason = ""
        }
        Text("$week 当周计划 · " + when (plan.status) {
            "current" -> "已有计划"
            "conflict" -> "存在分歧"
            "restart" -> "需重新制定"
            else -> "未制定"
        })
        if (plan.status == "conflict") {
            for (candidate in plan.candidates.filter { it["deleted"]?.jsonPrimitive?.booleanOrNull != true }) {
                val id = candidate.getValue("id").jsonPrimitive.content
                Text(candidate.getValue("created_at").jsonPrimitive.content)
                Text(candidate["focus"]?.jsonPrimitive?.content.orEmpty().ifBlank { "未填写本周重点" })
                candidate.getValue("days").jsonArray.forEachIndexed { index, day -> Text("周${"一二三四五六日"[index]} ${day.jsonPrimitive.content}") }
                OutlinedButton(enabled = !busy, onClick = { act("resolve", id) }) { Text("采用此版") }
            }
        } else {
            val baseline = remember(week, plan.tips) {
                List(7) { plan.current?.getValue("days")?.jsonArray?.get(it)?.jsonPrimitive?.content.orEmpty() }
            }
            val initialFocus = plan.current?.get("focus")?.jsonPrimitive?.content.orEmpty()
            val days = draftDays ?: baseline
            val focus = draftFocus ?: initialFocus
            fun editDraft(newDays: List<String> = days, newFocus: String = focus, newReason: String = reason) {
                if (newDays == baseline && newFocus == initialFocus && newReason.isEmpty()) clearDraft()
                else {
                    if (draftTips == null) draftTips = ArrayList(plan.tips)
                    draftDays = ArrayList(newDays)
                    draftFocus = newFocus
                    reason = newReason
                }
            }
            var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
            var upgradeConfirmation by remember { mutableStateOf<(() -> Unit)?>(null) }
            val needsRead = focusStatus in listOf("unknown", "invalid")
            val upgrade = cloudBacked && focusStatus == "legacy" && focus.isNotBlank()
            val unsupported = upgrade && !canEnableFocus
            val canSave = !needsRead && !unsupported &&
                (plan.status == "current" || focus.isNotBlank() || days.any { it.isNotBlank() })
            fun save(after: (() -> Unit)? = null) {
                val action = operation("save", UUID.randomUUID().toString()) {
                    draftTips?.let { put("tips", JsonArray(it.map(::JsonPrimitive))) }
                    put("days", JsonArray(days.map(::JsonPrimitive)))
                    if (focusStatus == "enabled" || upgrade) put("focus", focus)
                    put("reason", reason)
                }
                val submit = {
                    if (savePlan == null) change(action) else savePlan(action, upgrade) {
                        clearDraft()
                        pending = null
                        after?.invoke()
                    }
                }
                if (upgrade) upgradeConfirmation = submit else submit()
            }
            RegisterInsightsGuard(navigation, draftTips != null || busy) { next ->
                if (!busy && pending == null) pending = next
            }
            if (navigation != null) {
                OutlinedTextField(focus, { editDraft(newFocus = it) }, enabled = !busy,
                    label = { Text("本周重点") }, modifier = Modifier.fillMaxWidth())
                if (needsRead) {
                    SupportingText("本周重点启用状态待核对，请重试同步")
                    TextButton(enabled = !busy, onClick = reload) { Text("重试读取") }
                }
                if (unsupported) SupportingText("当前云端暂不支持启用本周重点")
            }
            days.forEachIndexed { index, day ->
                val label = if (navigation == null) "周${"一二三四五六日"[index]}"
                    else planDayLabel(LocalDate.parse(week).plusDays(index.toLong()))
                OutlinedTextField(day, { value -> editDraft(newDays = days.toMutableList().apply { set(index, value) }) },
                    enabled = !busy, label = { Text(label) })
            }
            OutlinedTextField(reason, { editDraft(newReason = it) }, enabled = !busy, label = { Text("修订原因") })
            OutlinedButton(enabled = !busy && canSave, onClick = { save() }) { Text("保存计划") }
            val confirmUpgrade = upgradeConfirmation
            if (confirmUpgrade != null) ConfirmPlanningFocusUpgrade({ upgradeConfirmation = null }) {
                upgradeConfirmation = null
                confirmUpgrade()
            } else pending?.let { next ->
                AlertDialog(onDismissRequest = { if (!busy) pending = null }, title = { Text("周计划有未保存的修改") },
                    text = { Column {
                        OutlinedButton(enabled = !busy && canSave, onClick = { save(next) }) { Text("保存并离开") }
                        if (saveError.isNotEmpty()) {
                            Text(saveError, color = MaterialTheme.colorScheme.error)
                            OutlinedButton(enabled = !busy, onClick = retry) { Text("重试上次保存") }
                        }
                        OutlinedButton(enabled = !busy, onClick = {
                            clearDraft()
                            pending = null
                            next()
                        }) { Text("放弃修改") }
                    } }, confirmButton = {
                        OutlinedButton(enabled = !busy, onClick = { pending = null }) { Text("继续编辑") }
                    })
            }
        }
        var history by remember(week) { mutableStateOf(false) }
        OutlinedButton(onClick = { history = !history }) { Text(if (history) "收起历史版本" else "查看历史版本") }
        if (history) for (version in plan.history) {
            Text(version.getValue("created_at").jsonPrimitive.content)
            version["change_reason"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }?.let { Text(it) }
            Text(version["focus"]?.jsonPrimitive?.content.orEmpty().ifBlank { "未填写本周重点" })
            version.getValue("days").jsonArray.forEachIndexed { index, day -> Text("周${"一二三四五六日"[index]} ${day.jsonPrimitive.content}") }
            if (version !in plan.candidates) OutlinedButton(enabled = !busy, onClick = {
                confirm { act("delete", version.getValue("id").jsonPrimitive.content) }
            }) { Text("删除历史版本") }
        }
        if (plan.history.size > 1) RecordSandboxComparison(week, plan.history)
    }
    if (!showRating) return
    val rating = data.getValue("daily_ratings").jsonArray.map { it.jsonObject }.find {
        it["date"]?.jsonPrimitive?.content == date && it["deleted"]?.jsonPrimitive?.booleanOrNull != true
    }?.get("score")?.jsonPrimitive?.intOrNull
    if (calendarPeriod == null || calendarPeriod == "day") Text("当日评分 ${rating ?: "未评分"}")
    if (calendarPeriod != "day") RecordRatingCalendar(data, LocalDate.parse(date), busy, selectDate, calendarPeriod)
    if (calendarPeriod != null && calendarPeriod != "day") return
    for (score in listOf(1, 2, 3, 4, 5, null)) {
        OutlinedButton(enabled = !busy, onClick = { change(buildJsonObject {
            put("kind", "rate"); put("date", date); put("score", score?.let(::JsonPrimitive) ?: JsonNull)
        }) }) { Text(if (score == null) "清除评分" else "$score 分") }
    }
}

@Composable
private fun RecordRatingCalendar(data: JsonObject, selectedDate: LocalDate, busy: Boolean, selectDate: (String) -> Unit,
    period: String?, summary: Boolean = true, interactive: Boolean = true) {
    var showMonth by remember { mutableStateOf(false) }
    val month = if (period == null) showMonth else period == "month"
    val (start, end) = Learning.range(if (month) "month" else "week", selectedDate)
    val first = LocalDate.parse(WeeklyPlanning.monday(start.toString()))
    val lastWeek = LocalDate.parse(WeeklyPlanning.monday(end.minusDays(1).toString()))
    val rows = generateSequence(first) { it.plusDays(7).takeIf { day -> day <= lastWeek } }.toList()
    val scores = data.getValue("daily_ratings").jsonArray.map { it.jsonObject }
        .filterNot { it["deleted"]?.jsonPrimitive?.booleanOrNull == true }
        .associate { it.getValue("date").jsonPrimitive.content to it.getValue("score").jsonPrimitive.intOrNull }
    val (average, covered, days) = remember(data, start, end) {
        WeeklyPlanning.ratingSummary(data, start.toString(), end.minusDays(1).toString())
    }
    val coverage = if (period == null) "" else " · 已评分 $covered/$days 天"
    if (summary) Text((if (average == null) "暂无评分" else "${if (month) "月" else "周"}平均 $average") + coverage)
    if (period == null) OutlinedButton(onClick = { showMonth = !showMonth }) { Text(if (month) "查看本周评分" else "查看本月评分") }
    val colors = MaterialTheme.colorScheme
    val dateStyle = MaterialTheme.typography.labelMedium
    val scoreStyle = MaterialTheme.typography.labelSmall
    val weekScoreStyle = MaterialTheme.typography.titleSmall
    val today = LocalDate.now()
    val gap = 4.dp
    BoxWithConstraints(Modifier.widthIn(max = 336.dp).fillMaxWidth().padding(top = 4.dp, bottom = 8.dp)) {
        val squareSize = (maxWidth - gap * 6) / 7
        val textHeight = with(LocalDensity.current) {
            if (interactive) dateStyle.lineHeight.toDp() + scoreStyle.lineHeight.toDp() else weekScoreStyle.lineHeight.toDp()
        }
        val height = maxOf(squareSize, textHeight + 4.dp)
        Column(verticalArrangement = Arrangement.spacedBy(gap)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (weekday in "一二三四五六日") Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    SupportingText(weekday.toString())
                }
            }
            for (week in rows) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (index in 0..6) {
                    val day = week.plusDays(index.toLong())
                    val score = scores[day.toString()]
                    val active = day >= start && day < end
                    val fill = if (score == null) Color.Unspecified else ratingFill(score, active)
                    val foreground = if (score != null) ratingTextColor(fill) else if (active) colors.onSurface else colors.onSurfaceVariant
                    val isSelected = interactive && day == selectedDate
                    Box(Modifier.weight(1f).height(height)
                        .calendarCell(today = day == today, inRange = active, fill = fill, selected = isSelected)
                        .semantics(mergeDescendants = true) {
                            contentDescription = "$day ${score?.let { "$it 分" } ?: "未评分"}"
                            if (interactive) selected = isSelected
                        }.then(if (interactive) Modifier.clickable(enabled = !busy, role = Role.Button) {
                            selectDate(day.toString())
                        } else Modifier), contentAlignment = Alignment.Center) {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 3.dp).clearAndSetSemantics {},
                            horizontalAlignment = Alignment.CenterHorizontally) {
                            if (interactive) Text(day.dayOfMonth.toString(), color = foreground, style = dateStyle, maxLines = 1)
                            if (score != null) Text(score.toString(),
                                modifier = if (interactive) Modifier.align(Alignment.End) else Modifier,
                                color = foreground, style = if (interactive) scoreStyle else weekScoreStyle, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RecordSandboxComparison(week: String, versions: List<JsonObject>) {
    var visible by remember(week) { mutableStateOf(false) }
    var old by remember(week, versions) { mutableIntStateOf(versions.lastIndex - 1) }
    var next by remember(week, versions) { mutableIntStateOf(versions.lastIndex) }
    OutlinedButton(onClick = { visible = !visible }) { Text(if (visible) "收起对比" else "对比版本") }
    if (!visible) return
    Text("删除内容带删除线，新增内容带下划线。")
    Column(Modifier.horizontalScroll(rememberScrollState())) {
        Row {
            OutlinedButton(modifier = Modifier.width(220.dp), onClick = { old = (old + 1) % versions.size }) {
                Text("旧版 ${old + 1} · 点按切换")
            }
            OutlinedButton(modifier = Modifier.width(220.dp), onClick = { next = (next + 1) % versions.size }) {
                Text("新版 ${next + 1} · 点按切换")
            }
        }
        val oldDays = versions[old].getValue("days").jsonArray
        val nextDays = versions[next].getValue("days").jsonArray
        for (index in -1..6) {
            Text(if (index < 0) "本周重点" else "周${"一二三四五六日"[index]}")
            val oldText = (if (index < 0) versions[old]["focus"] else oldDays[index])?.jsonPrimitive?.content.orEmpty()
            val nextText = (if (index < 0) versions[next]["focus"] else nextDays[index])?.jsonPrimitive?.content.orEmpty()
            val diff = remember(oldText, nextText) {
                WeeklyPlanning.compare(oldText, nextText)
            }
            Row {
                for ((text, style) in listOf(diff.removed to TextDecoration.LineThrough, diff.added to TextDecoration.Underline)) {
                    Text(buildAnnotatedString {
                        append(diff.before)
                        withStyle(SpanStyle(textDecoration = style)) { append(text) }
                        append(diff.after)
                    }, Modifier.width(220.dp))
                }
            }
        }
    }
}

@Composable
private fun RecordSandboxExport(data: JsonObject, date: LocalDate, busy: Boolean, report: (String) -> Unit,
                                reviewData: LearningViewData? = null, defaultPeriod: String = "day", timingEnabled: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var content by rememberSaveable { mutableStateOf("") }
    var exporting by remember { mutableStateOf(false) }
    var visible by remember { mutableStateOf(false) }
    var plans by remember { mutableStateOf(false) }
    var ratings by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }
    var includeLearning by remember { mutableStateOf(true) }
    var period by remember(defaultPeriod) { mutableStateOf(defaultPeriod) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        if (uri == null) {
            content = ""
            exporting = false
        } else scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    requireNotNull(context.contentResolver.openOutputStream(uri)).use { it.write(content.encodeToByteArray()) }
                }
                report("已保存 Markdown。")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                report("导出失败（${error.message}）")
            } finally {
                content = ""
                exporting = false
            }
        }
    }
    OutlinedButton(enabled = !busy && !exporting, onClick = { visible = !visible }) { Text("导出 Markdown") }
    if (!visible) return
    if (timingEnabled) Row { Checkbox(includeLearning, { includeLearning = it }); Text("学习时长") }
    listOf(Triple("计划", plans, { value: Boolean -> plans = value }),
        Triple("评分", ratings, { value: Boolean -> ratings = value }),
        Triple("计划历史", history, { value: Boolean -> history = value })).forEach { (label, checked, change) ->
        Row { Checkbox(checked, change); Text(label) }
    }
    Row {
        for ((value, label) in listOf("day" to "当天", "week" to "本周", "month" to "本月")) {
            OutlinedButton(enabled = period != value, onClick = { period = value }) { Text(label) }
        }
    }
    OutlinedButton(enabled = !busy && !exporting, onClick = {
        try {
            val (start, end) = Learning.range(period, date)
            val options = WeeklyPlanning.ExportOptions(plans, ratings, history)
            val planning = if (plans || ratings || history) WeeklyPlanning.export(data, start, end, options) else null
            val reviews = reviewData?.data ?: sandboxExportJson.decodeFromJsonElement<TodoData>(data)
            val include = timingEnabled && includeLearning
            val result = if (reviewData == null) Learning.export(reviews, period, date, includeLearning = include, planning = planning)
                else Learning.export(reviews, period, date, includeLearning = include,
                    tasks = reviewData.tasks, conflicts = reviewData.conflicts, sourceId = reviewData.sourceId, planning = planning)
            content = result.second
            exporting = true
            save.launch(result.first)
        } catch (error: Exception) {
            content = ""
            exporting = false
            report(error.message ?: "导出失败")
        }
    }) { Text("保存文件") }
}
