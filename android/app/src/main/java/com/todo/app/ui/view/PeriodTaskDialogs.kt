package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.todo.app.data.model.*
import com.todo.app.ui.viewmodel.TodoViewModel
import kotlinx.coroutines.launch
import java.time.*

@Composable
private fun PeriodDialog(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(shape = MaterialTheme.shapes.medium) {
            Column(Modifier.fillMaxWidth().heightIn(max = 620.dp).padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge)
                content()
                TextButton(onClick = onDismiss) { Text("关闭") }
            }
        }
    }
}

@Composable
fun PeriodImportDialog(type: String, viewModel: TodoViewModel, onDismiss: () -> Unit) {
    val data by viewModel.todoData.collectAsState()
    val candidates = remember { TaskSeriesLogic.candidates(data, type) }
    val target = remember { TaskSeriesLogic.current(type) }
    val previous = remember { TaskSeriesLogic.current(type, TaskSeriesLogic.range(target)!!.first.minusDays(1)) }
    var showEarlier by remember { mutableStateOf(false) }
    val references = remember { mutableStateMapOf<String, Todo?>().apply { candidates.forEach { put(it.key, it.reference) } } }
    val selected = remember { mutableStateMapOf<String, Boolean>().apply { candidates.forEach { put(it.key, it.reference?.date == previous && !it.exists) } } }
    var search by remember { mutableStateOf("") }; var error by remember { mutableStateOf<String?>(null) }; var busy by remember { mutableStateOf(false) }
    val allocated = remember { mutableListOf<String>() }
    var requested by remember { mutableStateOf<List<Todo>>(emptyList()) }
    var operationTime by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val source = remember { viewModel.activeSource.value }
    LaunchedEffect(viewModel.activeSource.collectAsState().value) { if (viewModel.activeSource.value != source) onDismiss() }
    val visibleCandidates = candidates.filter { (showEarlier || it.choices.any { todo -> todo.date == previous }) && it.content.contains(search.trim()) }
    PeriodDialog("从往期导入 ${if (type == "week") "周任务" else "月任务"}", onDismiss) {
        OutlinedTextField(search, { search = it }, label = { Text("搜索任务") })
        if (visibleCandidates.isEmpty()) Text(when {
            search.isNotBlank() -> "没有匹配的任务"
            showEarlier -> "暂无可导入的往期任务"
            else -> "上一期暂无可导入的任务"
        })
        visibleCandidates.forEach { candidate ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(selected[candidate.key] == true, { selected[candidate.key] = it }, enabled = !candidate.exists && references[candidate.key] != null && !busy)
                Text(candidate.content + if (candidate.exists) " · 本期已存在" else "")
            }
            if (TaskSeriesLogic.series(data, candidate.choices.first().id) != null) {
                Text("长期任务 · 导入后自动关联", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val referenceOptions = candidate.choices.filter { showEarlier || it.date == previous }.map { todo ->
                val duplicate = candidate.choices.count { it.date == todo.date } > 1
                PeriodSelectOption(todo.id, "${TaskSeriesLogic.description(todo.date.orEmpty())} · 目标 ${todo.targetCount ?: "未设置"}${if (duplicate) " · 重复，不可使用" else ""}", !duplicate)
            }
            PeriodPicker("参考期", references[candidate.key]?.id, referenceOptions, enabled = !candidate.exists && !busy) { id ->
                references[candidate.key] = candidate.choices.first { it.id == id }
                selected[candidate.key] = true
            }
            if (data.todos.any { !it.deleted && it.date == target && TaskSeriesLogic.series(data, it.id) == null && TaskSeriesLogic.name(it.content) == TaskSeriesLogic.name(candidate.content) }) Text("本期已有同名独立任务，可通过周期关联核对；仍可导入不同任务。")
            HorizontalDivider()
        }
        if (!showEarlier && candidates.any { it.choices.any { todo -> todo.date.orEmpty() < previous } }) {
            TextButton(enabled = !busy, onClick = { showEarlier = true }) { Text("显示更早期任务") }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy, onClick = {
            val chosen = candidates.filter { selected[it.key] == true }.mapNotNull { references[it.key] }
            if (chosen.isNotEmpty()) scope.launch {
                busy = true
                if (requested != chosen) { requested = chosen; allocated.clear(); operationTime = nowIso() }
                val result = viewModel.changePeriods { latest ->
                    require(TaskSeriesLogic.current(type) == target) { "当前周期已变化，请重新打开" }
                    var index = 0
                    TaskSeriesLogic.import(latest, chosen, target, operationTime ?: nowIso()) {
                        if (index == allocated.size) allocated.add(java.util.UUID.randomUUID().toString())
                        allocated[index++]
                    }
                }
                busy = false
                if (result.isSuccess) onDismiss() else error = result.exceptionOrNull()?.message
            }
        }) { Text("导入选中项") }
    }
}

@Composable
fun PeriodAssociationDialog(todoId: String, viewModel: TodoViewModel, onSaved: () -> Unit = {}, onDismiss: () -> Unit) {
    val data by viewModel.todoData.collectAsState()
    val todo = data.todos.find { it.id == todoId } ?: return
    val selected = remember { mutableStateMapOf(todoId to true) }
    val reservedId = remember { java.util.UUID.randomUUID().toString() }
    var search by remember { mutableStateOf("") }; var error by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf<AssociationPreview?>(null) }; var selection by remember { mutableStateOf<Set<String>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var unlinkRequest by remember { mutableStateOf<PeriodUnlinkPreview?>(null) }
    val unlinkIds = remember { mutableListOf<String>() }
    var showPicker by remember { mutableStateOf(false) }
    var showEarlier by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    val summary = TaskSeriesLogic.associationSummary(data, todoId)
    val kind = if (TaskSeriesLogic.type(todo) == "week") "周任务" else "月任务"
    val scope = rememberCoroutineScope()
    PeriodDialog("周期关联", onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${if (summary.series == null) "独立" else "长期"}$kind · ${TaskSeriesLogic.display(data, todoId)}", style = MaterialTheme.typography.titleMedium)
            if (summary.series != null) {
                TextButton(onClick = { showHistory = true }, contentPadding = PaddingValues(0.dp)) {
                    Text("始于 ${summary.periods.firstOrNull()?.let { TaskSeriesLogic.range(it)?.first } ?: "—"} · 共 ${summary.periods.size} 期 ›")
                }
            } else Text("尚未关联往期任务", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(when {
                summary.unlinkedSameName.isNotEmpty() -> "还有 ${summary.unlinkedSameName.size} 个同名${kind}未关联"
                summary.sameNameCount > 0 -> "✓ 已关联全部同名$kind"
                else -> "暂无其他同名$kind"
            }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        HorizontalDivider()
        if (summary.unlinkedSameName.isNotEmpty()) Button(enabled = !busy, onClick = {
            selection = null; preview = TaskSeriesLogic.preview(data, todoId)
        }) { Text("关联同名任务") }
        OutlinedButton(enabled = !busy, onClick = { showPicker = !showPicker }) { Text("关联其他任务") }
        if (showPicker) {
            OutlinedTextField(search, { search = it }, label = { Text("搜索往期任务") }, modifier = Modifier.fillMaxWidth())
            val previous = TaskSeriesLogic.current(requireNotNull(TaskSeriesLogic.type(todo)), TaskSeriesLogic.range(todo.date.orEmpty())!!.first.minusDays(1))
            val candidates = data.todos.filter { it.id != todoId && !it.deleted && TaskSeriesLogic.type(it) == TaskSeriesLogic.type(todo)
                && TaskSeriesLogic.range(it.date.orEmpty()) != null && TaskSeriesLogic.series(data, it.id)?.deleted != true
                && (summary.series == null || TaskSeriesLogic.series(data, it.id)?.id != summary.series.id) }.sortedByDescending { it.date }
            val visible = candidates.filter { (showEarlier || search.isNotBlank() || it.date.orEmpty() >= previous) && TaskSeriesLogic.display(data, it.id).contains(search.trim()) }
            if (visible.isEmpty()) Text("没有可选任务", style = MaterialTheme.typography.bodySmall)
            visible.forEach { candidate ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(selected[candidate.id] == true, { selected[candidate.id] = it }, enabled = !busy)
                    Text("${TaskSeriesLogic.display(data, candidate.id)} · ${candidate.date}")
                }
            }
            if (!showEarlier && candidates.any { it.date.orEmpty() < previous }) TextButton(onClick = { showEarlier = true }) { Text("显示更早期任务") }
            TextButton(enabled = !busy, onClick = { selection = selected.filterValues { it }.keys.toSet(); preview = TaskSeriesLogic.preview(data, todoId, selection) }) { Text("预览选中任务") }
        }
        if (summary.series != null) TextButton(enabled = !busy, onClick = { error = null; unlinkRequest = TaskSeriesLogic.unlinkPreview(data, todoId) }) { Text("解除关联") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
    if (showHistory) PeriodDialog("已关联周期", { showHistory = false }) {
        val numberStyle = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum")
        summary.periods.reversed().forEach { period ->
            val available = data.todos.any { !it.deleted && it.date == period && TaskSeriesLogic.series(data, it.id)?.id == summary.series?.id }
            val range = requireNotNull(TaskSeriesLogic.range(period))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                Text(period, modifier = Modifier.width(80.dp), style = numberStyle)
                Column(Modifier.weight(1f)) {
                    Text(range.first.toString(), style = numberStyle)
                    Text("至 ${range.second.minusDays(1)}", style = numberStyle)
                    if (!available) Text("任务已删除或不可用", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(if (period == todo.date) "本期" else "", modifier = Modifier.width(32.dp), style = numberStyle)
            }
        }
    }
    preview?.let { p ->
        val noChange = TaskSeriesLogic.series(data, todoId)?.let { s -> p.members.all { TaskSeriesLogic.series(data, it.id)?.id == s.id } } == true
        PeriodDialog("确认周期关联", { preview = null }) {
            Text("统一名称：${p.name}；${p.members.size} 条任务，${p.members.map { it.date }.distinct().size} 个周期。")
            val targetId = TaskSeriesLogic.series(data, todoId)?.id
            val existing = p.members.count { targetId != null && TaskSeriesLogic.series(data, it.id)?.id == targetId }
            Text("已关联 $existing 条，本次新增关联 ${p.members.size - existing} 条（总数包含当前任务）。")
            p.members.sortedByDescending { it.date }.forEach { Text("${it.date} · ${TaskSeriesLogic.display(data, it.id)}${if (it in p.duplicates) " · 重复" else ""}") }
            val historic = p.links.filter { l -> p.members.none { it.id == l.todo_id } }
            if (historic.isNotEmpty()) Text("另有 ${historic.size} 条历史关联将迁移：${historic.joinToString { it.period }}")
            if (p.duplicates.isNotEmpty()) Text("同一周期存在重复任务，暂不能合并")
            else if (noChange || p.members.size < 2) Text("没有需要新增的关联")
            else Button(enabled = !busy, onClick = { scope.launch {
                busy = true; val result = viewModel.changePeriods { TaskSeriesLogic.associate(it, p, selection, generate = { reservedId }) }; busy = false
                if (result.isSuccess) { onSaved(); preview = null; onDismiss() } else error = result.exceptionOrNull()?.message
            } }) { Text("确认关联，各期记录保留") }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
    unlinkRequest?.let { expected ->
        PeriodDialog("解除关联", { if (!busy) unlinkRequest = null }) {
            PeriodPicker("解除范围", if (expected.all) "all" else "one", listOf(
                PeriodSelectOption("one", "仅解除本期"), PeriodSelectOption("all", "解除整个长期任务的关联")
            ), enabled = !busy) { choice -> unlinkRequest = TaskSeriesLogic.unlinkPreview(data, todoId, choice == "all") }
            Text(if (expected.all) "共 ${expected.links.map { it.period }.distinct().size} 期将各自独立，并恢复各期自身名称。" else "本期将独立并恢复自身名称，其余各期继续关联。")
            Text("仅解除关联，保留任务、打卡和计时记录。")
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(enabled = !busy, onClick = { scope.launch {
                busy = true
                val result = viewModel.changePeriods { latest ->
                    var index = 0
                    TaskSeriesLogic.unlinkPeriods(latest, expected) {
                        if (index == unlinkIds.size) unlinkIds.add(java.util.UUID.randomUUID().toString())
                        unlinkIds[index++]
                    }
                }
                busy = false
                if (result.isSuccess) { onSaved(); unlinkRequest = null; onDismiss() } else error = result.exceptionOrNull()?.message
            } }) { Text("确认解除") }
        }
    }
}

@Composable
fun PeriodDeleteDialog(todoId: String, viewModel: TodoViewModel, onDismiss: () -> Unit, onDeleted: () -> Unit) {
    val data by viewModel.todoData.collectAsState()
    var all by remember { mutableStateOf(false) }
    val preview = remember(all) { TaskSeriesLogic.deletion(data, todoId, all) }
    var error by remember { mutableStateOf<String?>(null) }; var busy by remember { mutableStateOf(false) }; val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = onDismiss, title = { Text("删除“${TaskSeriesLogic.display(data, todoId)}”") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            if (TaskSeriesLogic.series(data, todoId) != null) Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(all, { all = it }); Text("删除全部周期") }
            Text("${preview.todos.size} 条任务，${preview.todos.map { it.date }.distinct().size} 个周期。历史计时将保留。")
            preview.todos.forEach { Text(it.date?.let(TaskSeriesLogic::description) ?: "无日期") }
            if (preview.running.isNotEmpty()) Text("确认后将结束以上任务的 ${preview.running.size} 条计时。")
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = { scope.launch {
        busy = true; val result = viewModel.changePeriods { TaskSeriesLogic.delete(it, preview) }; busy = false
        if (result.isSuccess) onDeleted() else error = result.exceptionOrNull()?.message
    } }) { Text("确认删除") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable
fun PeriodComparisonDialog(todoId: String, viewModel: TodoViewModel, onDismiss: () -> Unit) {
    val data by viewModel.todoData.collectAsState()
    val series = TaskSeriesLogic.series(data, todoId) ?: return
    val todo = data.todos.find { it.id == todoId } ?: return
    val initial = TaskSeriesLogic.range(todo.date.orEmpty()) ?: return
    val previous = TaskSeriesLogic.current(series.period_type, initial.first.minusDays(1))
    val periods = (data.taskSeriesLinks.filter { !it.deleted && it.series_id == series.id }.map { it.period } + listOf(todo.date!!, previous))
        .distinct().filter { TaskSeriesLogic.range(it) != null }.sortedDescending()
    var first by remember { mutableStateOf(todo.date!!) }; var second by remember { mutableStateOf(previous) }; var same by remember { mutableStateOf(initial.second > LocalDate.now()) }
    val now = ZonedDateTime.now()
    val current = listOf(first, second).any { p -> TaskSeriesLogic.range(p)!!.let { now.toLocalDate() >= it.first && now.toLocalDate() < it.second } }
    val ends = listOf(first, second).map { PeriodComparisonChart.end(it, same, current, now) }
    val results = listOf(first, second).mapIndexed { index, p -> TaskSeriesLogic.compare(data, series.id, p, ends[index], now.zone) }
    val days = listOf(first, second).mapIndexed { index, p -> PeriodComparisonChart.days(results[index], p, ends[index], now) }
    val options = periods.map { PeriodSelectOption(it, TaskSeriesLogic.description(it)) }
    PeriodDialog("${series.content} · 往期对比", onDismiss) {
        Text("按已保存记录比较；编辑页未保存修改不计入。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PeriodPicker("查看周期", first, options) { first = it }
        PeriodPicker("对比周期", second, options) { second = it }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = same, onClick = { same = true }, label = { Text("截至相同进度") })
            FilterChip(selected = !same, onClick = { same = false }, label = { Text("整个周期") })
        }
        Text(when {
            !current -> "所选周期不含当前周期，按各期已有记录比较。"
            same -> "两期均截至相同${if (series.period_type == "week") "星期" else "日号"}和时刻；打卡按日期比较。"
            else -> "当前周期尚未结束；对比期包含整个周期的已有记录。"
        }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            results.forEachIndexed { index, result ->
                val p = listOf(first, second)[index]
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${if (index == 0) "查看" else "对比"} · $p", style = MaterialTheme.typography.labelMedium)
                    Text(if (result.available) Learning.duration(result.duration) else "—", style = MaterialTheme.typography.titleLarge)
                    Text("打卡 ${result.count ?: "—"} / ${result.todos.singleOrNull()?.targetCount ?: "未设目标"}", style = MaterialTheme.typography.bodySmall)
                    result.todos.singleOrNull()?.targetCount?.takeIf { it > 0 }?.let { target ->
                        Text("${(result.count ?: 0) * 100 / target}% · ${if ((result.count ?: 0) >= target) "已达标" else "未达标"}", style = MaterialTheme.typography.bodySmall)
                    }
                    if (result.todos.size > 1) Text("存在重复任务，打卡待处理", style = MaterialTheme.typography.bodySmall)
                    else if (result.todos.isEmpty()) Text(if (data.taskSeriesLinks.any { it.series_id == series.id && it.period == p && !it.deleted }) "该期任务已删除或不可用" else "未导入", style = MaterialTheme.typography.bodySmall)
                    if (result.pending > 0) Text("${result.pending} 条进行中／待核对未计入", style = MaterialTheme.typography.bodySmall)
                    Text("统计至 ${ends[index].atZone(now.zone).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"))}", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        HorizontalDivider()
        val delta = results[0].duration - results[1].duration
        val durationDifference = when {
            results.any { !it.available } -> "时长差值 —"
            delta == 0L -> "总时长相同"
            else -> "时长${if (delta < 0) "少" else "多"} ${Learning.duration(kotlin.math.abs(delta))}"
        }
        Text("$durationDifference · 打卡差值 ${if (results.all { it.count != null }) results[0].count!! - results[1].count!! else "—"}", style = MaterialTheme.typography.bodyMedium)
        HorizontalDivider()
        PeriodDailyBars(days[0], days[1], series.period_type, first, second)
    }
}
