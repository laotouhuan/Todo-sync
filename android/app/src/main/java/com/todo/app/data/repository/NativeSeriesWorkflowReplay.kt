package com.todo.app.data.repository

import com.todo.app.data.model.MergeUtils
import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.model.TaskSeries
import com.todo.app.data.model.TaskSeriesLink
import com.todo.app.data.model.TaskSeriesLogic
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.data.recordsync.Str
import com.todo.app.data.recordsync.canonical
import com.todo.app.data.recordsync.parse
import com.todo.app.data.recordsync.render
import com.todo.app.data.recordsync.sha
import kotlinx.serialization.json.*
import java.text.Normalizer
import java.time.LocalDate

private const val IMPORT = "series.workflow.import"
private const val DELETE = "series.workflow.delete"
private const val STOP = "time.entry.stop.manual"
private val workflowTypes = setOf(IMPORT, DELETE, STOP)
internal const val LEGACY_SERIES_OPERATION_SET = "lab-collaboration/1"
internal const val CAUSAL_SERIES_OPERATION_SET = "lab-collaboration/2"
private val workflowJson = Json { encodeDefaults = true; ignoreUnknownKeys = true }
private val uuid = Regex("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", RegexOption.IGNORE_CASE)
private val uuid4 = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)
private val targetPattern = Regex("[0-9]{4}-(W[0-9]{2}|[0-9]{2})")
private val digestPattern = Regex("[a-f0-9]{64}")
private val clock = NormalTodoConflict::timestampMillis

private fun JsonElement?.string(): String =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("INVALID_SERIES_WORKFLOW_STRING")

private fun JsonObject.text(key: String) = get(key).string()
private fun JsonObject.rows(key: String) = (get(key) ?: JsonArray(emptyList())).jsonArray.map { it.jsonObject }
private fun JsonObject.flag(key: String) = getValue(key).jsonPrimitive.boolean
private fun JsonObject.ids(key: String, valid: (String) -> Boolean): List<String> {
    val values = getValue(key).jsonArray.map { it.string() }
    require(values.all(valid) && values.distinct().size == values.size) { "INVALID_SERIES_WORKFLOW_IDS" }
    return values
}

private fun JsonObject.with(vararg fields: Pair<String, JsonElement>) = JsonObject(this + fields)
private fun JsonObject.withDefaults(vararg fields: Pair<String, JsonElement>) = JsonObject(mapOf(*fields) + this)
private fun strings(vararg values: Pair<String, String>) = values.map { it.first to JsonPrimitive(it.second) }.toTypedArray()
private fun <T> encode(serializer: kotlinx.serialization.KSerializer<T>, value: T) =
    workflowJson.encodeToJsonElement(serializer, value).jsonObject

// 与 Windows 预览签名一致。对象字段排序，每个字段的序列化结果作为字符串保存。
private fun stable(value: JsonElement): String = when (value) {
    is JsonObject -> stringify(JsonArray(value.toSortedMap().map { (key, item) ->
        JsonArray(listOf(JsonPrimitive(key), JsonPrimitive(stable(item))))
    }))
    is JsonArray -> value.joinToString(",", "[", "]", transform = ::stringify)
    else -> stringify(value)
}

private fun stringify(value: JsonElement): String = when (value) {
    is JsonObject -> value.entries.sortedBy { (key, _) ->
        key.toLongOrNull()?.takeIf { it in 0..4294967294 && it.toString() == key } ?: Long.MAX_VALUE
    }.joinToString(",", "{", "}") { (key, item) -> render(Str(key)) + ":" + stringify(item) }
    is JsonArray -> value.joinToString(",", "[", "]", transform = ::stringify)
    else -> render(parse(value.toString().toByteArray(), strict = false))
}

private val falseValue = JsonPrimitive(false)
private val trueValue = JsonPrimitive(true)
private fun normalizedSeries(row: JsonObject) = row.withDefaults(
    "content_renamed" to falseValue, "deleted" to falseValue, "deleted_at" to JsonNull)
private fun normalizedLink(row: JsonObject) = row.withDefaults("deleted" to falseValue, "next_series_id" to JsonNull)

private data class Effects(
    val operations: List<JsonObject>,
    val series: List<JsonObject> = emptyList(),
    val links: List<JsonObject> = emptyList(),
    val origins: List<JsonObject> = emptyList()
)
private data class Expanded(
    val record: Record,
    val kind: String = "",
    val ancestors: Set<String> = emptySet(),
    val effects: Effects? = null,
    val timerId: String? = null
)

