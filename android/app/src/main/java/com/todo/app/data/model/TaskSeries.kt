package com.todo.app.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import java.time.*
import java.time.temporal.ChronoUnit
import java.text.Normalizer
import java.util.UUID

@Serializable
data class TaskSeries(
    val id: String, val content: String, val content_updated_at: String,
    val period_type: String, val created_at: String, val updated_at: String,
    val content_renamed: Boolean = false, val deleted: Boolean = false, val deleted_at: String? = null
)

@Serializable
data class TaskSeriesLink(
    val todo_id: String, val series_id: String, val period: String,
    val created_at: String, val updated_at: String,
    val deleted: Boolean = false, val next_series_id: String? = null
)

data class PeriodCandidate(val key: String, val content: String, val choices: List<Todo>, val reference: Todo?, val exists: Boolean)
data class AssociationPreview(val todoId: String, val name: String, val members: List<Todo>, val links: List<TaskSeriesLink>, val duplicates: List<Todo>, val signature: String)
data class AssociationSummary(val series: TaskSeries?, val periods: List<String>, val sameNameCount: Int, val unlinkedSameName: List<Todo>)
data class PeriodUnlinkPreview(val todoId: String, val all: Boolean, val links: List<TaskSeriesLink>, val signature: String)
data class PeriodDeletePreview(val todoId: String, val all: Boolean, val seriesId: String?, val todos: List<Todo>, val running: List<TimeEntry>, val signature: String)

data class PeriodTimePart(val start: Instant, val end: Instant) {
    val duration: Long get() = Duration.between(start, end).toMillis()
}
data class PeriodComparison(val todos: List<Todo>, val dates: List<String>, val parts: List<PeriodTimePart>, val pending: Int) {
    val duration: Long get() = parts.sumOf { it.duration }
    val available: Boolean get() = todos.isNotEmpty() || parts.isNotEmpty()
    val count: Int? get() = if (todos.size == 1) dates.distinct().size else null
}

