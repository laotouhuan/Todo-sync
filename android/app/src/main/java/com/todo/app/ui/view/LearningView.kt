package com.todo.app.ui.view

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.todo.app.data.model.*
import com.todo.app.ui.viewmodel.TodoViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.UUID

@Composable
internal fun currentLearningData(viewModel: TodoViewModel): LearningViewData {
    val snapshot by viewModel.learningViewData.collectAsState()
    val source by viewModel.activeSource.collectAsState()
    val loading by viewModel.collabLoading.collectAsState()
    val id = (source as? TodoViewModel.ActiveSource.Collaboration)?.collab?.id
    // 来源切换与流更新之间也不得短暂展示个人或上一个协作源的数据。
    return if (snapshot.sourceId == id && !(id != null && loading)) snapshot
    else learningViewData(TodoData(1, "", emptyList()), id)
}

@Composable
private fun dismissOnSourceChange(viewModel: TodoViewModel, dismiss: () -> Unit) {
    val original = remember { viewModel.activeSource.value }
    val current by viewModel.activeSource.collectAsState()
    LaunchedEffect(current) { if (current != original) dismiss() }
}

@Composable
fun CollaborationSubmissionBanner(viewModel: TodoViewModel) {
    val submissions by viewModel.pendingCollaborationSubmissions.collectAsState()
    var discard by remember { mutableStateOf<String?>(null) }
    submissions.forEach { submission ->
        Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                Text("${submission.name}：新增结果待确认", fontSize = 12.sp)
                Row {
                    TextButton(enabled = !submission.sending, onClick = { viewModel.retryCollaborationSubmission(submission.sourceId) }) {
                        Text(if (submission.sending) "提交中…" else "重试此次提交")
                    }
                    TextButton(enabled = !submission.sending, onClick = { discard = submission.sourceId }) { Text("放弃此次提交") }
                }
            }
        }
    }
    discard?.let { id -> AlertDialog(onDismissRequest = { discard = null }, title = { Text("放弃此次提交？") },
        text = { Text("任务可能已经保存。放弃后重新新增可能产生重复任务。") },
        confirmButton = { TextButton(onClick = { viewModel.discardCollaborationSubmission(id); discard = null }) { Text("放弃") } },
        dismissButton = { TextButton(onClick = { discard = null }) { Text("取消") } }) }
}

@Composable
private fun LearningClock(entry: TimeEntry) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(entry.started_at, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) { now = System.currentTimeMillis(); delay(1000) }
        }
    }
    Text(Learning.duration(now - (Learning.instant(entry.started_at)?.toEpochMilli() ?: now), true),
        fontFamily = FontFamily.Monospace, fontSize = 11.sp, maxLines = 1)
}

@Composable
fun LearningTimer(todo: Todo, viewModel: TodoViewModel) {
    val learning = currentLearningData(viewModel)
    val source by viewModel.activeSource.collectAsState()
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val active = data.timeEntries.filter { !it.deleted && it.ended_at == null }
    val ref = viewModel.learningReference(todo)
    val entry = active.find { it.task_ref == ref }
    val scope = rememberCoroutineScope(); val context = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    if (learning.readOnly) {
        if (entry != null) LearningClock(entry)
        return
    }
    if (!todo.deleted && (entry != null || active.isEmpty())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (entry != null) LearningClock(entry)
            TextButton(enabled = !busy, contentPadding = PaddingValues(horizontal = 5.dp), onClick = click@ {
                if (viewModel.activeSource.value != source) return@click
                busy = true
                scope.launch {
                    try {
                        val result = if (entry == null) viewModel.startLearning(todo, source) else viewModel.stopLearning(entry.id, source)
                        result.exceptionOrNull()?.let { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                    } finally { busy = false }
                }
            }) { Text(if (entry == null) "开始" else "结束", fontSize = 12.sp) }
        }
    }
}

@Composable
fun LearningBanner(viewModel: TodoViewModel) {
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val active = data.timeEntries.filter { !it.deleted && it.ended_at == null }
    var show by remember { mutableStateOf(false) }
    LaunchedEffect(active.map { it.id }.sorted()) { if (!learning.readOnly && active.size > 1) show = true }
    if (active.isNotEmpty()) {
        Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (active.size > 1) "${active.size} 条计时待处理" else active.first().task_content_snapshot,
                    Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp)
                if (active.size == 1) LearningClock(active.first())
                TextButton(onClick = { show = true }) { Text(if (learning.readOnly) "查看记录" else if (active.size > 1) "处理" else "记录 / 结束") }
            }
        }
    }
    if (show) LearningRecordsDialog(viewModel, active.map { it.id }, onDismiss = { show = false })
}