private fun validateOperation(op: JsonObject, kind: String) {
    when (kind) {
        IMPORT -> {
            require(op.keys == setOf("type", "source_ids", "target", "updated_at", "offset_minutes", "generated_ids")) { "INVALID_SERIES_WORKFLOW" }
            val offset = op.getValue("offset_minutes").jsonPrimitive
            require(op.ids("source_ids", uuid::matches).isNotEmpty() && op.ids("generated_ids", uuid4::matches).isNotEmpty() &&
                targetPattern.matches(op.text("target")) && !offset.isString && offset.doubleOrNull?.let { it >= -840 && it <= 840 && it == it.toInt().toDouble() } == true) { "INVALID_SERIES_IMPORT" }
            clock(op.text("updated_at"))
        }
        DELETE -> {
            require(op.keys == setOf("type", "series_id", "todo_id", "updated_at", "member_ids", "confirmed_timer_ids", "preview_sha256")) { "INVALID_SERIES_WORKFLOW" }
            require(uuid.matches(op.text("series_id")) && uuid.matches(op.text("todo_id")) &&
                op.ids("member_ids", uuid::matches).isNotEmpty() && digestPattern.matches(op.text("preview_sha256"))) { "INVALID_SERIES_DELETE" }
            op.ids("confirmed_timer_ids", String::isNotEmpty)
            clock(op.text("updated_at"))
        }
        STOP -> {
            require(op.keys == setOf("type", "timer_id", "ended_at") && op.text("timer_id").isNotEmpty()) { "INVALID_MANUAL_TIMER_STOP" }
            clock(op.text("ended_at"))
        }
    }
}

private fun operation(type: String, key: String, row: JsonObject) =
    JsonObject(mapOf("type" to JsonPrimitive(type), key to row))

private fun periodOperation(action: String, todo: Todo): JsonObject {
    val migrated = MergeUtils.migrateTodo(todo)
    val manualCompletion = migrated.targetCount == null
    val candidate = migrated.copy(completedDates = emptyList(), completed = manualCompletion && migrated.completed,
        completedAt = migrated.completedAt.takeIf { manualCompletion })
    return operation("todo.period.$action", "todo", encode(Todo.serializer(), NormalTodoConflict.validatePeriodCandidate(candidate)))
}

private fun importEffects(view: JsonObject, op: JsonObject): Effects {
    val data = workflowJson.decodeFromJsonElement<TodoData>(view)
    val sources = op.getValue("source_ids").jsonArray.map { id ->
        data.todos.find { it.id == id.string() } ?: error("SERIES_IMPORT_SOURCE_NOT_FOUND")
    }
    val generated = op.getValue("generated_ids").jsonArray.map { it.string() }
    val oldLinks = view.rows("task_series_links").associateBy { it.text("todo_id") }
    val seriesIds = data.taskSeries.map { it.id }.toSet()
    val occupied = seriesIds + oldLinks.keys + data.todos.flatMap { todo -> listOf(todo.id) + todo.subtasks.map { it.id } }
    val at = op.text("updated_at")
    val atMillis = clock(at)
    val localDay = LocalDate.ofEpochDay(Math.floorDiv(atMillis + op.getValue("offset_minutes").jsonPrimitive.double.toLong() * 60000, 86400000L))
    var index = 0
    val result = TaskSeriesLogic.importAt(data, sources, op.text("target"), at, {
        val id = generated.getOrNull(index++) ?: error("SERIES_IMPORT_GENERATED_ID_CONFLICT")
        require(id !in occupied) { "SERIES_IMPORT_GENERATED_ID_CONFLICT" }
        id
    }, localDay, atMillis)
    require(index == generated.size) { "SERIES_IMPORT_UNUSED_IDS" }
    val sourceIds = sources.map { it.id }.toSet()
    return Effects(
        operations = result.todos.drop(data.todos.size).map { periodOperation("create", it) },
        series = result.taskSeries.filter { it.id !in seriesIds }.map { encode(TaskSeries.serializer(), it) },
        links = result.taskSeriesLinks.mapNotNull { link ->
            val row = encode(TaskSeriesLink.serializer(), link)
            val old = oldLinks[link.todo_id].orEmpty()
            JsonObject(old + row).takeUnless { it == old }
        },
        origins = result.taskSeriesLinks.filter { it.todo_id in sourceIds && it.series_id !in seriesIds }
            .map { encode(TaskSeriesLink.serializer(), it) }
    )
}

private fun isPersonalTimer(row: JsonObject): Boolean {
    val ref = row.getValue("task_ref").jsonObject
    return ref.text("source_type") == "personal" && ref["source_id"] == JsonNull
}

