package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.model.TaskSeries
import com.todo.app.data.model.TaskSeriesLink
import com.todo.app.data.model.TaskSeriesLogic
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import java.text.Normalizer

private val seriesTypes = setOf("series.rename", "series.link.put", "series.link.unlink")
internal fun isSeriesOperation(operation: JsonObject) = operation.text("type") in seriesTypes
private val id = Regex("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", RegexOption.IGNORE_CASE)
private val newId = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)
private val seriesJson = Json { encodeDefaults = true; ignoreUnknownKeys = true }
private val clock = NormalTodoConflict::timestampMillis

private fun JsonObject.text(key: String): String =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("INVALID_SERIES_OPERATION")

private fun normalizedName(value: String) = Normalizer.normalize(trimRecordText(value), Normalizer.Form.NFC)

internal class NativeSeriesRecordReplay(private val baseline: JsonObject, private val todos: Map<String, Todo>) {
    private val originalSeries by lazy {
        raw("task_series").associate { row -> row.text("id") to (seriesJson.decodeFromJsonElement<TaskSeries>(row) to row) }
    }
    private val originalLinks by lazy {
        raw("task_series_links").associate { row -> row.text("todo_id") to (seriesJson.decodeFromJsonElement<TaskSeriesLink>(row) to row) }
    }
    private val names = mutableMapOf<String, TaskSeries>()
    private val associations = mutableMapOf<String, TaskSeriesLink>()

    private fun raw(key: String): List<JsonObject> {
        val rows = baseline[key] ?: return emptyList()
        require(rows is JsonArray) { "INVALID_SERIES_BASELINE" }
        val identity = if (key == "task_series") "id" else "todo_id"
        return rows.map { it.jsonObject }.also { list ->
            require(list.map { it.text(identity) }.toSet().size == list.size) { "INVALID_SERIES_BASELINE" }
        }
    }

    fun prepare(records: List<Record>): List<Record> = records.map { record ->
        record.copy(operations = record.operations.filter { operation ->
            val type = operation.text("type")
            if (!isSeriesOperation(operation)) true else {
                accept(operation, type)
                false
            }
        })
    }

    private fun accept(operation: JsonObject, type: String) {
        val unlink = type == "series.link.unlink"
        val rename = type == "series.rename"
        val fields = setOf("type", "series_id", "updated_at") + if (rename) "content" else "todo_id"
        require(operation.keys == if (unlink) fields + "next_series_id" else fields) { "INVALID_SERIES_OPERATION" }
        val seriesId = operation.text("series_id")
        require(id.matches(seriesId)) { "INVALID_SERIES_OPERATION" }
        val at = operation.text("updated_at")
        clock(at)
        val original = originalSeries[seriesId]?.first ?: error("SERIES_TARGET_NOT_ACTIVE_IN_BASELINE")
        require(!original.deleted) { "SERIES_TARGET_NOT_ACTIVE_IN_BASELINE" }
        if (rename) {
            val content = operation.text("content")
            require(normalizedName(content).isNotEmpty()) { "INVALID_SERIES_NAME" }
            val current = names[seriesId] ?: original
            val candidate = original.copy(content = content, content_renamed = true, content_updated_at = at, updated_at = at)
            val compare = compareBy<TaskSeries> { it.content_renamed }.thenBy { clock(it.content_updated_at) }
                .thenBy { normalizedName(it.content) }.thenBy { it.content }.thenBy { it.content_updated_at }
            val winner = if (compare.compare(current, candidate) >= 0) current else candidate
            val updated = maxOf(current.updated_at, at, compareBy<String> { clock(it) }.thenBy { it })
            names[seriesId] = winner.copy(updated_at = updated, deleted_at = null)
            return
        }
        val todoId = operation.text("todo_id")
        require(id.matches(todoId)) { "INVALID_SERIES_LINK_TODO_ID" }
        val initial = originalLinks[todoId]?.first ?: error("SERIES_LINK_TARGET_NOT_IN_BASELINE")
        require(initial.series_id == seriesId) { "SERIES_LINK_TARGET_NOT_IN_BASELINE" }
        val next = if (unlink) operation.text("next_series_id") else null
        require(next == null || newId.matches(next)) { "INVALID_NEXT_SERIES_ID" }
        if (!unlink) {
            val todo = todos[todoId]
            require(todo != null && !todo.deleted && todo.date == initial.period && TaskSeriesLogic.type(todo) == original.period_type) {
                "SERIES_RELINK_TODO_NOT_ACTIVE_IN_BASELINE"
            }
        }
        val candidate = initial.copy(updated_at = at, deleted = unlink, next_series_id = next)
        val fixed = TodoData(1, at, emptyList(), taskSeriesLinks = listOf(associations[todoId] ?: initial))
        associations[todoId] = TaskSeriesLogic.merge(fixed, fixed.copy(taskSeriesLinks = listOf(candidate))).second.single()
    }

    fun apply(fields: MutableMap<String, JsonElement>) {
        if (names.isNotEmpty()) fields["task_series"] = JsonArray(originalSeries.toSortedMap().map { (key, entry) ->
            JsonObject(entry.second + seriesJson.encodeToJsonElement(TaskSeries.serializer(), names[key] ?: entry.first).jsonObject)
        })
        if (associations.isNotEmpty()) fields["task_series_links"] = JsonArray(originalLinks.toSortedMap().map { (key, entry) ->
            JsonObject(entry.second + seriesJson.encodeToJsonElement(TaskSeriesLink.serializer(), associations[key] ?: entry.first).jsonObject)
        })
    }

    fun changedSeries() = names.map { (id, row) ->
        JsonObject(originalSeries.getValue(id).second + seriesJson.encodeToJsonElement(TaskSeries.serializer(), row).jsonObject)
    }

    fun changedLinks() = associations.map { (id, row) ->
        JsonObject(originalLinks.getValue(id).second + seriesJson.encodeToJsonElement(TaskSeriesLink.serializer(), row).jsonObject)
    }
}
