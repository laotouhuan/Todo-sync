package com.todo.app.ui.view

import com.todo.app.ui.theme.SupportingText

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
import kotlinx.serialization.json.JsonElement
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
                Text("${submission.name}：新增结果待确认", style = MaterialTheme.typography.bodySmall)
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
        fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, maxLines = 1)
}

@Composable
fun LearningTimer(todo: Todo, viewModel: TodoViewModel) {
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val active = data.timeEntries.filter { !it.deleted && it.ended_at == null }
    val ref = viewModel.learningReference(todo)
    val entry = active.find { it.task_ref == ref }
    if (learning.readOnly) {
        if (entry != null) LearningClock(entry)
        return
    }
    if (!todo.deleted && entry != null) Text("计时中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
}

@Composable
fun LearningStartButton(viewModel: TodoViewModel) {
    val learning = currentLearningData(viewModel)
    val source by viewModel.activeSource.collectAsState()
    val enabled by viewModel.timeTrackingEnabled.collectAsState()
    if (!enabled || learning.readOnly || learning.data.timeEntries.any { !it.deleted && it.ended_at == null }) return
    var chooseTask by remember(source) { mutableStateOf(false) }

    IconButton(onClick = { chooseTask = true }) {
        Icon(Icons.Filled.PlayArrow, contentDescription = "开始计时", tint = MaterialTheme.colorScheme.primary)
    }
    if (chooseTask) LearningTaskPicker(viewModel, onDismiss = { chooseTask = false })
}

@Composable
fun LearningBanner(viewModel: TodoViewModel) {
    val learning = currentLearningData(viewModel)
    val source by viewModel.activeSource.collectAsState()
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val active = data.timeEntries.filter { !it.deleted && it.ended_at == null }
    var show by remember(source) { mutableStateOf(false) }
    var busy by remember(source) { mutableStateOf(false) }
    val scope = rememberCoroutineScope(); val context = LocalContext.current
    LaunchedEffect(active.map { it.id }.sorted()) { if (!learning.readOnly && active.size > 1) show = true }
    if (active.isNotEmpty()) {
        Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (active.size > 1) "${active.size} 条计时待处理" else learning.display(active.first()),
                    Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
                if (active.size == 1) {
                    if (learning.pending(active.first()) == null) LearningClock(active.first()) else Text(learning.pending(active.first()).orEmpty(), style = MaterialTheme.typography.labelSmall)
                    if (!learning.readOnly && learning.pending(active.first()) == null) TextButton(enabled = !busy, onClick = click@ {
                        if (viewModel.activeSource.value != source) return@click
                        val id = active.first().id
                        busy = true
                        scope.launch {
                            try {
                                viewModel.stopLearning(id, source).exceptionOrNull()?.let {
                                    Toast.makeText(context, it.message, Toast.LENGTH_LONG).show()
                                }
                            } finally { busy = false }
                        }
                    }) { Text("结束") }
                }
                TextButton(onClick = { show = true }) { Text(if (learning.readOnly) "查看记录" else if (active.size > 1) "处理" else "记录") }
            }
        }
    }
    if (show) LearningRecordsDialog(viewModel, active.map { it.id }, onDismiss = { show = false })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LearningTaskPicker(
    viewModel: TodoViewModel,
    onDismiss: () -> Unit,
    recordDate: LocalDate = LocalDate.now(),
    onSelectRecordTask: ((Todo) -> Unit)? = null
) {
    dismissOnSourceChange(viewModel, onDismiss)
    val learning = currentLearningData(viewModel)
    val enabled by viewModel.timeTrackingEnabled.collectAsState()
    val target = remember { viewModel.activeSource.value }
    val data = learning.data
    var other by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val today = LocalDate.now()
    val reassigning = onSelectRecordTask != null
    LaunchedEffect(enabled, learning.readOnly, data.timeEntries) {
        if (!enabled || learning.readOnly || (!reassigning && data.timeEntries.any { !it.deleted && it.ended_at == null })) onDismiss()
    }
    val choices = remember(data, recordDate, reassigning) {
        if (reassigning) Learning.recordTaskChoices(data, recordDate) else null
    }
    val recent = choices?.recent ?: Learning.recentTimingTasks(data.todos, data.timeEntries, data = data)
    val candidates = if (other) (choices?.todos ?: TaskSeriesLogic.timingTodos(data))
        .sortedWith(compareByDescending<Todo> { it.date == today.toString() }.then(TodoComparator))
        .filter { it.content.contains(search.trim(), ignoreCase = true) }
        else recent.map { it.todo }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !busy })
    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).padding(horizontal = 20.dp).padding(bottom = 20.dp)) {
            val title = when {
                !other -> "最近计时的任务"
                reassigning -> "更换所属任务"
                else -> "选择要计时的任务"
            }
            Text(title, style = MaterialTheme.typography.titleLarge)
            if (other) OutlinedTextField(search, onValueChange = { search = it }, label = { Text("搜索任务") },
                enabled = !busy, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 8.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) }
            if (!reassigning) TaskSeriesLogic.duplicateTimingSeries(data).forEach { Text("${it.content}：本期存在重复任务，请到周期关联中核对") }
            if (candidates.isEmpty()) {
                val message = when {
                    other && reassigning -> "暂无匹配的任务"
                    other -> "暂无匹配的可计时任务"
                    reassigning -> "暂无最近计时的任务，请选择其他任务"
                    else -> "暂无可继续计时的最近任务，请选择其他任务"
                }
                SupportingText(message, modifier = Modifier.padding(vertical = 16.dp))
            }
            LazyColumn(Modifier.weight(1f, fill = false)) {
                items(candidates, key = { it.id }) { todo ->
                    TextButton(enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp), onClick = click@ {
                        if (busy || viewModel.activeSource.value != target || !viewModel.timeTrackingEnabled.value) return@click
                        if (onSelectRecordTask != null) {
                            onSelectRecordTask(todo)
                            return@click
                        }
                        busy = true; error = null
                        scope.launch {
                            try {
                                val result = viewModel.startLearning(todo, target)
                                if (result.isSuccess) onDismiss()
                                else error = result.exceptionOrNull()?.message ?: "开始计时失败，请重试"
                            } finally { busy = false }
                        }
                    }) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(todo.content)
                            if (reassigning) todo.date?.let { SupportingText(it) }
                            if (!other) recent.find { it.todo.id == todo.id }?.let {
                                Text(Learning.lastTimedText(it.endedAt), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(enabled = !busy, onClick = { other = !other; search = "" }) { Text(if (other) "返回最近任务" else "选择其他任务") }
                TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") }
            }
        }
    }
}