private fun stopEffect(view: JsonObject, op: JsonObject): Effects {
    val timerId = op.text("timer_id")
    val entry = view.rows("time_entries").find { it.text("id") == timerId }
    require(entry != null && !entry.flag("deleted") && entry["ended_at"] == JsonNull) { "MANUAL_TIMER_NOT_RUNNING" }
    if (isPersonalTimer(entry)) {
        val todoId = entry.getValue("task_ref").jsonObject.text("todo_id")
        val todo = view.rows("todos").find { it.text("id") == todoId }
        val link = view.rows("task_series_links").find { it.text("todo_id") == todoId && !it.flag("deleted") }
        val seriesDeleted = link != null && view.rows("task_series").any { it.text("id") == link.text("series_id") && it.flag("deleted") }
        require(todo != null && todo["deleted"] != trueValue && !seriesDeleted) { "MANUAL_TIMER_REQUIRES_END_REVIEW" }
    }
    val end = op.text("ended_at")
    val duration = clock(end) - clock(entry.text("started_at"))
    require(duration >= 0) { "INVALID_TIME_ENTRY_INTERVAL" }
    val deleted = duration <= 30000
    val stopped = entry.with(*strings("ended_at" to end, "updated_at" to end), "deleted" to JsonPrimitive(deleted))
    return Effects(listOf(operation(if (deleted) "time.entry.delete" else "time.entry.put", "entry", stopped)))
}

private fun deleteEffects(view: JsonObject, op: JsonObject): Effects {
    val data = workflowJson.decodeFromJsonElement<TodoData>(view)
    val current = view.rows("task_series").find { it.text("id") == op.text("series_id") }
    val preview = TaskSeriesLogic.deletion(data, op.text("todo_id"), true)
    val ids = op.getValue("member_ids").jsonArray.map { it.string() }
    require(current != null && !current.flag("deleted") && preview.seriesId == current.text("id") &&
        preview.todos.map { it.id }.sorted() == ids) { "SERIES_DELETE_PREVIEW_CHANGED" }
    val memberPairs = preview.todos.sortedBy { it.id }.map { JsonArray(listOf(JsonPrimitive(it.id), it.date?.let(::JsonPrimitive) ?: JsonNull)) }
    val signature = stable(JsonObject(mapOf("series" to current, "members" to JsonArray(memberPairs))))
    require(sha(canonical(Str(signature))) == op.text("preview_sha256")) { "SERIES_DELETE_PREVIEW_CHANGED" }

    val timerIds = op.getValue("confirmed_timer_ids").jsonArray.map { it.string() }.toSet()
    val timers = view.rows("time_entries").filter { it.text("id") in timerIds }
    require(timers.size == timerIds.size && timers.all { isPersonalTimer(it) && it.getValue("task_ref").jsonObject.text("todo_id") in ids }) {
        "SERIES_DELETE_TIMER_OUTSIDE_PREVIEW"
    }
    val at = op.text("updated_at")
    val running = preview.running.map { it.id }.toSet()
    val operations = preview.todos.map { periodOperation("delete", it.copy(deleted = true, updatedAt = at)) } +
        timers.filter { it.text("id") in running && clock(it.text("started_at")) < clock(at) }.map {
            operation("time.entry.put", "entry", it.with(*strings("ended_at" to at, "updated_at" to at)))
        }
    return Effects(operations, listOf(current.with(*strings("deleted_at" to at, "updated_at" to at), "deleted" to trueValue)))
}

private fun mergeSeries(old: JsonObject, next: JsonObject): JsonObject {
    require(old.text("period_type") == next.text("period_type")) { "SERIES_PERIOD_TYPE_CONFLICT" }
    val names = compareBy<JsonObject> { it.flag("content_renamed") }.thenBy { clock(it.text("content_updated_at")) }
        .thenBy { Normalizer.normalize(trimRecordText(it.text("content")), Normalizer.Form.NFC) }
        .thenBy { it.text("content") }.thenBy { it.text("content_updated_at") }
    val pair = listOf(old, next)
    val timeOrder = compareBy<String>(clock).thenBy { it }
    val name = pair.maxWith(names)
    val base = pair.maxWith(compareBy<JsonObject> { clock(it.text("updated_at")) }.thenBy(::stable))
    val deletedAt = pair.filter { it.flag("deleted") }.map { it.text("deleted_at") }.minWithOrNull(timeOrder)
    return base.with(
        "content" to name.getValue("content"), "content_renamed" to name.getValue("content_renamed"),
        "content_updated_at" to name.getValue("content_updated_at"),
        "created_at" to JsonPrimitive(pair.map { it.text("created_at") }.minWith(timeOrder)),
        "updated_at" to JsonPrimitive(pair.map { it.text("updated_at") }.maxWith(timeOrder)),
        "deleted" to JsonPrimitive(deletedAt != null), "deleted_at" to (deletedAt?.let(::JsonPrimitive) ?: JsonNull)
    )
}