@Composable
fun LearningRecordsDialog(viewModel: TodoViewModel, ids: List<String>, onDismiss: () -> Unit) {
    dismissOnSourceChange(viewModel, onDismiss)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || currentLearningData(viewModel).readOnly
    if (!timingEnabled) return
    AlertDialog(onDismissRequest = onDismiss, title = { Text("计时记录") }, text = {
        Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
            if (!currentLearningData(viewModel).readOnly) Text("有多条运行记录时，请补上真实结束时间或删除误开记录。", fontSize = 12.sp)
            LearningRecords(viewModel, ids = ids)
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

@Composable
fun LearningTaskRecords(viewModel: TodoViewModel, todo: Todo) {
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val ref = viewModel.learningReference(todo)
    val records = data.timeEntries.filter { !it.deleted && it.task_ref == ref }
    val today = LocalDate.now()
    val summary = remember(data.timeEntries, learning.conflicts, today) { Learning.summary(data.timeEntries, today, today.plusDays(1), conflicts = learning.conflicts) }
    val parts = summary.parts.filter { it.entry.task_ref == ref }
    val conflicts = learning.conflicts
    var show by rememberSaveable(todo.id) { mutableStateOf(false) }
    val summaryText = "今日 ${Learning.duration(parts.sumOf { it.duration })} · ${parts.size} 次" +
        (if (records.any { it.ended_at == null }) " · 进行中" else "") +
        (if (records.any { it.id in conflicts }) " · 待核对" else "")
    EditDetailSection("计时记录", summaryText) {
        TextButton(onClick = { show = true }) { Text(if (learning.readOnly) "查看计时记录" else "管理计时记录") }
    }
    if (show) Dialog(onDismissRequest = { show = false }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.systemBarsPadding().imePadding().padding(16.dp)) {
                Text("计时记录", style = MaterialTheme.typography.titleLarge)
                TextButton(onClick = { show = false }) { Text("返回任务详情") }
                HorizontalDivider()
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) { LearningRecords(viewModel, todo) }
            }
        }
    }
}