@Composable
fun LearningRecordsDialog(viewModel: TodoViewModel, ids: List<String>, onDismiss: () -> Unit) {
    dismissOnSourceChange(viewModel, onDismiss)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || currentLearningData(viewModel).readOnly
    if (!timingEnabled) return
    AlertDialog(onDismissRequest = onDismiss, title = { Text("计时记录") }, text = {
        Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
            if (!currentLearningData(viewModel).readOnly) SupportingText("有多条运行记录时，请补上真实结束时间或删除误开记录。")
            LearningRecords(viewModel, ids = ids)
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

@Composable
fun LearningTaskRecords(viewModel: TodoViewModel, todo: Todo, initiallyExpanded: Boolean = false) {
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val ref = viewModel.learningReference(todo)
    val records = data.timeEntries.filter { !it.deleted && it.task_ref == ref }
    val parts = remember(records, learning.conflicts) { records.filter { it.id !in learning.conflicts }.flatMap { Learning.split(it) } }
    val conflicts = learning.conflicts
    var show by rememberSaveable(todo.id) { mutableStateOf(false) }
    val summaryText = "${Learning.duration(parts.sumOf { it.duration })} · ${parts.size} 次" +
        (if (records.any { it.ended_at == null && learning.pending(it) == null }) " · 进行中" else "") +
        (if (records.any { it.id in conflicts || learning.pending(it) != null }) " · 待核对" else "")
    EditDetailSection("计时记录", "关联计时：" + summaryText, initiallyExpanded = initiallyExpanded) {
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
    val resolved = remember(data.timeEntries, tasks, data.taskSeries, data.taskSeriesLinks) { Learning.resolveEntries(data.timeEntries, tasks, data, learning.sourceId).associateBy { it.id } }
    val scope = rememberCoroutineScope(); val context = LocalContext.current
    val ref = todo?.let { viewModel.learningReference(it) }
    var editing by remember { mutableStateOf<TimeEntry?>(null) }
    var supplementing by remember { mutableStateOf(false) }
    val records = data.timeEntries.filter { !it.deleted && (ids?.contains(it.id) ?: (it.task_ref == ref)) }
        .sortedWith(compareBy<TimeEntry> { it.ended_at != null }.thenByDescending { it.started_at })
    if (todo != null && !learning.readOnly) {
        TextButton(onClick = {
            val now = nowIso()
            supplementing = true
            editing = TimeEntry(UUID.randomUUID().toString(), ref!!, now, now, now, todo.content, todo.label, now)
        }) { Text("补录计时记录") }
    }
    records.forEach { entry ->
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text("${learning.display(entry)} · ${resolved[entry.id]?.label_snapshot ?: "未分类"}${if (entry.task_ref !in tasks) " · 原任务不可用" else if (tasks[entry.task_ref]?.deleted == true || (entry.task_ref.source_type == "personal" && entry.task_ref.source_id == null && TaskSeriesLogic.isDeleted(data, entry.task_ref.todo_id))) " · 原任务已删除" else ""}", style = MaterialTheme.typography.bodyLarge)
            Text("开始：${displayLearningTime(entry.started_at)}", style = MaterialTheme.typography.bodyMedium)
            Text("结束：${entry.ended_at?.let(::displayLearningTime) ?: learning.pending(entry) ?: "进行中"}", style = MaterialTheme.typography.bodyMedium)
            if (entry.ended_at != null) SupportingText(Learning.duration((Learning.instant(entry.ended_at)?.toEpochMilli() ?: 0) - (Learning.instant(entry.started_at)?.toEpochMilli() ?: 0)))
            if (entry.id in learning.conflicts) Text("待核对：与其他计时重叠，未计入统计")
            if (!learning.readOnly) Row {
                TextButton(onClick = { supplementing = false; editing = entry }) { Text("编辑记录") }
                TextButton(onClick = click@ {
                    if (viewModel.activeSource.value != source) return@click
                    scope.launch {
                        viewModel.saveTimeEntry(entry.copy(deleted = true), source).exceptionOrNull()?.let { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                    }
                }) { Text("删除") }
                if (entry.ended_at == null && learning.pending(entry) == null && records.count { it.ended_at == null } == 1) {
                    TextButton(onClick = click@ {
                        if (viewModel.activeSource.value != source) return@click
                        scope.launch { viewModel.stopLearning(entry.id, source).exceptionOrNull()?.let { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() } }
                    }) { Text("结束") }
                }
            }
            HorizontalDivider()
        }
    }
    editing?.let { entry -> TimeEntryEditor(entry, viewModel, isNew = supplementing) { editing = null } }
}

private fun displayLearningTime(value: String): String = Learning.instant(value)?.atZone(ZoneId.systemDefault())
    ?.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")) ?: value

@Composable
internal fun TimeEntryEditor(entry: TimeEntry, viewModel: TodoViewModel, isNew: Boolean = false, onDismiss: () -> Unit) {
    val baseline = remember(entry.id) { entry }
    val source = remember { viewModel.activeSource.value }
    val currentSource by viewModel.activeSource.collectAsState()
    LaunchedEffect(currentSource) { if (currentSource != source) onDismiss() }
    val learning = currentLearningData(viewModel)
    if (learning.readOnly) { LearningRecordsDialog(viewModel, listOf(entry.id), onDismiss); return }
    val initialStart = remember(baseline) { displayLearningTime(baseline.started_at) }
    val initialEnd = remember(baseline) { baseline.ended_at?.let(::displayLearningTime).orEmpty() }
    var start by rememberSaveable(baseline.id) { mutableStateOf(initialStart) }
    var end by rememberSaveable(baseline.id) { mutableStateOf(initialEnd) }
    var selectedTaskId by rememberSaveable(baseline.id) { mutableStateOf<String?>(null) }
    var choosingTask by rememberSaveable(baseline.id) { mutableStateOf(false) }
    val data = learning.data
    val tasks = learning.tasks
    val selectedTask = selectedTaskId?.let { id ->
        data.todos.find { it.id == id && !it.deleted && !TaskSeriesLogic.isDeleted(data, id) }
    }
    val taskName = when {
        selectedTask != null -> TaskSeriesLogic.display(data, selectedTask.id)
        selectedTaskId != null -> "所选任务已不可用"
        else -> learning.display(baseline)
    }
    val currentLabel = if (selectedTaskId != null) Learning.label(selectedTask?.label) else {
        val entries = if (isNew) data.timeEntries + baseline else data.timeEntries
        Learning.resolveEntries(entries, tasks).find { it.id == baseline.id }?.label_snapshot
    }
    var error by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(if (isNew) "补录计时记录" else "编辑计时记录") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("所属任务：$taskName")
            if (!isNew) TextButton(enabled = !busy, onClick = { choosingTask = true }) { Text("更换任务") }
            SupportingText("日期和时间格式：2026-09-10 09:30:00")
            OutlinedTextField(start, { start = it }, label = { Text("开始日期和时间") }, enabled = !busy)
            OutlinedTextField(end, { end = it }, label = { Text("结束日期和时间（运行中可留空）") }, enabled = !busy)
            Text("所属任务标签：${currentLabel ?: "未分类"}（在任务编辑页修改）", style = MaterialTheme.typography.bodyMedium)
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = click@ {
        if (viewModel.activeSource.value != source) { onDismiss(); return@click }
        scope.launch {
            busy = true
            try {
                fun parse(text: String) = LocalDateTime.parse(text.trim().replace(' ', 'T')).atZone(ZoneId.systemDefault()).toInstant().toString()
                val draft = baseline.copy(
                    task_ref = selectedTaskId?.let { TaskReference(it) } ?: baseline.task_ref,
                    started_at = if (start == initialStart) baseline.started_at else parse(start),
                    ended_at = if (end == initialEnd) baseline.ended_at else end.takeIf { it.isNotBlank() }?.let(::parse)
                )
                val result = viewModel.saveTimeEntry(draft, source, expected = baseline.takeUnless { isNew })
                if (result.isSuccess) onDismiss() else error = result.exceptionOrNull()?.message ?: "保存失败"
            } catch (_: DateTimeException) { error = "请输入有效的日期和时间" } finally { busy = false }
        }
    }) { Text("保存记录") } }, dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") } })
    if (choosingTask) {
        val recordDate = runCatching { LocalDateTime.parse(start.trim().replace(' ', 'T')).toLocalDate() }.getOrNull()
            ?: Learning.instant(baseline.started_at)?.atZone(ZoneId.systemDefault())?.toLocalDate() ?: LocalDate.now()
        LearningTaskPicker(viewModel, onDismiss = { choosingTask = false }, recordDate = recordDate, onSelectRecordTask = { todo ->
            selectedTaskId = todo.id.takeUnless { TaskReference(it) == baseline.task_ref }
            choosingTask = false
        })
    }
}

@Composable
internal fun CollapsibleInsightText(text: String, lines: Int, hasMore: Boolean = false, full: (@Composable () -> Unit)? = null) {
    var expanded by remember(text) { mutableStateOf(false) }
    var overflow by remember(text) { mutableStateOf(false) }
    if (expanded && full != null) full()
    else Text(text, maxLines = if (expanded) Int.MAX_VALUE else lines, overflow = TextOverflow.Ellipsis,
        onTextLayout = { if (!expanded) overflow = it.hasVisualOverflow })
    if (hasMore || overflow) TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起" else "展开") }
}

@Composable
internal fun LearningInsightsSummary(viewModel: TodoViewModel, period: String, targetDate: LocalDate) {
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    if (!timingEnabled) return
    val data = learning.data
    val tasks = learning.tasks
    val resolved = remember(data.timeEntries, tasks, data.taskSeries, data.taskSeriesLinks) { Learning.resolveEntries(data.timeEntries, tasks, data, learning.sourceId) }
    val (start, end) = Learning.range(period, targetDate)
    var selectedLabel by remember(learning.sourceId) { mutableStateOf<String?>(null) }
    LaunchedEffect(resolved, selectedLabel) {
        if (selectedLabel != null && resolved.none { !it.deleted && (it.label_snapshot ?: "未分类") == selectedLabel }) selectedLabel = null
    }
    var showLabels by remember { mutableStateOf(false) }
    var details by remember(learning.sourceId, period, targetDate) { mutableStateOf(false) }
    var recordIds by remember { mutableStateOf<List<String>?>(null) }
    val summary = remember(resolved, learning.conflicts, start, end) { Learning.summary(resolved, start, end, conflicts = learning.conflicts) }
    SupportingText(if (summary.count == 0) "暂无学习记录" else "学习：已记录 ${Learning.duration(summary.duration)}")
    TextButton(onClick = { details = true }) { Text("查看投入详情") }
    if (summary.running > 0) TextButton(onClick = {
        val endTime = end.atStartOfDay(ZoneId.systemDefault()).toInstant()
        recordIds = resolved.filter { !it.deleted && it.ended_at == null && it.pending_reason == null &&
            Learning.instant(it.started_at)?.isBefore(endTime) == true }.map { it.id }
    }) { Text("${summary.running} 条进行中，尚未计入汇总") }
    if (summary.pending > 0) TextButton(onClick = { recordIds = learning.pendingIds(start, end) }) { Text("${summary.pending} 条待核对记录未计入 · 查看") }
    if (details) {
        val filtered = remember(summary, resolved, selectedLabel) {
            if (selectedLabel == null) summary else Learning.summary(resolved, start, end, selectedLabel = selectedLabel, conflicts = learning.conflicts)
        }
        AlertDialog(onDismissRequest = { details = false }, title = { Text("学习投入详情") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Box {
                    TextButton(onClick = { showLabels = true }) { Text(selectedLabel ?: "全部标签") }
                    DropdownMenu(showLabels, { showLabels = false }) {
                        (listOf<String?>(null) + resolved.filterNot { it.deleted }.map { it.label_snapshot ?: "未分类" }.distinct().sorted()).forEach { label ->
                            DropdownMenuItem(text = { Text(label ?: "全部标签") }, onClick = { selectedLabel = label; showLabels = false })
                        }
                    }
                }
                Text("${Learning.duration(filtered.duration)} · ${filtered.count} 次")
                filtered.groups.forEach { group ->
                    TextButton(onClick = { recordIds = filtered.parts.filter { (it.entry.label_snapshot ?: "未分类") == group.label }.map { it.entry.id }.distinct() }) {
                        Text("${group.label} · ${Learning.duration(group.duration)} · ${group.count} 次")
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = { details = false }) { Text("关闭") } })
    }
    recordIds?.let { LearningRecordsDialog(viewModel, it) { recordIds = null } }
}

@Composable
internal fun LearningInsights(
    viewModel: TodoViewModel, period: String, targetDate: LocalDate,
    planning: PersonalPlanningState?, navigation: InsightsNavigation, openWeek: (LocalDate) -> Unit
) {
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val (start, end) = Learning.range(period, targetDate)
    var reviewDate by rememberSaveable { mutableStateOf<String?>(null) }
    var showExport by remember { mutableStateOf(false) }
    Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        Column(Modifier.padding(14.dp)) {
            val daily = period == "day" && !learning.readOnly
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (daily) "计划与回顾" else if (learning.readOnly) "每日复盘" else "我的复盘",
                    style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                if (daily) TextButton(onClick = { reviewDate = start.toString() }) { Text("编辑") }
                else TextButton(onClick = { showExport = true }) { Text("导出 Markdown") }
            }
            if (period == "day" && planning != null && !learning.readOnly) {
                key(targetDate) { DailyPlanReference(planning, targetDate) }
                DailyRating(planning, targetDate)
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Text("复盘", style = MaterialTheme.typography.labelLarge)
            }
            val reviews = data.dailyReviews.filter { !it.deleted && it.date >= start.toString() && it.date < end.toString() }.sortedByDescending { it.date }
            if (period == "day") {
                val review = reviews.firstOrNull()
                if (review == null) SupportingText(if (daily) "尚未填写，可通过编辑记录" else "暂无复盘")
                else {
                    val fields = Learning.fields(review)
                    val filled = fields.filter { it.second.isNotBlank() }
                    if (daily) CollapsibleInsightText(Learning.preview(review), 2,
                        hasMore = filled.size > 1 || filled.firstOrNull()?.second?.lines()?.size?.let { it > 2 } == true) {
                        fields.forEach { (name, value) ->
                            Text(name, style = MaterialTheme.typography.labelLarge)
                            Text(value.ifBlank { "未填写" }, Modifier.padding(bottom = 8.dp))
                        }
                    } else fields.forEach { (name, value) ->
                        Text(name, style = MaterialTheme.typography.labelLarge)
                        Text(value.ifBlank { "未填写" }, Modifier.padding(bottom = 8.dp))
                    }
                }
            } else {
                if (reviews.isEmpty()) SupportingText("这个时间范围还没有复盘")
                reviews.forEach { review -> TextButton(onClick = { reviewDate = review.date }) {
                    Column(Modifier.fillMaxWidth()) { Text(review.date); Text(Learning.preview(review), maxLines = 2, overflow = TextOverflow.Ellipsis) }
                } }
            }
        }
    }
    reviewDate?.let { date ->
        DailyReviewDialog(viewModel, date, planning, navigation, openWeek, period == "day" && !learning.readOnly) { reviewDate = null }
    }
    if (showExport) ReviewExportDialog(viewModel, data, period, targetDate, planning) { showExport = false }
}

@Composable
private fun DailyReviewDialog(
    viewModel: TodoViewModel, date: String, planning: PersonalPlanningState?, navigation: InsightsNavigation,
    openWeek: (LocalDate) -> Unit,
    initialEdit: Boolean,
    onDismiss: () -> Unit
) {
    val source = remember { viewModel.activeSource.value }
    val currentSource by viewModel.activeSource.collectAsState()
    val target = remember { planning?.target }
    var targetChanged by remember { mutableStateOf(false) }
    LaunchedEffect(planning?.target) { if (planning?.target != target) targetChanged = true }
    LaunchedEffect(currentSource) { if (currentSource != source) onDismiss() }
    val learning = currentLearningData(viewModel)
    val data = learning.data
    val latestReview = data.dailyReviews.find { it.date == date }
    val saved = latestReview?.takeUnless { it.deleted }
    val latestRating = planning?.rating(date)
    var reviewBaseline by remember(date) { mutableStateOf(latestReview) }
    var ratingBaseline by remember(date) { mutableStateOf(latestRating) }
    var score by remember(date) { mutableStateOf(ratingBaseline.ratingScore()) }
    var retryingRating by remember(date) { mutableStateOf(false) }
    var editing by rememberSaveable(date) { mutableStateOf(initialEdit) }
    var fact by rememberSaveable(date) { mutableStateOf(saved?.fact ?: "") }
    var obstacle by rememberSaveable(date) { mutableStateOf(saved?.obstacle ?: "") }
    var action by rememberSaveable(date) { mutableStateOf(saved?.effective_action ?: "") }
    var next by rememberSaveable(date) { mutableStateOf(saved?.next_step ?: "") }
    var baseline by rememberSaveable(date) { mutableStateOf(listOf(fact, obstacle, action, next)) }
    var leave by remember { mutableStateOf(false) }; var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }; var exporting by remember { mutableStateOf(false) }
    var exportChoice by remember { mutableStateOf(false) }
    var nextNavigation by remember { mutableStateOf<(() -> Unit)?>(null) }
    var goingToWeek by remember { mutableStateOf(false) }
    var rebase by remember { mutableStateOf(false) }
    val reviewDirty = editing && listOf(fact, obstacle, action, next) != baseline
    val ratingDirty = editing && ratingBaseline != null && score != ratingBaseline.ratingScore()
    val dirty = reviewDirty || ratingDirty || retryingRating
    val scope = rememberCoroutineScope()
    LaunchedEffect(latestRating) {
        if (ratingBaseline == null && !targetChanged) {
            ratingBaseline = latestRating
            score = latestRating.ratingScore()
        }
    }
    fun dismiss() {
        onDismiss()
        nextNavigation?.invoke()
        nextNavigation = null
    }
    fun requestLeave(next: (() -> Unit)? = null, week: Boolean = false) {
        if (busy || leave || rebase || exportChoice) return
        nextNavigation = next
        goingToWeek = week
        if (dirty) leave = true else dismiss()
    }
    RegisterInsightsGuard(navigation, true) { requestLeave(it) }
    fun save(close: Boolean, exportAfter: Boolean = false) {
        if (viewModel.activeSource.value != source) { error = "清单已切换，请重新打开"; return }
        if (targetChanged || planning?.target != target) { error = "个人清单已切换，请重新打开复盘"; return }
        val fields = listOf(fact, obstacle, action, next)
        if (reviewDirty && fields.none { it.isNotBlank() }) { error = "请至少填写一项复盘内容"; return }
        busy = true
        scope.launch {
            try {
                val successes = mutableListOf<String>()
                val failures = mutableListOf<String>()
                val expectedRating = ratingBaseline
                if ((ratingDirty || retryingRating) && planning != null && expectedRating != null) {
                    val result = planning.saveRating(date, score, expectedRating, retryingRating)
                    retryingRating = result.pending
                    if (result.error.isEmpty()) {
                        ratingBaseline = result.record
                        score = result.record.ratingScore()
                        successes.add("评分已保存")
                    } else failures.add("评分未保存 · ${result.error}")
                }
                if (reviewDirty) {
                    val now = nowIso()
                    val draft = DailyReview(reviewBaseline?.id ?: UUID.randomUUID().toString(), date,
                        reviewBaseline?.created_at ?: now, now, fields[0], fields[1], fields[2], fields[3])
                    viewModel.saveDailyReview(draft, source, reviewBaseline, target).fold(
                        onSuccess = {
                            reviewBaseline = it
                            baseline = fields
                            successes.add("复盘已保存")
                        },
                        onFailure = { failures.add("复盘未保存 · ${it.message ?: "请重试"}") }
                    )
                }
                error = if (failures.isEmpty()) "" else (successes + failures).joinToString("。")
                if (failures.isEmpty()) {
                    leave = false
                    exportChoice = false
                    if (exportAfter) exporting = true
                    if (close) dismiss()
                }
            } finally { busy = false }
        }
    }
    Dialog(onDismissRequest = { requestLeave() }) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(16.dp).heightIn(max = 620.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("$date · ${if (editing) "编辑当日回顾" else "每日复盘"}", style = MaterialTheme.typography.titleMedium)
                if (targetChanged) Text("个人清单已切换，请重新打开复盘", color = MaterialTheme.colorScheme.error)
                else if (!learning.readOnly && planning != null) {
                    val navigateToWeek: (() -> Unit)? = if (editing) {
                        { requestLeave({ openWeek(LocalDate.parse(date)) }, week = true) }
                    } else null
                    DailyPlanReference(planning, LocalDate.parse(date), navigateToWeek)
                }
                if (editing) {
                    Text("当日评分", style = MaterialTheme.typography.labelLarge)
                    if (ratingBaseline == null) SupportingText("评分暂不可用")
                    else {
                        Row(Modifier.fillMaxWidth()) {
                            for (value in 1..5) FilterChip(
                                selected = score == value, enabled = !busy && !retryingRating && planning?.pendingRating != true,
                                onClick = { score = value }, label = { Text(value.toString()) },
                                modifier = Modifier.weight(1f).padding(horizontal = 2.dp).semantics { contentDescription = "$value 分" }
                            )
                        }
                        TextButton(enabled = !busy && !retryingRating && score != null && planning?.pendingRating != true,
                            onClick = { score = null }) { Text("清除评分") }
                    }
                    OutlinedTextField(fact, { fact = it }, label = { Text("事实") }, placeholder = { Text("今天推进了什么？理解、推导、例子、明确卡点都算。") }, enabled = !busy, minLines = 2)
                    OutlinedTextField(obstacle, { obstacle = it }, label = { Text("卡点") }, placeholder = { Text("拖延或中断发生在哪里？当时发生了什么？") }, enabled = !busy, minLines = 2)
                    OutlinedTextField(action, { action = it }, label = { Text("有效动作") }, placeholder = { Text("什么帮助你开始或回到任务？") }, enabled = !busy, minLines = 2)
                    OutlinedTextField(next, { next = it }, label = { Text("下一步") }, placeholder = { Text("明天想保留什么，或只调整什么？") }, enabled = !busy, minLines = 2)
                    if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                    if ("已更新" in error && !retryingRating) TextButton(enabled = !busy, onClick = { rebase = true }) { Text("核对最新内容") }
                    Row { TextButton(enabled = !busy && !targetChanged, onClick = { save(true) }) { Text("保存") }
                        TextButton(enabled = !busy, onClick = { requestLeave() }) { Text("取消") }
                        TextButton(enabled = !busy, onClick = { if (dirty) exportChoice = true else exporting = true }) { Text("导出") } }
                } else {
                    saved?.let { Learning.fields(it).forEach { (title, value) -> Text(title, style = MaterialTheme.typography.labelLarge); Text(value.ifBlank { "未填写" }) } }
                    Row {
                        if (!learning.readOnly) TextButton(onClick = {
                            reviewBaseline = latestReview
                            ratingBaseline = latestRating
                            score = latestRating.ratingScore()
                            fact = saved?.fact.orEmpty(); obstacle = saved?.obstacle.orEmpty()
                            action = saved?.effective_action.orEmpty(); next = saved?.next_step.orEmpty()
                            baseline = listOf(fact, obstacle, action, next)
                            editing = true
                        }) { Text("编辑") }
                        TextButton(onClick = { exporting = true }) { Text("导出") }
                    }
                }
                TextButton(enabled = !busy, onClick = { requestLeave() }) { Text("关闭") }
            }
        }
    }
    if (leave) AlertDialog(onDismissRequest = { if (!busy) { leave = false; nextNavigation = null } }, title = { Text("当日回顾有未保存的修改") }, text = {
        Column {
            TextButton(enabled = !busy && !targetChanged, onClick = { save(true) }) { Text(if (goingToWeek) "保存并前往" else "保存并离开") }
            TextButton(enabled = !busy, onClick = { dismiss() }) { Text(if (goingToWeek) "放弃修改并前往" else "放弃修改") }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = { leave = false; nextNavigation = null }) { Text("继续编辑") } })
    if (rebase) {
        val currentFields = listOf(saved?.fact.orEmpty(), saved?.obstacle.orEmpty(), saved?.effective_action.orEmpty(), saved?.next_step.orEmpty())
        AlertDialog(onDismissRequest = { rebase = false }, title = { Text("核对最新内容") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("最新评分：${latestRating.ratingScore() ?: "未评分"}")
                listOf("事实", "卡点", "有效动作", "下一步").zip(currentFields).forEach { (name, value) ->
                    Text("$name：${value.ifBlank { "未填写" }}")
                }
            }
        }, confirmButton = { TextButton(onClick = {
            if (!ratingDirty) score = latestRating.ratingScore()
            if (!reviewDirty) {
                fact = currentFields[0]; obstacle = currentFields[1]; action = currentFields[2]; next = currentFields[3]
            }
            ratingBaseline = latestRating
            reviewBaseline = latestReview
            baseline = currentFields
            rebase = false
            error = ""
        }) { Text("保留草稿并采用最新基线") } }, dismissButton = { TextButton(onClick = { rebase = false }) { Text("继续编辑") } })
    }
    if (exportChoice) AlertDialog(onDismissRequest = { if (!busy) exportChoice = false }, title = { Text("有未保存的当日回顾修改") }, text = {
        Column {
            TextButton(enabled = !busy, onClick = { save(false, exportAfter = true) }) { Text("保存后导出") }
            TextButton(enabled = !busy, onClick = { exportChoice = false; exporting = true }) { Text("仅导出已保存内容") }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = { exportChoice = false }) { Text("取消") } })
    if (exporting && !targetChanged) ReviewExportDialog(viewModel, data, "day", LocalDate.parse(date), planning) { exporting = false }
}