private fun projectExpanded(baseline: JsonObject, entries: List<Expanded>, projectBase: (JsonObject, List<Record>) -> JsonObject): JsonObject {
    val stops = entries.filter { it.kind == STOP }.groupBy { it.timerId }
    val records = entries.map { entry ->
        if (entry.kind != DELETE || stops.isEmpty()) entry.record else entry.record.copy(operations = entry.record.operations.filterNot { operation ->
            operation.text("type") == "time.entry.put" && stops[operation.getValue("entry").jsonObject.text("id")].orEmpty().any {
                entry.record.id !in it.ancestors && it.record.id !in entry.ancestors
            }
        })
    }
    val projected = projectBase(baseline, records)
    val series = projected.rows("task_series").map(::normalizedSeries)
    val links = projected.rows("task_series_links").map(::normalizedLink)
    val effects = entries.mapNotNull { it.effects }
    if (effects.isEmpty()) return projected.with("task_series" to JsonArray(series), "task_series_links" to JsonArray(links))
    val seriesById = series.associateByTo(sortedMapOf()) { it.text("id") }
    val linksById = links.associateByTo(sortedMapOf()) { it.text("todo_id") }
    val linkOrder = compareBy<JsonObject> { clock(it.text("updated_at")) }.thenBy { it.flag("deleted") }.thenBy(::stable)
    for (effect in effects) {
        for (row in effect.series) seriesById.merge(row.text("id"), row, ::mergeSeries)
        for (row in effect.links) linksById.merge(row.text("todo_id"), row) { old, next -> if (linkOrder.compare(old, next) < 0) next else old }
    }
    return projected.with("task_series" to JsonArray(seriesById.values.toList()), "task_series_links" to JsonArray(linksById.values.toList()))
}

private fun ancestorsOf(record: Record, entries: Map<String, Expanded>): Set<String> {
    val seen = mutableSetOf<String>()
    val pending = ArrayDeque(record.parents)
    while (pending.isNotEmpty()) {
        val id = pending.removeLast().id
        if (seen.add(id)) pending.addAll((entries[id] ?: error("SERIES_WORKFLOW_MISSING_PARENT")).record.parents)
    }
    return seen
}

internal fun hasSeriesWorkflowRecords(records: List<Record>, causalSeries: Boolean) = records.any { record ->
    record.operations.any { it.text("type") in workflowTypes || (causalSeries && isSeriesOperation(it)) }
}

internal fun replaySeriesWorkflows(baseline: JsonObject, records: List<Record>, causalSeries: Boolean, projectBase: (JsonObject, List<Record>) -> JsonObject): JsonObject {
    val entries = linkedMapOf<String, Expanded>()
    val generated = mutableSetOf<String>()
    val origins = mutableMapOf<String, String>()
    for (record in records) {
        val op = record.operations.firstOrNull { it.text("type") in workflowTypes }
        val seriesActions = causalSeries && record.operations.any(::isSeriesOperation)
        if (op == null && !seriesActions) {
            entries[record.id] = Expanded(record)
            continue
        }
        val ancestors = ancestorsOf(record, entries)
        val projected = projectExpanded(baseline, entries.values.filter { it.record.id in ancestors }, projectBase)
        if (op == null) {
            val todos = projected.rows("todos").map { MergeUtils.migrateTodo(workflowJson.decodeFromJsonElement<Todo>(it)) }
            val series = NativeSeriesRecordReplay(projected, todos.associateBy { it.id })
            val expanded = series.prepare(listOf(record)).single()
            entries[record.id] = Expanded(expanded, effects = Effects(emptyList(), series.changedSeries(), series.changedLinks()))
            continue
        }
        require(record.operations.size == 1) { "SERIES_WORKFLOW_REQUIRES_OWN_RECORD" }
        val kind = op.text("type")
        validateOperation(op, kind)
        val view = projected.with("time_entries" to JsonArray(projected.rows("time_entries").map {
            normalizeLearningRow(it, timer = true, legacy = true)
        }))
        val effects = when (kind) {
            IMPORT -> importEffects(view, op)
            DELETE -> deleteEffects(view, op)
            else -> stopEffect(view, op)
        }
        if (kind == IMPORT) {
            require(op.getValue("generated_ids").jsonArray.all { generated.add(it.string()) }) { "CONCURRENT_SERIES_IMPORT_ID_CONFLICT" }
            for (origin in effects.origins) {
                val id = origin.text("todo_id")
                val previous = origins.putIfAbsent(origin.text("series_id"), id)
                require(previous == null || previous == id) { "CONCURRENT_SERIES_IMPORT_ORIGIN_CONFLICT" }
            }
        }
        entries[record.id] = Expanded(record.copy(operations = effects.operations), kind, ancestors,
            effects.takeUnless { kind == STOP }, if (kind == STOP) op.text("timer_id") else null)
    }
    return projectExpanded(baseline, entries.values.toList(), projectBase)
}
