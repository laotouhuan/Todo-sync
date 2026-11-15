package com.todo.app.data.model

import com.todo.app.data.recordsync.parse
import com.todo.app.data.recordsync.render
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.DayOfWeek
import java.time.temporal.TemporalAdjusters
import java.math.BigDecimal
import java.math.RoundingMode
import kotlinx.serialization.json.*

object WeeklyPlanning {
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val keys = listOf("weekly_plan_versions", "weekly_plan_selections", "daily_ratings")
    private val defaults = listOf(
        buildJsonObject {
            put("base_version_id", JsonNull)
            put("days", JsonArray(List(7) { JsonPrimitive("") }))
            put("change_reason", "")
            put("deleted", false)
            put("deleted_at", JsonNull)
        },
        buildJsonObject { put("parent_selection_ids", JsonArray(emptyList())); put("kind", "save") },
        buildJsonObject { put("score", JsonNull); put("deleted", false) }
    )

    data class State(val status: String, val tips: List<String>, val candidates: List<JsonObject>,
                     val history: List<JsonObject>, val current: JsonObject?)
    data class TextDifference(val before: String, val removed: String, val added: String, val after: String)
    data class ExportOptions(val includePlans: Boolean = false, val includeRatings: Boolean = false, val includePlanHistory: Boolean = false)
    data class ExportContent(val days: Map<LocalDate, List<String>>, val history: List<String>)
    data class RatingSummary(val average: String?, val count: Int, val days: Long)

    fun compare(oldText: String, newText: String): TextDifference {
        val old = oldText.codePoints().toArray()
        val next = newText.codePoints().toArray()
        val limit = minOf(old.size, next.size)
        var prefix = 0
        var suffix = 0
        while (prefix < limit && old[prefix] == next[prefix]) prefix++
        while (prefix + suffix < limit && old[old.lastIndex - suffix] == next[next.lastIndex - suffix]) suffix++
        return TextDifference(String(old, 0, prefix), String(old, prefix, old.size - prefix - suffix),
            String(next, prefix, next.size - prefix - suffix), String(old, old.size - suffix, suffix))
    }

    fun export(data: JsonObject, start: LocalDate, end: LocalDate, options: ExportOptions): ExportContent {
        val days = sortedMapOf<LocalDate, MutableList<String>>()
        val history = mutableListOf<String>()
        val selected = if (options.includePlans || options.includePlanHistory) data else JsonObject(data.filterKeys { it == keys[2] })
        val normalized = merge(selected)
        fun append(day: LocalDate, vararg lines: String) { days.getOrPut(day, ::mutableListOf).addAll(lines) }
        fun escape(value: String): String {
            val punctuation = "!\"#$%&'()*+,./:;<=>?@[\\]^_`{|}~-"
            val escaped = buildString { for (character in value) {
                if (character in punctuation) append('\\')
                append(character)
            } }
            return escaped.replace(Regex("^[ \\t]+", RegexOption.MULTILINE)) {
                it.value.replace(" ", "&#32;").replace("\t", "&#9;")
            }
        }
        if (options.includeRatings) for (rating in normalized.rows(keys[2])) {
            val day = date(rating.text("date"))
            val score = rating.getValue("score").jsonPrimitive.intOrNull
            if (day >= start && day < end && !rating.flag("deleted") && score != null) {
                append(day, "### 整体满意度", "", "$score / 5", "")
            }
        }
        if (options.includePlans || options.includePlanHistory) for (week in normalized.rows(keys[0]).map { it.text("week_start") }.distinct().sorted()) {
            val monday = date(week)
            val calendar = List(7) { monday.plusDays(it.toLong()) }
            if (calendar.none { it >= start && it < end }) continue
            val plan = state(normalized, week)
            if (options.includePlans) calendar.forEachIndexed { index, day ->
                if (day >= start && day < end) {
                    val text = when (plan.status) {
                        "conflict" -> "计划存在分歧，尚未选择当前版本"
                        "restart" -> "当前候选计划均已删除，需重新制定"
                        else -> escape(requireNotNull(plan.current).getValue("days").jsonArray[index].jsonPrimitive.content).ifEmpty { "未安排" }
                    }
                    append(day, "### 计划", "", text, "")
                }
            }
            if (options.includePlanHistory && plan.history.isNotEmpty()) {
                history.addAll(listOf("### $week 当周", ""))
                for (version in plan.history) {
                    history.addAll(listOf("#### ${version.text("created_at")}", "", "版本：${version.id()}", "",
                        "修订原因：${escape(version.text("change_reason")).ifEmpty { "未填写" }}", ""))
                    calendar.forEachIndexed { index, day -> history.addAll(listOf("**$day**", "",
                        escape(version.getValue("days").jsonArray[index].jsonPrimitive.content).ifEmpty { "未安排" }, "")) }
                }
            }
        }
        return ExportContent(days, history)
    }

    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.also { require(it.isString) }.content
    private fun JsonObject.flag(key: String) = getValue(key).jsonPrimitive.also { require(!it.isString) }.boolean
    private fun JsonObject.id() = text("id")
    private fun JsonObject.parents() = getValue("parent_selection_ids").jsonArray.map {
        it.jsonPrimitive.also { value -> require(value.isString && uuid.matches(value.content)) }.content
    }
    private fun canonical(row: JsonObject) = render(parse(row.toString().encodeToByteArray(), strict = false))
    private fun clock(value: String) = NormalTodoConflict.timestampMillis(value)