@Composable
fun LearningRecords(viewModel: TodoViewModel, todo: Todo? = null, ids: List<String>? = null) {
    val learning = currentLearningData(viewModel)
    val source by viewModel.activeSource.collectAsState()
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val tasks = learning.tasks
    val resolved = remember(data.timeEntries, tasks) { Learning.resolveEntries(data.timeEntries, tasks).associateBy { it.id } }
    val scope = rememberCoroutineScope(); val context = LocalContext.current
    val ref = todo?.let { viewModel.learningReference(it) }
    var editing by remember { mutableStateOf<TimeEntry?>(null) }
    val records = data.timeEntries.filter { !it.deleted && (ids?.contains(it.id) ?: (it.task_ref == ref)) }
        .sortedWith(compareBy<TimeEntry> { it.ended_at != null }.thenByDescending { it.started_at })
    if (todo != null && !learning.readOnly) {
        TextButton(onClick = {
            val now = nowIso()
            editing = TimeEntry(UUID.randomUUID().toString(), ref!!, now, now, now, todo.content, todo.label, now)
        }) { Text("补录计时记录") }
    }
    records.forEach { entry ->
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text("${entry.task_content_snapshot} · ${resolved[entry.id]?.label_snapshot ?: "未分类"}${if (entry.task_ref !in tasks) " · 原任务不可用" else if (tasks[entry.task_ref]?.deleted == true) " · 原任务已删除" else ""}", style = MaterialTheme.typography.bodyLarge)
            Text("开始：${displayLearningTime(entry.started_at)}", style = MaterialTheme.typography.bodyMedium)
            Text("结束：${entry.ended_at?.let(::displayLearningTime) ?: "进行中"}", style = MaterialTheme.typography.bodyMedium)
            if (entry.ended_at != null) Text(Learning.duration((Learning.instant(entry.ended_at)?.toEpochMilli() ?: 0) - (Learning.instant(entry.started_at)?.toEpochMilli() ?: 0)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (entry.id in learning.conflicts) Text("待核对：与其他计时重叠，未计入统计")
            if (!learning.readOnly) Row {
                TextButton(onClick = { editing = entry }) { Text("编辑记录") }
                TextButton(onClick = click@ {
                    if (viewModel.activeSource.value != source) return@click
                    scope.launch {
                        viewModel.saveTimeEntry(entry.copy(deleted = true), source).exceptionOrNull()?.let { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                    }
                }) { Text("删除") }
                if (entry.ended_at == null && records.count { it.ended_at == null } == 1) {
                    TextButton(onClick = click@ {
                        if (viewModel.activeSource.value != source) return@click
                        scope.launch { viewModel.stopLearning(entry.id, source).exceptionOrNull()?.let { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() } }
                    }) { Text("结束") }
                }
            }
            HorizontalDivider()
        }
    }
    editing?.let { entry -> TimeEntryEditor(entry, viewModel) { editing = null } }
}

private fun displayLearningTime(value: String): String = Learning.instant(value)?.atZone(ZoneId.systemDefault())
    ?.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")) ?: value

@Composable
internal fun TimeEntryEditor(entry: TimeEntry, viewModel: TodoViewModel, onDismiss: () -> Unit) {
    val source = remember { viewModel.activeSource.value }
    val currentSource by viewModel.activeSource.collectAsState()
    LaunchedEffect(currentSource) { if (currentSource != source) onDismiss() }
    if (currentLearningData(viewModel).readOnly) { LearningRecordsDialog(viewModel, listOf(entry.id), onDismiss); return }
    var start by rememberSaveable(entry.id) { mutableStateOf(displayLearningTime(entry.started_at)) }
    var end by rememberSaveable(entry.id) { mutableStateOf(entry.ended_at?.let(::displayLearningTime) ?: "") }
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val tasks = learning.tasks
    val currentLabel = Learning.resolveEntries(data.timeEntries + if (data.timeEntries.none { it.id == entry.id }) listOf(entry) else emptyList(), tasks).find { it.id == entry.id }?.label_snapshot ?: "未分类"
    var error by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("编辑计时记录") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("所属任务：${entry.task_content_snapshot}")
            Text("日期和时间格式：2026-09-10 09:30:00", fontSize = 12.sp)
            OutlinedTextField(start, { start = it }, label = { Text("开始日期和时间") }, enabled = !busy)
            OutlinedTextField(end, { end = it }, label = { Text("结束日期和时间（运行中可留空）") }, enabled = !busy)
            Text("所属任务标签：$currentLabel（在任务编辑页修改）", style = MaterialTheme.typography.bodyMedium)
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = click@ {
        if (viewModel.activeSource.value != source) { onDismiss(); return@click }
        scope.launch {
            busy = true
            try {
                fun parse(text: String) = LocalDateTime.parse(text.trim().replace(' ', 'T')).atZone(ZoneId.systemDefault()).toInstant().toString()
                val result = viewModel.saveTimeEntry(entry.copy(started_at = parse(start), ended_at = end.takeIf { it.isNotBlank() }?.let(::parse)), source)
                if (result.isSuccess) onDismiss() else error = result.exceptionOrNull()?.message ?: "保存失败"
            } catch (_: Exception) { error = "请输入有效的日期和时间" } finally { busy = false }
        }
    }) { Text("保存记录") } }, dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") } })
}