@Composable
internal fun ReviewExportDialog(
    viewModel: TodoViewModel, data: TodoData, period: String, date: LocalDate,
    planning: PersonalPlanningState?, onDismiss: () -> Unit
) {
    dismissOnSourceChange(viewModel, onDismiss)
    val learning = currentLearningData(viewModel)
    val personalTimingEnabled by viewModel.timeTrackingEnabled.collectAsState()
    val timingEnabled = personalTimingEnabled || learning.readOnly
    val tasks = learning.tasks
    val target = remember { planning?.target }
    LaunchedEffect(planning?.target) { if (planning?.target != target) onDismiss() }
    var range by rememberSaveable(period) { mutableStateOf(period) }
    var plans by rememberSaveable { mutableStateOf(false) }
    var ratings by rememberSaveable { mutableStateOf(false) }
    var history by rememberSaveable { mutableStateOf(false) }
    var include by remember { mutableStateOf(true) }; var content by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf("") }; var savedUri by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }; val context = LocalContext.current; val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        if (uri == null) busy = false
        if (uri != null) scope.launch {
            busy = true
            try {
                withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(content.toByteArray(Charsets.UTF_8)) } ?: error("无法打开文件") }
                savedUri = uri.toString(); error = ""; Toast.makeText(context, "文件已保存", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) { error = "导出失败：${e.message}" } finally { busy = false }
        }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text("导出复盘 Markdown") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            if (planning != null && !learning.readOnly) {
                Row {
                    for ((value, label) in listOf("day" to "当天", "week" to "本周", "month" to "本月")) {
                        FilterChip(selected = range == value, onClick = { range = value }, label = { Text(label) },
                            modifier = Modifier.padding(end = 4.dp), enabled = !busy)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(plans, { plans = it }); Text("计划") }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(ratings, { ratings = it }); Text("评分") }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(history, { history = it }); Text("计划历史及调整原因") }
                if ((plans || ratings || history) && planning.loadError) TextButton(onClick = planning.reload) { Text("重试读取计划与评分") }
            }
            if (timingEnabled) {
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(include, { include = it }); Text("附带当日学习时长统计" + if (range == "day") "" else "（逐日）") }
                SupportingText("进行中和待核对记录不计入统计。")
            }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
            savedUri?.let { uri -> TextButton(onClick = {
                val intent = Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_STREAM, Uri.parse(uri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                context.startActivity(Intent.createChooser(intent, "分享复盘文件"))
            }) { Text("分享已导出文件") } }
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = {
        try {
            if (planning?.target != target) { onDismiss(); return@TextButton }
            val extras = if (plans || ratings || history) {
                val snapshot = requireNotNull(planning?.data) { "计划与评分暂不可用，请重试或取消相关选项" }
                val (start, end) = Learning.range(range, date)
                WeeklyPlanning.export(snapshot, start, end, WeeklyPlanning.ExportOptions(plans, ratings, history))
            } else null
            val result = Learning.export(data, range, date, timingEnabled && include, tasks = tasks,
                conflicts = learning.conflicts, sourceId = learning.sourceId, planning = extras)
            content = result.second
            error = ""
            busy = true
            launcher.launch(result.first)
        } catch (e: Exception) { busy = false; error = e.message ?: "导出失败" }
    }) { Text("保存文件") } }, dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("关闭") } })
}