    private fun date(value: String): LocalDate {
        require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))) { "INVALID_PLANNING_DATE" }
        return LocalDate.parse(value, DateTimeFormatter.ISO_LOCAL_DATE)
    }

    fun monday(value: String): String = date(value).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString()

    private fun normalize(raw: JsonObject, index: Int): JsonObject {
        val row = JsonObject(defaults[index] + raw)
        require(uuid.matches(row.id())) { "INVALID_PLANNING_ID" }
        val created = clock(row.text("created_at"))
        val updated = clock(row.text("updated_at"))
        if (index == 2) {
            date(row.text("date"))
            row.flag("deleted")
            val score = row.getValue("score").jsonPrimitive
            require(score == JsonNull || !score.isString && score.doubleOrNull?.let { it in 1.0..5.0 && it % 1.0 == 0.0 } == true) {
                "INVALID_DAILY_RATING"
            }
            return if (score == JsonNull) row else JsonObject(row + ("score" to JsonPrimitive(score.double.toInt())))
        }
        val week = row.text("week_start")
        require(monday(week) == week)
        if (index == 0) {
            require(row.getValue("base_version_id") == JsonNull || uuid.matches(row.text("base_version_id")))
            val days = row.getValue("days").jsonArray
            require(days.size == 7 && days.all { it.jsonPrimitive.isString })
            row.text("change_reason")
            if (row.getValue("deleted_at") != JsonNull) {
                require(row.flag("deleted"))
                clock(row.text("deleted_at"))
            } else row.flag("deleted")
            return row
        }
        val parents = row.parents()
        require(parents.toSet().size == parents.size && uuid.matches(row.text("version_id")) &&
            row.text("kind") in listOf("save", "resolve") && created == updated)
        return JsonObject(row + ("parent_selection_ids" to JsonArray(parents.sorted().map(::JsonPrimitive))))
    }

    private fun join(first: JsonObject, second: JsonObject, index: Int): JsonObject {
        if (index == 1) {
            require(canonical(first) == canonical(second)) { "WEEKLY_PLAN_SELECTION_ID_CONFLICT" }
            return first
        }
        if (index == 0) {
            val fields = setOf("deleted", "deleted_at", "updated_at")
            require(canonical(JsonObject(first - fields)) == canonical(JsonObject(second - fields))) { "WEEKLY_PLAN_ID_CONFLICT" }
            if (first.flag("deleted") != second.flag("deleted")) return if (first.flag("deleted")) first else second
        }
        fun time(row: JsonObject) = clock(if (index == 0 && row.getValue("deleted_at") != JsonNull)
            row.text("deleted_at") else row.text("updated_at"))
        fun priority(row: JsonObject) = if (index == 0) 0 else if (row.flag("deleted")) 2 else if (row["score"] == JsonNull) 1 else 0
        val comparison = compareValuesBy(first, second, ::time, ::priority, ::canonical)
        return if (comparison >= 0) first else second
    }

    private fun graph(rows: List<JsonObject>, edges: (JsonObject) -> List<String>): List<JsonObject> {
        val byId = rows.associateBy { it.id() }
        val pending = mutableMapOf<String, Int>()
        val successors = mutableMapOf<String, MutableList<String>>()
        for (row in rows) {
            val parents = edges(row)
            pending[row.id()] = parents.size
            for (id in parents) {
                require(byId[id]?.text("week_start") == row.text("week_start")) { "INVALID_WEEKLY_PLAN_RELATION" }
                successors.getOrPut(id, ::mutableListOf).add(row.id())
            }
        }
        val ready = ArrayDeque(pending.filterValues { it == 0 }.keys)
        var visited = 0
        while (ready.isNotEmpty()) {
            visited++
            for (id in successors[ready.removeFirst()].orEmpty()) {
                val remaining = pending.getValue(id) - 1
                pending[id] = remaining
                if (remaining == 0) ready.addLast(id)
            }
        }
        require(visited == rows.size) { "INVALID_WEEKLY_PLAN_RELATION" }
        return rows.filter { it.id() !in successors }
    }

    private fun JsonObject.rows(key: String) = this[key]?.jsonArray?.map { it.jsonObject }.orEmpty()

    private fun validate(data: JsonObject): List<JsonObject> {
        val versions = data.rows(keys[0])
        val selections = data.rows(keys[1])
        val byId = versions.associateBy { it.id() }
        graph(versions) { if (it["base_version_id"] == JsonNull) emptyList() else listOf(it.text("base_version_id")) }
        val tips = graph(selections) { it.parents() }
        for (selection in selections) {
            require(byId[selection.text("version_id")]?.text("week_start") == selection.text("week_start")) {
                "INVALID_WEEKLY_PLAN_RELATION"
            }
        }
        val saved = selections.filter { it.text("kind") == "save" }.mapTo(mutableSetOf()) { it.text("version_id") }
        require(versions.all { it.id() in saved }) { "INVALID_WEEKLY_PLAN_RELATION" }
        return tips
    }

    fun merge(vararg sources: JsonObject): JsonObject {
        val data = buildJsonObject {
            keys.forEachIndexed { index, key ->
                val rows = mutableMapOf<String, JsonObject>()
                for (source in sources) for (raw in source.rows(key)) {
                    val candidate = normalize(raw, index)
                    canonical(candidate)
                    val id = candidate.text(if (index == 2) "date" else "id")
                    rows[id] = rows[id]?.let { join(it, candidate, index) } ?: candidate
                }
                val sorted = if (index == 2) rows.values.sortedBy { it.text("date") }
                else rows.values.sortedWith(compareBy({ clock(it.text("created_at")) }, { it.id() }))
                put(key, JsonArray(sorted))
            }
        }
        validate(data)
        return data
    }

    fun state(data: JsonObject, week: String): State {
        require(monday(week) == week)
        val normalized = merge(data)
        val versions = normalized.rows(keys[0]).filter { it.text("week_start") == week }
        val tips = validate(normalized).filter { it.text("week_start") == week }
        val ids = tips.mapTo(mutableSetOf()) { it.text("version_id") }
        val candidates = versions.filter { it.id() in ids }
        val status = when {
            tips.isEmpty() -> "empty"
            candidates.all { it.flag("deleted") } -> "restart"
            candidates.size == 1 -> "current"
            else -> "conflict"
        }
        return State(status, tips.map { it.id() }.sorted(), candidates, versions.filterNot { it.flag("deleted") },
            candidates.singleOrNull()?.takeIf { status == "current" })
    }

    fun average(data: JsonObject, start: String, end: String): String? = ratingSummary(data, start, end).average

    fun ratingSummary(data: JsonObject, start: String, end: String): RatingSummary {
        val scores = merge(data).rows(keys[2]).filter { !it.flag("deleted") && it.text("date") in start..end }
            .mapNotNull { it.getValue("score").jsonPrimitive.intOrNull }
        val days = date(end).toEpochDay() - date(start).toEpochDay() + 1
        val average = if (scores.isEmpty()) null else BigDecimal(scores.sumOf(Int::toLong))
            .divide(BigDecimal(scores.size), 1, RoundingMode.HALF_UP).toPlainString()
        return RatingSummary(average, scores.size, days)
    }

    fun change(data: JsonObject, action: JsonObject, id: String, at: String): JsonObject? {
        val kind = action.text("kind")
        if (kind == "rate") {
            val day = action.text("date")
            date(day)
            val existing = merge(data).rows(keys[2]).find { it.text("date") == day }
            if (existing == null && action["score"] == JsonNull) return null
            val rating = normalize(buildJsonObject {
                existing?.forEach { (key, value) -> put(key, value) }
                put("id", existing?.id() ?: id)
                put("date", day)
                put("score", action.getValue("score"))
                put("created_at", existing?.text("created_at") ?: at)
                put("updated_at", at)
                put("deleted", false)
            }, 2)
            return buildJsonObject { put("type", "planning.rating.put"); put("rating", rating) }
        }
        val week = action.text("week")
        val current = state(data, week)
        require(action.getValue("tips").jsonArray.map { it.jsonPrimitive.content } == current.tips) { "WEEKLY_PLAN_STALE" }
        val versionId = action.text("versionId")
        if (kind == "delete") {
            val target = current.history.find { it.id() == versionId }
            if (target == null) {
                require(merge(data).rows(keys[0]).any { it.id() == versionId && it.text("week_start") == week && it.flag("deleted") })
                return null
            }
            require(current.candidates.none { it.id() == versionId }) { "WEEKLY_PLAN_STALE" }
            return buildJsonObject {
                put("type", "planning.version.delete")
                put("version", JsonObject(target + mapOf("deleted" to JsonPrimitive(true),
                    "updated_at" to JsonPrimitive(at), "deleted_at" to JsonPrimitive(at))))
            }
        }
        val selection = buildJsonObject {
            put("id", id)
            put("week_start", week)
            put("version_id", versionId)
            put("parent_selection_ids", JsonArray(current.tips.map(::JsonPrimitive)))
            put("kind", if (kind == "resolve") "resolve" else "save")
            put("created_at", at)
            put("updated_at", at)
        }
        if (kind == "resolve") {
            require(current.status == "conflict" && current.candidates.any { it.id() == versionId && !it.flag("deleted") })
            return buildJsonObject { put("type", "planning.selection.resolve"); put("selection", selection) }
        }
        val days = action.getValue("days").jsonArray
        require(kind == "save" && current.status in listOf("empty", "current", "restart") &&
            days.size == 7 && days.all { it.jsonPrimitive.isString } &&
            (current.status == "current" || days.any { it.jsonPrimitive.content.isNotBlank() }))
        require(merge(data).rows(keys[0]).none { it.id() == versionId }) { "WEEKLY_PLAN_ID_CONFLICT" }
        val version = buildJsonObject {
            put("id", versionId)
            put("week_start", week)
            put("base_version_id", current.current?.id()?.let(::JsonPrimitive) ?: JsonNull)
            put("days", days)
            put("change_reason", action.text("reason"))
            put("created_at", at)
            put("updated_at", at)
            put("deleted", false)
            put("deleted_at", JsonNull)
        }
        return buildJsonObject {
            put("type", "planning.version.save")
            put("version", version)
            put("selection", selection)
        }
    }

    fun apply(data: JsonObject, operations: List<JsonObject>): JsonObject {
        val additions = List(3) { mutableListOf<JsonObject>() }
        for (operation in operations) {
            when (operation.text("type")) {
                "planning.version.save" -> {
                    val version = normalize(operation.getValue("version").jsonObject, 0)
                    val selection = normalize(operation.getValue("selection").jsonObject, 1)
                    require(!version.flag("deleted") && selection.text("kind") == "save" && selection.text("version_id") == version.id())
                    additions[0].add(version)
                    additions[1].add(selection)
                }
                "planning.version.delete" -> additions[0].add(operation.getValue("version").jsonObject.also { require(it.flag("deleted")) })
                "planning.selection.resolve" -> additions[1].add(operation.getValue("selection").jsonObject.also { require(it.text("kind") == "resolve") })
                "planning.rating.put" -> additions[2].add(operation.getValue("rating").jsonObject)
                else -> error("UNSUPPORTED_RECORD_OPERATION")
            }
        }
        val source = JsonObject(keys.zip(additions.map(::JsonArray)).toMap())
        return JsonObject(data + merge(data, source))
    }

    internal fun validateRecords(baseline: JsonObject, records: List<com.todo.app.data.repository.Record>) {
        val parents = mutableMapOf<String, List<String>>()
        val changes = mutableMapOf<String, JsonObject>()
        for (record in records) {
            val own = record.operations.filter { it.text("type").startsWith("planning.") }
            parents[record.id] = record.parents.map { it.id }
            if (own.isEmpty()) continue
            require(record.operations.size == 1) { "INVALID_PLANNING_OPERATION" }
            val visited = mutableSetOf<String>()
            val stack = ArrayDeque(parents.getValue(record.id))
            while (stack.isNotEmpty()) {
                val id = stack.removeLast()
                if (visited.add(id)) stack.addAll(parents[id].orEmpty())
            }
            val view = apply(baseline, visited.mapNotNull(changes::get))
            val operation = own.single()
            val version = operation["version"]?.jsonObject
            val selection = operation["selection"]?.jsonObject
            val action = buildJsonObject {
                when (operation.text("type")) {
                    "planning.version.save" -> {
                        val row = requireNotNull(version)
                        put("kind", "save")
                        put("week", row.text("week_start"))
                        put("versionId", row.id())
                        put("days", row.getValue("days"))
                        put("reason", row.text("change_reason"))
                        put("tips", requireNotNull(selection).getValue("parent_selection_ids"))
                    }
                    "planning.version.delete" -> {
                        val row = requireNotNull(version)
                        val week = row.text("week_start")
                        put("kind", "delete")
                        put("week", week)
                        put("versionId", row.id())
                        put("tips", JsonArray(state(view, week).tips.map(::JsonPrimitive)))
                    }
                    "planning.selection.resolve" -> {
                        val row = requireNotNull(selection)
                        put("kind", "resolve")
                        put("week", row.text("week_start"))
                        put("versionId", row.text("version_id"))
                        put("tips", row.getValue("parent_selection_ids"))
                    }
                    "planning.rating.put" -> {
                        val rating = operation.getValue("rating").jsonObject
                        put("kind", "rate")
                        put("date", rating.text("date"))
                        put("score", rating.getValue("score"))
                    }
                    else -> error("UNSUPPORTED_RECORD_OPERATION")
                }
            }
            val expected = change(view, action, record.id, record.created_at)
            require(expected != null && canonical(expected) == canonical(operation)) { "INVALID_PLANNING_OPERATION" }
            changes[record.id] = operation
        }
    }
}