@Composable
fun LearningInsights(viewModel: TodoViewModel, period: String, targetDate: LocalDate) {
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    val data = learning.data
    val tasks = learning.tasks
    val resolved = remember(data.timeEntries, tasks) { Learning.resolveEntries(data.timeEntries, tasks) }
    val (start, end) = Learning.range(period, targetDate)
    var selectedLabel by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(resolved, selectedLabel) {
        if (selectedLabel != null && resolved.none { !it.deleted && (it.label_snapshot ?: "未分类") == selectedLabel }) selectedLabel = null
    }
    var showLabels by remember { mutableStateOf(false) }
    var recordIds by remember { mutableStateOf<List<String>?>(null) }
    var reviewDate by rememberSaveable { mutableStateOf<String?>(null) }
    var showExport by remember { mutableStateOf(false) }
    val summary = remember(resolved, learning.conflicts, start, end, selectedLabel) { Learning.summary(resolved, start, end, selectedLabel = selectedLabel, conflicts = learning.conflicts) }
    if (timingEnabled) Card(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Column(Modifier.padding(14.dp)) {
            Text(if (learning.readOnly) "学习投入" else "我的学习投入", style = MaterialTheme.typography.titleMedium)
            Box {
                TextButton(onClick = { showLabels = true }) { Text(selectedLabel ?: "全部标签") }
                DropdownMenu(showLabels, { showLabels = false }) {
                    (listOf<String?>(null) + resolved.filterNot { it.deleted }.map { it.label_snapshot ?: "未分类" }.distinct().sorted()).forEach { label ->
                        DropdownMenuItem(text = { Text(label ?: "全部标签") }, onClick = { selectedLabel = label; showLabels = false })
                    }
                }
            }
            Text("${Learning.duration(summary.duration)} · ${summary.count} 次")
            summary.groups.forEach { group -> TextButton(onClick = { recordIds = summary.parts.filter { (it.entry.label_snapshot ?: "未分类") == group.label }.map { it.entry.id }.distinct() }) {
                Text("${group.label} · ${Learning.duration(group.duration)} · ${group.count} 次")
            } }
            if (summary.running > 0) Text("${summary.running} 条进行中，尚未计入汇总", fontSize = 12.sp)
            if (summary.pending > 0) TextButton(onClick = { recordIds = learning.pendingIds(start, end) }) { Text("${summary.pending} 条待核对记录未计入 · 查看") }
        }
    }
    Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        Column(Modifier.padding(14.dp)) {
            Text(if (learning.readOnly) "每日复盘" else "我的复盘", style = MaterialTheme.typography.titleMedium)
            TextButton(onClick = { showExport = true }) { Text("导出 Markdown") }
            val reviews = data.dailyReviews.filter { !it.deleted && it.date >= start.toString() && it.date < end.toString() }.sortedByDescending { it.date }
            if (period == "day") {
                reviews.firstOrNull()?.let { review -> Learning.fields(review).forEach { (name, value) ->
                    Text(name, style = MaterialTheme.typography.labelLarge); Text(value.ifBlank { "未填写" }, Modifier.padding(bottom = 8.dp))
                } }
                if (!learning.readOnly || reviews.isNotEmpty()) TextButton(onClick = { reviewDate = start.toString() }) { Text(if (learning.readOnly) "查看复盘" else if (reviews.isEmpty()) "写复盘" else "查看 / 编辑") }
                else Text("暂无复盘")
            } else {
                if (reviews.isEmpty()) Text("这个时间范围还没有复盘")
                reviews.forEach { review -> TextButton(onClick = { reviewDate = review.date }) {
                    Column(Modifier.fillMaxWidth()) { Text(review.date); Text(Learning.preview(review), maxLines = 2, overflow = TextOverflow.Ellipsis) }
                } }
            }
        }
    }
    recordIds?.let { LearningRecordsDialog(viewModel, it) { recordIds = null } }
    reviewDate?.let { date -> DailyReviewDialog(viewModel, date) { reviewDate = null } }
    if (showExport) ReviewExportDialog(viewModel, data, period, targetDate) { showExport = false }
}