object TaskSeriesLogic {
    private val json = Json { encodeDefaults = true }
    fun type(todo: Todo): String? = when {
        todo.taskType == TaskType.WEEKLY_CHECKIN && isWeekDate(todo.date.orEmpty()) -> "week"
        todo.taskType == TaskType.MONTHLY_CHECKIN && isMonthDate(todo.date.orEmpty()) -> "month"
        else -> null
    }
    fun current(type: String, today: LocalDate = LocalDate.now()) = if (type == "week") weekStringOf(today) else monthStringOf(today)
    fun range(period: String): Pair<LocalDate, LocalDate>? = runCatching {
        if (isWeekDate(period)) {
            val year = period.take(4).toInt(); val week = period.takeLast(2).toInt()
            val jan4 = LocalDate.of(year, 1, 4)
            val start = jan4.minusDays((jan4.dayOfWeek.value - 1).toLong()).plusWeeks((week - 1).toLong())
            require(week in 1..53 && weekStringOf(start) == period)
            start to start.plusWeeks(1)
        } else {
            val start = YearMonth.parse(period).atDay(1)
            start to start.plusMonths(1)
        }
    }.getOrNull()
    fun description(period: String) = range(period)?.let { "$period · ${it.first}—${it.second.minusDays(1)}" } ?: period
    fun compare(data: TodoData, seriesId: String, period: String, end: Instant? = null, zone: ZoneId = ZoneId.systemDefault()): PeriodComparison {
        val range = requireNotNull(range(period))
        val start = range.first.atStartOfDay(zone).toInstant()
        val stop = minOf(end ?: range.second.atStartOfDay(zone).toInstant(), range.second.atStartOfDay(zone).toInstant())
        val linked = data.taskSeriesLinks.filter { !it.deleted && it.series_id == seriesId }.map { it.todo_id }.toSet()
        val entries = data.timeEntries.filter { !it.deleted && it.task_ref.source_type == "personal" && it.task_ref.source_id == null && it.task_ref.todo_id in linked }
        val conflicts = Learning.overlaps(data.timeEntries)
        val parts = entries.filter { it.id !in conflicts }.flatMap { Learning.split(it, zone) }.mapNotNull { part ->
            val a = maxOf(start, part.startedAt); val b = minOf(stop, part.endedAt)
            if (b > a) PeriodTimePart(a, b) else null
        }
        val todos = members(data, seriesId, period)
        val dates = todos.flatMap { it.completedDates }.mapNotNull { value ->
            if (value.length == 10) runCatching { LocalDate.parse(value) }.getOrNull() else Learning.instant(value)?.atZone(zone)?.toLocalDate()
        }.filter { it >= range.first && it < range.second && it <= stop.atZone(zone).toLocalDate() }.map { it.toString() }.distinct().sorted()
        val pending = entries.count { (it.ended_at == null || it.id in conflicts) && Learning.instant(it.started_at)?.isBefore(stop) == true && (it.ended_at == null || Learning.instant(it.ended_at)?.isAfter(start) == true) }
        return PeriodComparison(todos, dates, parts, pending)
    }
    fun name(value: String) = Normalizer.normalize(value.trim(), Normalizer.Form.NFC)
    private fun uuid(value: String?) = value != null && runCatching { UUID.fromString(value).toString().equals(value, true) }.getOrDefault(false)
    fun validate(data: TodoData): TodoData {
        require(data.taskSeries.map { it.id }.distinct().size == data.taskSeries.size && data.taskSeriesLinks.map { it.todo_id }.distinct().size == data.taskSeriesLinks.size) { "周期关联 ID 重复，请核对原文件" }
        data.taskSeries.forEach {
            require(uuid(it.id) && name(it.content).isNotBlank() && it.period_type in listOf("week", "month") &&
                listOf(it.created_at, it.updated_at, it.content_updated_at).all { t -> Learning.instant(t) != null } &&
                (it.deleted_at == null || Learning.instant(it.deleted_at) != null) && (!it.deleted || it.deleted_at != null)) { "任务系列格式异常，请核对原文件" }
        }
        data.taskSeriesLinks.forEach {
            require(uuid(it.todo_id) && uuid(it.series_id) && range(it.period) != null && Learning.instant(it.created_at) != null && Learning.instant(it.updated_at) != null &&
                (if (it.deleted) uuid(it.next_series_id) else it.next_series_id == null)) { "周期关联格式异常，请核对原文件" }
        }
        return data
    }
    fun series(data: TodoData, todoId: String): TaskSeries? {
        val link = data.taskSeriesLinks.find { it.todo_id == todoId && !it.deleted } ?: return null
        val s = data.taskSeries.find { it.id == link.series_id } ?: return null
        val todo = data.todos.find { it.id == todoId }
        return s.takeIf { todo == null || (type(todo) == s.period_type && range(todo.date.orEmpty()) != null) }
    }
    fun display(data: TodoData, todoId: String, snapshot: String = "") = series(data, todoId)?.content ?: data.todos.find { it.id == todoId }?.content ?: snapshot.ifBlank { "未命名任务" }
    fun isDeleted(data: TodoData, todoId: String) = data.taskSeriesLinks.find { it.todo_id == todoId && !it.deleted }?.let { link -> data.taskSeries.any { it.id == link.series_id && it.deleted } } == true
    fun visible(data: TodoData) = data.todos.filter { !isDeleted(data, it.id) }.map { it.copy(content = display(data, it.id)) }
    fun pending(data: TodoData, entry: TimeEntry): String? {
        if (entry.deleted || entry.ended_at != null || entry.task_ref.source_type != "personal" || entry.task_ref.source_id != null) return null
        val todo = data.todos.find { it.id == entry.task_ref.todo_id }
        return when {
            todo?.deleted == true || isDeleted(data, entry.task_ref.todo_id) -> "任务已删除，结束时间待核对"
            todo == null -> "原任务不可用，结束时间待核对"
            else -> null
        }
    }
    fun duplicateTimingSeries(data: TodoData, today: LocalDate = LocalDate.now()) = data.taskSeries.filter { !it.deleted && members(data, it.id, current(it.period_type, today)).size > 1 }
    fun timingTodos(data: TodoData, today: LocalDate = LocalDate.now()) = visible(data).filter { todo ->
        val s = series(data, todo.id)
        Learning.canTimeTodo(todo) && (s == null || (!s.deleted && !todo.completed && todo.date == current(s.period_type, today) && members(data, s.id, todo.date).size == 1))
    }
    fun edit(data: TodoData, baseline: TodoData, draft: Todo, now: String = nowIso()): TodoData {
        val old = baseline.todos.first { it.id == draft.id }
        val latest = data.todos.find { it.id == draft.id }
        val s = series(data, draft.id); val previous = series(baseline, draft.id)
        require(latest != null && !latest.deleted && s?.deleted != true) { "任务已删除，草稿已保留" }
        require(s?.id == previous?.id) { "周期关联已变化，请复制草稿后重新打开" }
        val baseTodo = old.copy(content = display(baseline, old.id))
        if (draft.content != baseTodo.content && s != null) {
            require(s == previous && data.taskSeriesLinks.filter { !it.deleted && it.series_id == s.id }.toSet() == baseline.taskSeriesLinks.filter { !it.deleted && it.series_id == s.id }.toSet()) { "系列名称或范围已变化，请核对；草稿已保留" }
        }
        val before = json.encodeToJsonElement(baseTodo).jsonObject
        val proposed = json.encodeToJsonElement(draft).jsonObject
        val current = json.encodeToJsonElement(latest).jsonObject.toMutableMap()
        var changed = false
        for ((key, value) in proposed) {
            if (key in listOf("id", "created_at", "updated_at", "deleted") || value == before[key] || (key == "content" && s != null)) continue
            require(current[key] == before[key] || current[key] == value) { "$key 已在其他端变化，请核对；草稿已保留" }
            current[key] = value; changed = true
        }
        var updated = json.decodeFromJsonElement<Todo>(JsonObject(current))
        if (changed) updated = updated.copy(updatedAt = now)
        var result = data.copy(todos = data.todos.map { if (it.id == updated.id) updated else it })
        if (s != null && draft.content != baseTodo.content) result = result.copy(taskSeries = result.taskSeries.map {
            if (it.id == s.id) it.copy(content = draft.content, content_renamed = true, content_updated_at = now, updated_at = now) else it
        })
        if (s != null && type(updated) != s.period_type) result = unlink(result, updated.id, now)
        else if (s != null) {
            require(updated.date == old.date || result.todos.count { !it.deleted && it.date == updated.date && (it.id == updated.id || series(result, it.id)?.id == s.id) } <= 1) { "目标周期已有同系列任务" }
            result = result.copy(taskSeriesLinks = result.taskSeriesLinks.map { if (it.todo_id == updated.id && it.period != updated.date) it.copy(period = requireNotNull(updated.date), updated_at = now) else it })
        }
        return validate(result)
    }
    fun merge(a: TodoData, b: TodoData): Pair<List<TaskSeries>, List<TaskSeriesLink>> {
        validate(a); validate(b)
        val names = compareBy<TaskSeries> { it.content_renamed }
            .thenBy { Learning.instant(it.content_updated_at)?.truncatedTo(ChronoUnit.MILLIS) }
            .thenBy { name(it.content) }.thenBy { it.content }.thenBy { it.content_updated_at }
        val series = (a.taskSeries + b.taskSeries).groupBy { it.id }.toSortedMap().values.map { versions ->
            require(versions.map { it.period_type }.distinct().size == 1) { "同一任务系列的周期类型冲突" }
            val base = versions.maxWith(compareBy<TaskSeries> { Learning.instant(it.updated_at) }.thenBy { json.encodeToString(it) })
            val n = versions.maxWith(names)
            base.copy(content = n.content, content_renamed = n.content_renamed, content_updated_at = n.content_updated_at,
                updated_at = versions.maxWith(compareBy<TaskSeries> { Learning.instant(it.updated_at) }.thenBy { it.updated_at }).updated_at,
                created_at = versions.minWith(compareBy<TaskSeries> { Learning.instant(it.created_at) }.thenBy { it.created_at }).created_at,
                deleted = versions.any { it.deleted }, deleted_at = versions.filter { it.deleted }.mapNotNull { it.deleted_at }.minWithOrNull(compareBy<String> { Learning.instant(it) }.thenBy { it }))
        }
        val links = (a.taskSeriesLinks + b.taskSeriesLinks).groupBy { it.todo_id }.toSortedMap().values.map { versions ->
            versions.maxWith(compareBy<TaskSeriesLink> { Learning.instant(it.updated_at)?.truncatedTo(ChronoUnit.MILLIS) }
                .thenBy { it.deleted }.thenBy { canonicalLink(it) })
        }
        return series to links
    }
    // 顺序与 Windows 的按字段名排序序列化一致。
    private fun canonicalLink(l: TaskSeriesLink) = listOf(l.created_at, l.deleted.toString(), l.next_series_id ?: "", l.period, l.series_id, l.todo_id, l.updated_at).joinToString("\u0000")
    private fun identity(data: TodoData, todo: Todo, generate: () -> String): String {
        val link = data.taskSeriesLinks.find { it.todo_id == todo.id }
        if (link != null && !link.deleted) {
            val s = series(data, todo.id)
            require(s != null && !s.deleted) { "关联已变化或系列已删除" }
            return s.id
        }
        if (link?.deleted == true) return requireNotNull(link.next_series_id)
        return if (data.taskSeries.any { it.id == todo.id }) generate() else todo.id
    }
    private fun ensure(data: TodoData, todo: Todo, id: String, now: String): TodoData {
        val existing = data.taskSeries.find { it.id == id }
        require(existing?.deleted != true) { "长期任务已删除" }
        return if (existing != null) data else data.copy(taskSeries = data.taskSeries + TaskSeries(id, todo.content,
            todo.createdAt.takeIf { Learning.instant(it) != null } ?: now, requireNotNull(type(todo)), now, now))
    }
    private fun link(data: TodoData, todo: Todo, id: String, now: String) = if (data.taskSeriesLinks.any { it.todo_id == todo.id && !it.deleted && it.series_id == id && it.period == todo.date }) data else data.copy(taskSeriesLinks = data.taskSeriesLinks.filterNot { it.todo_id == todo.id } +
        TaskSeriesLink(todo.id, id, requireNotNull(todo.date), data.taskSeriesLinks.find { it.todo_id == todo.id }?.created_at ?: now, now))
    fun members(data: TodoData, id: String, period: String? = null) = data.todos.filter { !it.deleted && series(data, it.id)?.id == id && (period == null || it.date == period) }
    fun candidates(data: TodoData, type: String, today: LocalDate = LocalDate.now()): List<PeriodCandidate> {
        val target = current(type, today)
        return data.todos.filter { !it.deleted && type(it) == type && range(it.date.orEmpty()) != null && it.date!! < target && series(data, it.id)?.deleted != true }
            .groupBy { series(data, it.id)?.id ?: it.id }.map { (id, todos) ->
                val choices = todos.sortedWith(compareByDescending<Todo> { it.date }.then(TodoComparator))
                PeriodCandidate(id, display(data, choices.first().id), choices, choices.first().takeIf { t -> choices.count { it.date == t.date } == 1 }, members(data, id, target).isNotEmpty())
            }.sortedWith(compareByDescending<PeriodCandidate> { it.choices.first().date }.thenComparator { a, b -> TodoComparator.compare(a.choices.first(), b.choices.first()) })
    }
    fun import(data: TodoData, references: List<Todo>, target: String, now: String = nowIso(), generate: () -> String = { UUID.randomUUID().toString() }): TodoData =
        requireNotNull(Learning.instant(now)).let { instant ->
            importAt(data, references, target, now, generate, instant.atZone(ZoneId.systemDefault()).toLocalDate(), instant.toEpochMilli())
        }

