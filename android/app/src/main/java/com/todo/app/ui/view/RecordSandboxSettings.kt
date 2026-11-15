package com.todo.app.ui.view

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.LocalPinnableContainer
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Learning
import com.todo.app.data.model.LearningViewData
import com.todo.app.data.model.TodoData
import com.todo.app.data.model.WeeklyPlanning
import com.todo.app.data.model.SyncPhase
import com.todo.app.data.ConfigManager
import com.todo.app.data.repository.RecordSandbox
import com.todo.app.data.repository.RecordSandboxTarget
import com.todo.app.data.repository.RecordSandboxView
import com.todo.app.data.repository.PlanningCloudConnection
import com.todo.app.data.repository.retainsLocalPlanning
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
    val change: (JsonObject, () -> Unit) -> Unit,
    val retry: () -> Unit,
    val reload: () -> Unit
)

@Composable
internal fun rememberPersonalPlanning(config: ConfigManager, updatePlanningSync: (String, SyncPhase) -> Unit): PersonalPlanningState {
    val targets = remember(config) { config.planningTargets() }
    val settings by targets.collectAsState(initial = config.planningSettings())
    val (target, cloud) = settings
    // 重建页内会话时保留磁盘日志；旧目标的状态不能经过重组投到新目标。
    return key(settings) {
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        var session by remember { mutableStateOf<RecordSandbox?>(null) }
        var state by remember { mutableStateOf<RecordSandboxView?>(null) }
        var busy by remember { mutableStateOf(false) }
        var status by remember { mutableStateOf("") }
        var connectedCloud by remember { mutableStateOf(false) }
        var reload by remember { mutableIntStateOf(0) }
        var loadError by remember { mutableStateOf(false) }
        var syncFailed by remember { mutableStateOf(false) }
        var actionDate by remember { mutableStateOf<String?>(null) }
        var afterSave by remember { mutableStateOf<(() -> Unit)?>(null) }
        LaunchedEffect(settings, reload) {
            loadError = false
            try {
                val (opened, retained) = withContext(Dispatchers.IO) {
                    val preferences = context.getSharedPreferences("personal-planning", android.content.Context.MODE_PRIVATE)
                    val key = "target-$target"
                    val fixed = synchronized(planningPreferencesLock) {
                        preferences.getString(key, null)?.let { Json.decodeFromString<RecordSandboxTarget>(it) }
                            ?: RecordSandboxTarget(UUID.randomUUID().toString(), UUID.randomUUID().toString(), Instant.now().toString())
                                .also { check(preferences.edit().putString(key, Json.encodeToString(RecordSandboxTarget.serializer(), it)).commit()) }
                    }
                    val legacy = RecordSandbox(context.filesDir, fixed, localOnly = true)
                    val retain = cloud != null && legacy.open().preview.retainsLocalPlanning()
                    val synced = if (cloud != null && !retain)
                        RecordSandbox(context.filesDir, cloud.target(fixed.actorId), localOnly = true, cloud = cloud)
                    else legacy
                    synced to retain
                }
                if (config.planningSettings() != settings) return@LaunchedEffect
                connectedCloud = cloud != null && !retained
                updatePlanningSync(target, when {
                    connectedCloud -> SyncPhase.RUNNING
                    retained -> SyncPhase.FAILED
                    else -> SyncPhase.IDLE
                })
                val initial = opened.open()
                if (config.planningSettings() != settings) return@LaunchedEffect
                checkNotNull(initial.preview.view)
                state = initial
                session = opened
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (config.planningSettings() != settings) return@LaunchedEffect
                loadError = true
                if (cloud != null) updatePlanningSync(target, SyncPhase.FAILED)
            }
        }
        LaunchedEffect(session, connectedCloud) {
            val opened = session ?: return@LaunchedEffect
            if (!connectedCloud) return@LaunchedEffect
            while (config.planningSettings() == settings) {
                if (!busy) {
                    try {
                        val next = opened.sync()
                        if (!busy && config.planningSettings() == settings) {
                            if (next.preview.view != null) state = next
                            syncFailed = next.syncIncomplete || next.preview.view == null
                            updatePlanningSync(target, when {
                                syncFailed -> SyncPhase.FAILED
                                next.preview.journal.pending.isNotEmpty() -> SyncPhase.RUNNING
                                else -> SyncPhase.IDLE
                            })
                        }
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: com.todo.app.data.repository.RecordTransportIntegrityException) {
                        if (config.planningSettings() == settings) {
                            syncFailed = true
                            updatePlanningSync(target, SyncPhase.FAILED)
                        }
                        break
                    } catch (_: Exception) {
                        if (config.planningSettings() == settings) {
                            syncFailed = true
                            updatePlanningSync(target, SyncPhase.FAILED)
                        }
                    }
                }
                delay(15000)
            }
        }
        fun write(operation: suspend (RecordSandbox) -> Pair<RecordSandboxView, Boolean>) {
            val selected = session ?: return
            if (busy || config.planningSettings() != settings) return
            busy = true
            status = ""
            scope.launch {
                try {
                    if (config.planningSettings() == settings) {
                        val (result, saved) = operation(selected)
                        if (config.planningSettings() != settings) return@launch
                        state = result
                        if (saved) {
                            afterSave?.invoke()
                        }
                        afterSave = null
                        if (connectedCloud && state?.preview?.journal?.pending?.isNotEmpty() == true) {
                            updatePlanningSync(target, SyncPhase.RUNNING)
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    status = "保存未确认（${error.message}）"
                } finally {
                    busy = false
                }
            }
        }
        PersonalPlanningState(settings, state?.preview?.view, busy, loadError, syncFailed, status, actionDate,
            change = { action, onSaved ->
                val revision = state?.revision
                if (!busy && revision != null) {
                    actionDate = action["date"]?.jsonPrimitive?.content
                    afterSave = onSaved
                    write { it.change(action, revision) to true }
                }
            },
            retry = { write { it.retryWithResult() } },
            reload = { if (loadError) reload++ })
    }
}

@Composable
internal fun PersonalPlanningStats(
    state: PersonalPlanningState, date: LocalDate, period: String, navigation: InsightsNavigation,
    selectDay: (LocalDate) -> Unit
) {
    var confirmation by remember { mutableStateOf<(() -> Unit)?>(null) }
    var expanded by remember(date, period) { mutableStateOf(false) }
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text(if (period == "week") "周计划与评分" else "月评分", style = MaterialTheme.typography.titleSmall)
            val data = state.data
            if (data != null) {
                val week = WeeklyPlanning.monday(date.toString())
                val plan = remember(data, week) { WeeklyPlanning.state(data, week) }
                if (state.syncFailed) Text("计划与评分同步未完成")
                if (period == "week") {
                    plan.current?.getValue("days")?.jsonArray?.forEachIndexed { index, text ->
                        val day = LocalDate.parse(week).plusDays(index.toLong())
                        Text(planDayLabel(day), style = MaterialTheme.typography.labelLarge)
                        Text(text.jsonPrimitive.content.ifEmpty { "当天未安排" })
                        OutlinedButton(onClick = { selectDay(day) }) { Text("查看当日回顾") }
                    }
                    OutlinedButton(onClick = {
                        if (expanded) navigation.request { expanded = false } else expanded = true
                    }) { Text(when {
                        expanded -> "收起周计划"
                        plan.status == "conflict" -> "处理计划分歧"
                        plan.status == "restart" -> "重新制定周计划"
                        plan.status == "empty" -> "制定周计划"
                        else -> "编辑周计划"
                    }) }
                }
                if (expanded && period == "week") RecordSandboxPlanning(data, date.toString(), week, state.busy,
                    { action -> state.change(action) {} }, { confirmation = it }, {}, showRating = false,
                    navigation = navigation, savePlan = state.change, saveError = state.saveError, retry = state.retry)
                RecordRatingCalendar(data, date, state.busy, { selectDay(LocalDate.parse(it)) }, period)
            } else PlanningReadStatus(state)
            if (state.busy && state.actionDate == null) Text("正在保存计划…")
            if (state.saveError.isNotEmpty() && state.actionDate == null) {
                Text(state.saveError)
                OutlinedButton(enabled = !state.busy, onClick = state.retry) { Text("重试上次保存") }
            }
        }
    }
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
    Text("当日计划 · 当前周计划", style = MaterialTheme.typography.labelLarge)
    val data = state.data
    if (data == null) {
        PlanningReadStatus(state)
        return
    }
    val week = WeeklyPlanning.monday(date.toString())
    val plan = remember(data, week) { WeeklyPlanning.state(data, week) }
    Text(when (plan.status) {
        "current" -> plan.current?.getValue("days")?.jsonArray?.get(date.dayOfWeek.value - 1)
            ?.jsonPrimitive?.content.orEmpty().ifEmpty { "当天未安排" }
        "conflict" -> "周计划存在分歧，请到周视图处理"
        "restart" -> "周计划需重新制定"
        else -> "本周尚未制定计划"
    })
    if (state.syncFailed) Text("计划与评分同步未完成")
    if (openWeek != null) OutlinedButton(onClick = openWeek) { Text(if (plan.status == "empty") "去制定周计划" else "查看本周计划") }
}