@Composable
private fun DailyReviewDialog(viewModel: TodoViewModel, date: String, onDismiss: () -> Unit) {
    val source = remember { viewModel.activeSource.value }
    val currentSource by viewModel.activeSource.collectAsState()
    LaunchedEffect(currentSource) { if (currentSource != source) onDismiss() }
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val saved = data.dailyReviews.find { it.date == date && !it.deleted }
    var editing by rememberSaveable(date) { mutableStateOf(saved == null && !learning.readOnly) }
    var fact by rememberSaveable(date) { mutableStateOf(saved?.fact ?: "") }
    var obstacle by rememberSaveable(date) { mutableStateOf(saved?.obstacle ?: "") }
    var action by rememberSaveable(date) { mutableStateOf(saved?.effective_action ?: "") }
    var next by rememberSaveable(date) { mutableStateOf(saved?.next_step ?: "") }
    var baseline by rememberSaveable(date) { mutableStateOf(listOf(fact, obstacle, action, next)) }
    var leave by remember { mutableStateOf(false) }; var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }; var exporting by remember { mutableStateOf(false) }
    var exportChoice by remember { mutableStateOf(false) }
    val dirty = editing && listOf(fact, obstacle, action, next) != baseline
    val scope = rememberCoroutineScope()
    fun reset() { fact = saved?.fact ?: ""; obstacle = saved?.obstacle ?: ""; action = saved?.effective_action ?: ""; next = saved?.next_step ?: ""; baseline = listOf(fact, obstacle, action, next) }
    fun save(close: Boolean, exportAfter: Boolean = false) {
        if (viewModel.activeSource.value != source) { error = "清单已切换，请重新打开"; return }
        busy = true
        scope.launch {
            try {
                val now = nowIso()
                val result = viewModel.saveDailyReview(DailyReview(saved?.id ?: UUID.randomUUID().toString(), date, saved?.created_at ?: now, now, fact, obstacle, action, next), source)
                if (result.isSuccess) { baseline = listOf(fact, obstacle, action, next); editing = false; leave = false; exportChoice = false; if (exportAfter) exporting = true; if (close) onDismiss() }
                else error = result.exceptionOrNull()?.message ?: "保存失败"
            } finally { busy = false }
        }
    }
    Dialog(onDismissRequest = { if (!busy) { if (dirty) leave = true else onDismiss() } }) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(16.dp).heightIn(max = 620.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("$date · 每日复盘", style = MaterialTheme.typography.titleMedium)
                if (editing) {
                    OutlinedTextField(fact, { fact = it }, label = { Text("事实") }, placeholder = { Text("今天推进了什么？理解、推导、例子、明确卡点都算。") }, enabled = !busy, minLines = 2)
                    OutlinedTextField(obstacle, { obstacle = it }, label = { Text("卡点") }, placeholder = { Text("拖延或中断发生在哪里？当时发生了什么？") }, enabled = !busy, minLines = 2)
                    OutlinedTextField(action, { action = it }, label = { Text("有效动作") }, placeholder = { Text("什么帮助你开始或回到任务？") }, enabled = !busy, minLines = 2)
                    OutlinedTextField(next, { next = it }, label = { Text("下一步") }, placeholder = { Text("明天想保留什么，或只调整什么？") }, enabled = !busy, minLines = 2)
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    Row { TextButton(enabled = !busy, onClick = { save(false) }) { Text("保存") }
                        TextButton(enabled = !busy, onClick = { reset(); if (saved == null) onDismiss() else editing = false }) { Text("取消") }
                        TextButton(enabled = !busy, onClick = { if (dirty) exportChoice = true else exporting = true }) { Text("导出") } }
                } else {
                    saved?.let { Learning.fields(it).forEach { (title, value) -> Text(title, style = MaterialTheme.typography.labelLarge); Text(value.ifBlank { "未填写" }) } }
                    Row { if (!learning.readOnly) TextButton(onClick = { reset(); editing = true }) { Text("编辑") }; TextButton(onClick = { exporting = true }) { Text("导出") } }
                }
                TextButton(enabled = !busy, onClick = { if (dirty) leave = true else onDismiss() }) { Text("关闭") }
            }
        }
    }
    if (leave) AlertDialog(onDismissRequest = { if (!busy) leave = false }, title = { Text("复盘有未保存的修改") }, text = {
        Column {
            TextButton(enabled = !busy, onClick = { save(true) }) { Text("保存并离开") }
            TextButton(enabled = !busy, onClick = { onDismiss() }) { Text("放弃修改") }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = { leave = false }) { Text("继续编辑") } })
    if (exportChoice) AlertDialog(onDismissRequest = { if (!busy) exportChoice = false }, title = { Text("有未保存的复盘修改") }, text = {
        Column {
            TextButton(enabled = !busy, onClick = { save(false, exportAfter = true) }) { Text("保存后导出") }
            TextButton(enabled = !busy, onClick = { exportChoice = false; exporting = true }) { Text("仅导出已保存内容") }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = { exportChoice = false }) { Text("取消") } })
    if (exporting) ReviewExportDialog(viewModel, data, "day", LocalDate.parse(date)) { exporting = false }
}

@Composable
private fun ReviewExportDialog(viewModel: TodoViewModel, data: TodoData, period: String, date: LocalDate, onDismiss: () -> Unit) {
    dismissOnSourceChange(viewModel, onDismiss)
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    val tasks = learning.tasks
    var include by remember { mutableStateOf(true) }; var content by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf("") }; var savedUri by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }; val context = LocalContext.current; val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        if (uri != null) scope.launch {
            busy = true
            try {
                withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) } ?: error("无法打开文件") }
                savedUri = uri.toString(); error = ""; Toast.makeText(context, "文件已保存", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) { error = "导出失败：${e.message}" } finally { busy = false }
        }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("导出复盘 Markdown") }, text = {
        Column {
            if (timingEnabled) {
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(include, { include = it }); Text("附带当日学习时长统计" + if (period == "day") "" else "（逐日）") }
                Text("进行中和待核对记录不计入统计。", fontSize = 12.sp)
            }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
            savedUri?.let { uri -> TextButton(onClick = {
                val intent = Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_STREAM, Uri.parse(uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                context.startActivity(Intent.createChooser(intent, "分享复盘文件"))
            }) { Text("分享已导出文件") } }
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = {
        try { val result = Learning.export(data, period, date, timingEnabled && include, tasks = tasks, conflicts = learning.conflicts); content = result.second; launcher.launch(result.first) }
        catch (e: Exception) { error = e.message ?: "导出失败" }
    }) { Text("保存文件") } }, dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("关闭") } })
}