    internal fun importAt(data: TodoData, references: List<Todo>, target: String, now: String, generate: () -> String, today: LocalDate, nowMillis: Long): TodoData {
        var result = validate(data); val used = mutableSetOf<String>()
        references.forEachIndexed { index, reference ->
            val source = result.todos.find { it.id == reference.id }
            require(source != null && source == reference && !source.deleted && type(source) != null && range(source.date.orEmpty()) != null && source.date!! < target && target == current(type(source)!!, today)) { "参考任务或周期已变化，请重新选择" }
            val id = identity(result, source, generate)
            require(used.add(id) && members(result, id, target).isEmpty() && members(result, id, source.date).size <= 1) { "本期已存在或参考期重复" }
            result = ensure(result, source, id, now); result = link(result, source, id, now)
            val todo = Todo(id = generate(), content = display(result, source.id), date = target, taskType = source.taskType, targetCount = source.targetCount,
                label = source.label, time = source.time, reminder = null, subtasks = source.subtasks.map { it.copy(id = generate(), completed = false, completedAt = null) },
                createdAt = now, updatedAt = now, order = nowMillis.toDouble() + index * 1000)
            result = link(result.copy(todos = result.todos + todo), todo, id, now)
        }
        return result
    }
    fun preview(data: TodoData, todoId: String, selected: Set<String>? = null): AssociationPreview {
        val todo = data.todos.first { it.id == todoId }
        require(!todo.deleted && type(todo) != null && series(data, todoId)?.deleted != true) { "任务已变化" }
        val ids = (selected ?: data.todos.filter { name(display(data, it.id)) == name(display(data, todoId)) }.map { it.id }.toSet()).toMutableSet().apply { add(todoId) }
        val initial = data.todos.filter { it.id in ids && !it.deleted && type(it) == type(todo) && range(it.date.orEmpty()) != null && series(data, it.id)?.deleted != true }
        val seriesIds = initial.mapNotNull { series(data, it.id)?.id }.toSet()
        val links = data.taskSeriesLinks.filter { !it.deleted && it.series_id in seriesIds }.sortedBy { it.todo_id }
        ids.addAll(links.map { it.todo_id })
        val members = data.todos.filter { it.id in ids && !it.deleted && type(it) == type(todo) && range(it.date.orEmpty()) != null }
        val duplicates = members.filter { t -> members.count { it.date == t.date } > 1 }
        val signature = display(data, todoId) + members.sortedBy { it.id }.joinToString { "${it.id}:${it.date}:${series(data, it.id)?.id}" } + json.encodeToString(links)
        return AssociationPreview(todoId, display(data, todoId), members, links, duplicates, signature)
    }
    fun associate(data: TodoData, preview: AssociationPreview, selected: Set<String>? = null, now: String = nowIso(), generate: () -> String = { UUID.randomUUID().toString() }): TodoData {
        val latest = preview(data, preview.todoId, selected)
        require(latest.signature == preview.signature && latest.duplicates.isEmpty()) { "关联范围变化或同一周期存在重复，请重新预览" }
        val todo = data.todos.first { it.id == preview.todoId }; val id = identity(data, todo, generate)
        var result = ensure(data, todo, id, now)
        latest.members.forEach { result = link(result, it, id, now) }
        val historicIds = latest.links.map { it.todo_id }.toSet()
        return result.copy(taskSeriesLinks = result.taskSeriesLinks.map { if (it.todo_id in historicIds && it.series_id != id) it.copy(series_id = id, updated_at = now) else it })
    }
    fun unlink(data: TodoData, todoId: String, now: String = nowIso(), nextId: String = UUID.randomUUID().toString()) = data.copy(taskSeriesLinks = data.taskSeriesLinks.map {
        if (it.todo_id == todoId && !it.deleted) it.copy(deleted = true, updated_at = now, next_series_id = nextId) else it
    })
    fun associationSummary(data: TodoData, todoId: String): AssociationSummary {
        val todo = data.todos.first { it.id == todoId }
        val s = series(data, todoId)
        val periods = if (s == null) emptyList() else data.taskSeriesLinks.filter { !it.deleted && it.series_id == s.id }
            .map { it.period }.filter { range(it) != null }.distinct().sorted()
        val sameName = data.todos.filter { it.id != todoId && !it.deleted && type(it) == type(todo) && range(it.date.orEmpty()) != null
            && series(data, it.id)?.deleted != true && name(display(data, it.id)) == name(display(data, todoId)) }
        return AssociationSummary(s, periods, sameName.size, sameName.filter { s == null || series(data, it.id)?.id != s.id })
    }
    fun unlinkPreview(data: TodoData, todoId: String, all: Boolean = false): PeriodUnlinkPreview {
        val s = series(data, todoId)
        require(s != null && !s.deleted) { "关联已变化，请重新打开" }
        val links = data.taskSeriesLinks.filter { !it.deleted && it.series_id == s.id && (all || it.todo_id == todoId) }.sortedBy { it.todo_id }
        return PeriodUnlinkPreview(todoId, all, links, json.encodeToString(s) + json.encodeToString(links))
    }
    fun unlinkPeriods(data: TodoData, preview: PeriodUnlinkPreview, now: String = nowIso(), generate: () -> String = { UUID.randomUUID().toString() }): TodoData {
        val latest = unlinkPreview(data, preview.todoId, preview.all)
        require(latest.signature == preview.signature) { "关联范围已变化，请重新确认" }
        // 已清理任务也解除历史关联，避免同步后重新归入原长期任务。
        return latest.links.fold(data) { result, link -> unlink(result, link.todo_id, now, generate()) }
    }
    fun deletion(data: TodoData, todoId: String, all: Boolean = false): PeriodDeletePreview {
        val s = series(data, todoId)
        val todos = if (all && s != null) members(data, s.id) else data.todos.filter { it.id == todoId && !it.deleted }
        val ids = todos.map { it.id }.toSet()
        val running = data.timeEntries.filter { !it.deleted && it.ended_at == null && it.task_ref.source_type == "personal" && it.task_ref.source_id == null && it.task_ref.todo_id in ids }
        return PeriodDeletePreview(todoId, all, s?.id, todos, running, json.encodeToString(s) + todos.sortedBy { it.id }.joinToString { "${it.id}:${it.date}" })
    }
    fun delete(data: TodoData, preview: PeriodDeletePreview, now: String = nowIso()): TodoData {
        require(deletion(data, preview.todoId, preview.all).signature == preview.signature) { "删除范围已变化，请重新确认" }
        val ids = preview.todos.map { it.id }.toSet(); val confirmed = preview.running.map { it.id }.toSet()
        return data.copy(todos = data.todos.map { if (it.id in ids) it.copy(deleted = true, updatedAt = now) else it },
            taskSeries = data.taskSeries.map { if (preview.all && it.id == preview.seriesId) it.copy(deleted = true, deleted_at = now, updated_at = now) else it },
            timeEntries = data.timeEntries.map { if (it.id in confirmed && !it.deleted && it.ended_at == null && Learning.instant(it.started_at)?.let { start -> start < Learning.instant(now)!! } == true) it.copy(ended_at = now, updated_at = now) else it })
    }
}