@Composable
internal fun DailyRating(state: PersonalPlanningState, date: LocalDate) {
    val data = state.data ?: return
    val score = data.getValue("daily_ratings").jsonArray.map { it.jsonObject }.find {
        it["date"]?.jsonPrimitive?.content == date.toString() && it["deleted"]?.jsonPrimitive?.booleanOrNull != true
    }?.get("score")?.jsonPrimitive?.intOrNull
    val error = state.saveError.takeIf { state.actionDate == date.toString() }.orEmpty()
    Text("当日评分 · " + (score?.let { "$it 分" } ?: "未评分"), style = MaterialTheme.typography.labelLarge)
    fun rate(value: Int?) = state.change(buildJsonObject {
        put("kind", "rate")
        put("date", date.toString())
        put("score", value?.let(::JsonPrimitive) ?: JsonNull)
    }) {}
    Row(Modifier.fillMaxWidth()) {
        for (value in 1..5) androidx.compose.material3.FilterChip(
            selected = score == value, enabled = !state.busy && error.isEmpty(),
            onClick = { rate(value) }, label = { Text(value.toString()) },
            modifier = Modifier.weight(1f).padding(horizontal = 2.dp).semantics { contentDescription = "$value 分" }
        )
    }
    if (score != null) OutlinedButton(enabled = !state.busy && error.isEmpty(), onClick = { rate(null) }) { Text("清除评分") }
    if (state.busy && state.actionDate == date.toString()) Text("正在保存评分…")
    if (error.isNotEmpty()) {
        Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedButton(enabled = !state.busy, onClick = state.retry) { Text("重试保存评分") }
    }
}

