package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject

private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)
private val datePattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
private val clock = NormalTodoConflict::timestampMillis
private val stopTypes = setOf("time.entry.put", "time.entry.delete")
private val reviewTypes = setOf("daily.review.put", "daily.review.delete")

private fun string(value: JsonElement?): String =
    (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("INVALID_LEARNING_STRING")

private fun deleted(value: JsonElement?): Boolean =
    (value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: error("INVALID_LEARNING_DELETE_FLAG")

internal fun normalizeLearningRow(row: JsonObject, timer: Boolean, legacy: Boolean): JsonObject {
    val fields = row.toMutableMap()
    require(string(fields["id"]).isNotEmpty()) { "INVALID_LEARNING_RECORD" }
    val created = string(fields["created_at"])
    if (legacy) fields.putIfAbsent("updated_at", JsonPrimitive(created))
    clock(created)
    clock(string(fields["updated_at"]))
    fields.putIfAbsent("deleted", JsonPrimitive(false))
    deleted(fields["deleted"])
    if (timer) {
        val ref = (fields["task_ref"] as? JsonObject)?.toMutableMap() ?: error("INVALID_TIME_ENTRY_TASK_REF")
        require(string(ref["todo_id"]).isNotEmpty()) { "INVALID_TIME_ENTRY_TASK_REF" }
        ref.putIfAbsent("source_type", JsonPrimitive("personal"))
        ref.putIfAbsent("source_id", JsonNull)
        require(string(ref["source_type"]) in setOf("personal", "collaboration")) { "INVALID_TIME_ENTRY_TASK_REF" }
        if (ref["source_id"] != JsonNull) string(ref["source_id"])
        fields["task_ref"] = JsonObject(ref)
        fields.putIfAbsent("task_content_snapshot", JsonPrimitive(""))
        fields.putIfAbsent("label_snapshot", JsonNull)
        fields.putIfAbsent("ended_at", JsonNull)
        string(fields["task_content_snapshot"])
        if (fields["label_snapshot"] != JsonNull) {
            fields["label_snapshot"] = NormalTodoConflict.normalizeLabel(string(fields["label_snapshot"]))?.let(::JsonPrimitive) ?: JsonNull
        }
        val start = clock(string(fields["started_at"]))
        require(fields["ended_at"] == JsonNull || clock(string(fields["ended_at"])) >= start) { "INVALID_TIME_ENTRY_INTERVAL" }
    } else {
        val day = string(fields["date"])
        require(datePattern.matches(day)) { "INVALID_DAILY_REVIEW_DATE" }
        clock("${day}T00:00:00Z")
        for (name in listOf("fact", "obstacle", "effective_action", "next_step")) {
            fields.putIfAbsent(name, JsonPrimitive(""))
            string(fields[name])
        }
    }
    return JsonObject(fields)
}

internal class NativeLearningRecordReplay {
    private val times = mutableListOf<JsonObject>()
    private val reviews = mutableListOf<JsonObject>()

    fun collect(operation: JsonObject, type: String): Boolean {
        val timer = type in stopTypes
        if (!timer && type !in reviewTypes) return false
        val field = if (timer) "entry" else "review"
        require(operation.keys == setOf("type", field)) { "INVALID_LEARNING_OPERATION" }
        val raw = operation.getValue(field).jsonObject
        val normalized = normalizeLearningRow(raw, timer, legacy = false)
        require(raw == normalized) { "NON_NORMALIZED_LEARNING_OPERATION" }
        require(deleted(raw["deleted"]) == type.endsWith(".delete")) { "LEARNING_DELETE_KIND_MISMATCH" }
        (if (timer) times else reviews).add(raw)
        return true
    }

    fun apply(fields: MutableMap<String, JsonElement>) {
        applyCollection(fields, times, true)
        applyCollection(fields, reviews, false)
    }

    private fun applyCollection(fields: MutableMap<String, JsonElement>, candidates: List<JsonObject>, timer: Boolean) {
        if (candidates.isEmpty()) return
        val name = if (timer) "time_entries" else "daily_reviews"
        val key = if (timer) "id" else "date"
        val source = fields[name] ?: JsonArray(emptyList())
        require(source is JsonArray) { "INVALID_LEARNING_BASELINE" }
        val baseline = source.map { normalizeLearningRow(it.jsonObject, timer, legacy = true) }
        val identities = baseline.groupBy { string(it[key]) }
            .mapValues { (_, rows) -> rows.mapTo(mutableSetOf()) { string(it["id"]) } }.toMutableMap()
        for (candidate in candidates) {
            val id = string(candidate["id"])
            val ids = identities.getOrPut(string(candidate[key])) { mutableSetOf() }
            require(id in ids || uuid.matches(id)) { if (timer) "INVALID_NEW_TIME_ENTRY_ID" else "INVALID_NEW_DAILY_REVIEW_ID" }
            ids.add(id)
        }
        val compare = compareBy<JsonObject> { clock(string(it["updated_at"])) }
            .thenBy { deleted(it["deleted"]) }.thenBy { NormalTodoConflict.businessKey(it) }
        val result = (baseline + candidates).groupBy { string(it[key]) }.toSortedMap().values.map { it.maxWith(compare) }
        fields[name] = JsonArray(result)
    }
}