private val planningPreferencesLock = Any()

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
        if (status.isNotEmpty()) Text(status)
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
                RecordSandboxPlanning(view, date, week, busy, { change(it) }, { confirmation = it }, { date = it })
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
    navigation: InsightsNavigation? = null, savePlan: ((JsonObject, () -> Unit) -> Unit)? = null,
    saveError: String = "", retry: () -> Unit = {}
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
                candidate.getValue("days").jsonArray.forEachIndexed { index, day -> Text("周${"一二三四五六日"[index]} ${day.jsonPrimitive.content}") }
                OutlinedButton(enabled = !busy, onClick = { act("resolve", id) }) { Text("采用此版") }
            }
        } else {
            val baseline = remember(week, plan.tips) {
                List(7) { plan.current?.getValue("days")?.jsonArray?.get(it)?.jsonPrimitive?.content.orEmpty() }
            }
            var days by rememberSaveable(week, plan.tips) { mutableStateOf(ArrayList(baseline)) }
            var reason by rememberSaveable(week, plan.tips) { mutableStateOf("") }
            var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
            val canSave = plan.status == "current" || days.any { it.isNotBlank() }
            fun save(after: (() -> Unit)? = null) {
                val action = operation("save", UUID.randomUUID().toString()) {
                    put("days", JsonArray(days.map(::JsonPrimitive)))
                    put("reason", reason)
                }
                if (savePlan == null) change(action) else savePlan(action) {
                    reason = ""
                    pending = null
                    after?.invoke()
                }
            }
            RegisterInsightsGuard(navigation, days != baseline || reason.isNotEmpty() || busy) { next ->
                if (!busy && pending == null) pending = next
            }
            days.forEachIndexed { index, day ->
                val label = if (navigation == null) "周${"一二三四五六日"[index]}"
                    else planDayLabel(LocalDate.parse(week).plusDays(index.toLong()))
                OutlinedTextField(day, { value -> days = ArrayList(days).apply { set(index, value) } },
                    enabled = !busy, label = { Text(label) })
            }
            OutlinedTextField(reason, { reason = it }, enabled = !busy, label = { Text("修订原因") })
            OutlinedButton(enabled = !busy && canSave && saveError.isEmpty(), onClick = { save() }) { Text("保存计划") }
            pending?.let { next ->
                AlertDialog(onDismissRequest = { if (!busy) pending = null }, title = { Text("周计划有未保存的修改") },
                    text = { Column {
                        OutlinedButton(enabled = !busy && canSave && saveError.isEmpty(), onClick = { save(next) }) { Text("保存并离开") }
                        if (saveError.isNotEmpty()) {
                            Text(saveError, color = MaterialTheme.colorScheme.error)
                            OutlinedButton(enabled = !busy, onClick = retry) { Text("重试上次保存") }
                        }
                        OutlinedButton(enabled = !busy, onClick = {
                            days = ArrayList(baseline)
                            reason = ""
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
private fun RecordRatingCalendar(data: JsonObject, selectedDate: LocalDate, busy: Boolean, selectDate: (String) -> Unit, period: String?) {
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
    val summary = if (average == null) "暂无评分" else "${if (month) "月" else "周"}平均 $average"
    Text("$summary$coverage")
    if (period == null) OutlinedButton(onClick = { showMonth = !showMonth }) { Text(if (month) "查看本周评分" else "查看本月评分") }
    Row { for (weekday in "一二三四五六日") Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { Text(weekday.toString()) } }
    val colors = MaterialTheme.colorScheme
    val today = LocalDate.now()
    for (week in rows) Row {
        for (index in 0..6) {
            val day = week.plusDays(index.toLong())
            val score = scores[day.toString()]
            val active = day >= start && day < end
            val fill = if (score == null) colors.surfaceVariant else colors.primary.copy(alpha = (0.10f + score * 0.09f) * if (active) 1f else 0.5f)
            val mark = when {
                day == selectedDate -> Modifier.border(2.dp, colors.primary)
                day == today -> Modifier.border(1.dp, colors.outline)
                else -> Modifier
            }
            Box(Modifier.weight(1f).height(48.dp).padding(2.dp).background(fill).then(mark)
                .semantics {
                    contentDescription = "$day ${score?.let { "$it 分" } ?: "未评分"}"
                    selected = day == selectedDate
                }.clickable(enabled = !busy) { selectDate(day.toString()) }, contentAlignment = Alignment.Center) {
                Text(day.dayOfMonth.toString() + (score?.let { "\n$it" } ?: ""),
                    color = if (active) colors.onSurface else colors.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
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
        for (index in 0..6) {
            Text("周${"一二三四五六日"[index]}")
            val diff = remember(oldDays[index], nextDays[index]) {
                WeeklyPlanning.compare(oldDays[index].jsonPrimitive.content, nextDays[index].jsonPrimitive.content)
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
