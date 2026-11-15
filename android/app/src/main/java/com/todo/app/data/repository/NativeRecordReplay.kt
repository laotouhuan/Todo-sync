package com.todo.app.data.repository

import com.todo.app.data.model.WeeklyPlanning

import com.todo.app.data.model.MergeUtils
import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.model.ReminderSettings
import com.todo.app.data.model.ReminderSettingsConflict
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.time.LocalDate
import java.time.temporal.IsoFields

private val replayJson = Json { encodeDefaults = true }
private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE)
private val calendarDay = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
private val clock = NormalTodoConflict::timestampMillis
private val normalTypes = setOf("todo.normal.put", "todo.normal.delete")
private val periodTypes = setOf("todo.period.create", "todo.period.put", "todo.period.delete")
private val checkinTypes = setOf("checkin.mark", "checkin.clear")
private const val collaborationCreate = "collaboration.todo.create"
private val ruleConditions = setOf("none_completed", "any_remaining", "unconditional")
private val ruleScopes = setOf("all", "today_only", "recurring_only")

private fun JsonObject.text(key: String): String =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("INVALID_RECORD_STRING")

private fun date(value: String): LocalDate? =
    if (calendarDay.matches(value)) runCatching { LocalDate.parse(value) }.getOrNull() else null

private fun recordWeek(day: LocalDate) = day.get(IsoFields.WEEK_BASED_YEAR).toString().padStart(4, '0') +
    "-W" + day.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR).toString().padStart(2, '0')

private data class DayActions(var cutoff: Long = Long.MIN_VALUE, val marks: MutableList<Pair<Long, String>> = mutableListOf())

private fun collectCheckin(
    checkins: MutableMap<String, MutableMap<String, DayActions>>, operation: JsonObject, type: String
) {
    val mark = type == "checkin.mark"
    val keys = setOf("type", "todo_id", "day", "updated_at")
    require(operation.keys == if (mark) keys + "value" else keys) { "INVALID_CHECKIN_OPERATION" }
    val id = operation.text("todo_id")
    val day = operation.text("day")
    require(id.isNotEmpty() && date(day) != null) { "INVALID_CHECKIN_OPERATION" }
    val millis = clock(operation.text("updated_at"))
    val actions = checkins.getOrPut(id) { mutableMapOf() }.getOrPut(day) { DayActions() }
    if (mark) {
        val value = operation.text("value")
        require(value.substringBefore('T') == day) { "CHECKIN_VALUE_DAY_MISMATCH" }
        if (value != day) clock(value)
        actions.marks.add(millis to value)
    } else {
        actions.cutoff = maxOf(actions.cutoff, millis)
    }
}

private fun projectCheckins(row: JsonObject, todo: Todo, actions: Map<String, DayActions>, baseChanged: Boolean): JsonObject {
    val original = todo.completedDates
    val originalsByDay = original.groupBy { it.substringBefore('T') }
    val changed = linkedMapOf<String, String?>()
    for ((day, action) in actions.toSortedMap()) {
        val old = originalsByDay[day].orEmpty()
        val baseline = if (action.cutoff == Long.MIN_VALUE) old else emptyList()
        val surviving = action.marks.filter { it.first > action.cutoff }.map { it.second }
        val winner = (baseline + surviving).reduceOrNull(MergeUtils::chooseCheckinDate)
        if (old != listOfNotNull(winner)) changed[day] = winner
    }
    if (changed.isEmpty() && !baseChanged) return row
    val updated = original.filterNot { it.substringBefore('T') in changed } + changed.values.filterNotNull()
    val fields = row.toMutableMap()
    fields["completed_dates"] = JsonArray(updated.map(::JsonPrimitive))
    val target = todo.targetCount?.takeIf { it > 0 }
    if (target != null && todo.date != null) {
        val days = updated.mapNotNull { date(it.substringBefore('T')) }.toSet()
        val count = days.count { day ->
            val period = if (todo.taskType == TaskType.WEEKLY_CHECKIN) recordWeek(day) else day.toString().take(7)
            period == todo.date
        }
        val completed = count >= target
        fields["completed"] = JsonPrimitive(completed)
        fields["completed_at"] = if (completed && todo.completed) row["completed_at"] ?: JsonNull else JsonNull
    }
    return JsonObject(fields)
}

private fun validPeriod(todo: Todo): Boolean {
    val value = todo.date ?: return false
    if (todo.taskType == TaskType.MONTHLY_CHECKIN) return Regex("[0-9]{4}-(0[1-9]|1[0-2])").matches(value)
    if (todo.taskType != TaskType.WEEKLY_CHECKIN || !Regex("[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])").matches(value)) return false
    return value.takeLast(2) <= recordWeek(LocalDate.of(value.take(4).toInt(), 12, 28)).takeLast(2)
}

private fun encodeTodo(todo: Todo) = replayJson.encodeToJsonElement(Todo.serializer(), todo).jsonObject

private fun periodCandidate(operation: JsonObject, type: String): Todo {
    require(operation.keys == setOf("type", "todo")) { "UNSUPPORTED_OPERATION" }
    val raw = operation.getValue("todo").jsonObject
    val todo = replayJson.decodeFromJsonElement<Todo>(raw)
    require(todo.id.isNotEmpty() && validPeriod(todo)) { "INVALID_PERIOD_BASE" }
    clock(raw.text("created_at"))
    clock(raw.text("updated_at"))
    require(todo.targetCount == null || todo.targetCount!! > 0) { "INVALID_PERIOD_TARGET_COUNT" }
    require(todo.recurring in setOf("none", "daily_repeat")) { "INVALID_PERIOD_RECURRING" }
    require(todo.completedDates.isEmpty() && (todo.targetCount == null || !todo.completed && todo.completedAt == null)) {
        "PERIOD_BASE_INCLUDES_CHECKIN_PROJECTION"
    }
    todo.completedAt?.let(clock)
    val ids = mutableSetOf<String>()
    for (child in todo.subtasks) {
        require(child.id.isNotEmpty() && ids.add(child.id)) { "INVALID_PERIOD_SUBTASK_ID" }
        child.completedAt?.let(clock)
    }
    val normalized = NormalTodoConflict.validatePeriodCandidate(todo.copy(label = NormalTodoConflict.normalizeLabel(todo.label)))
    require(NormalTodoConflict.canonicalDigest(raw) == NormalTodoConflict.canonicalDigest(encodeTodo(normalized))) {
        "NON_NORMALIZED_PERIOD_BASE_OPERATION"
    }
    require(normalized.deleted == (type == "todo.period.delete")) { "PERIOD_BASE_DELETE_KIND_MISMATCH" }
    return normalized
}

private fun seesRecord(record: Record, creation: Record?, records: Map<String, Record>): Boolean {
    if (creation == null || record.id == creation.id) return true
    val stack = record.parents.map { it.id }.toMutableList()
    val visited = mutableSetOf<String>()
    while (stack.isNotEmpty()) {
        val id = stack.removeAt(stack.lastIndex)
        if (id == creation.id) return true
        if (!visited.add(id)) continue
        val parent = records.getValue(id)
        if (parent.lamport > creation.lamport) stack.addAll(parent.parents.map { it.id })
    }
    return false
}

private val extraWhitespace = setOf(32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
internal fun trimRecordText(value: String): String = value.trim { character ->
    val code = character.code
    code in 9..13 || code in 8192..8202 || code in extraWhitespace
}

private fun collaborationCandidate(operation: JsonObject): JsonObject {
    require(operation.keys == setOf("type", "todo")) { "INVALID_COLLABORATION_CREATE" }
    val row = operation.getValue("todo").jsonObject
    require(row.keys == setOf("id", "content", "date", "task_type", "target_count", "subtasks", "created_at", "order")) {
        "INVALID_COLLABORATION_TODO"
    }
    val id = row.text("id")
    val taskType = row.text("task_type")
    val order = row["order"] as? JsonPrimitive
    require(uuid.matches(id) && id == id.lowercase() && trimRecordText(row.text("content")).isNotEmpty() &&
        order != null && !order.isString && order.doubleOrNull?.isFinite() == true &&
        taskType in setOf(TaskType.NORMAL, TaskType.WEEKLY_CHECKIN, TaskType.MONTHLY_CHECKIN)) { "INVALID_COLLABORATION_TODO" }
    val created = row.text("created_at")
    clock(created)
    val target = row.getValue("target_count")
    if (target != JsonNull) {
        require(target is JsonPrimitive && !target.isString && target.intOrNull?.let { it > 0 } == true) { "INVALID_COLLABORATION_TARGET_COUNT" }
    }
    if (taskType == TaskType.NORMAL) {
        require(target == JsonNull) { "INVALID_COLLABORATION_TARGET_COUNT" }
        require(row["date"] == JsonNull || date(row.text("date")) != null) { "INVALID_COLLABORATION_DATE" }
    }
    val ids = mutableSetOf(id)
    for (item in row.getValue("subtasks").jsonArray) {
        val child = item.jsonObject
        require(child.keys == setOf("id", "content")) { "INVALID_COLLABORATION_SUBTASK" }
        val childId = child.text("id")
        require(uuid.matches(childId) && childId == childId.lowercase() && ids.add(childId) &&
            trimRecordText(child.text("content")).isNotEmpty()) { "INVALID_COLLABORATION_SUBTASK" }
    }
    val todo = replayJson.decodeFromJsonElement<Todo>(JsonObject(row + ("updated_at" to JsonPrimitive(created))))
    val type = if (taskType == TaskType.NORMAL) "todo.normal.put" else "todo.period.create"
    return JsonObject(mapOf("type" to JsonPrimitive(type), "todo" to encodeTodo(todo)))
}

private fun translateCollaborationRecords(ids: List<String>, records: List<Record>): List<Record> {
    val existing = ids.map { it.lowercase() }.toSet()
    val byId = records.associateBy { it.id }
    val creates = mutableMapOf<String, Record>()
    val translated = records.map { record ->
        val create = record.operations.find { it.text("type") == collaborationCreate }
        if (create == null) return@map record
        require(record.operations.size == 1) { "COLLABORATION_REQUIRES_ONE_CREATE" }
        val candidate = collaborationCandidate(create)
        val id = candidate.getValue("todo").jsonObject.text("id")
        require(id !in existing && id !in creates) { "COLLABORATION_TODO_ALREADY_EXISTS" }
        creates[id] = record
        record.copy(operations = listOf(candidate))
    }
    if (creates.isEmpty()) return translated
    for (record in records) for (operation in record.operations) {
        val type = operation.text("type")
        if (type !in normalTypes && type !in periodTypes) continue
        val id = operation.getValue("todo").jsonObject.text("id")
        val creator = creates[id.lowercase()] ?: continue
        require(id == id.lowercase() && seesRecord(record, creator, byId)) { "COLLABORATION_TODO_ID_CONFLICT" }
    }
    return translated
}

private class PeriodReplay(
    private val seeded: Map<String, Todo>,
    private val rawRows: Map<String, JsonObject>,
    records: List<Record>
) {
    private data class Entry(val identity: Todo, val original: JsonObject?, val creation: Record?, var winner: Todo?)

    private val byId = records.associateBy { it.id }
    private val periods = mutableMapOf<String, Entry>()
    private val checkins = mutableMapOf<String, MutableMap<String, DayActions>>()

    fun prepare(records: List<Record>): List<Record> {
        val normalIds = mutableSetOf<String>()
        val inherited = records.map { record ->
            for (operation in record.operations) {
                if (operation.text("type") != "todo.period.create") continue
                val todo = periodCandidate(operation, "todo.period.create")
                require(todo.id !in seeded && todo.id !in periods) { "PERIOD_CREATION_ID_CONFLICT" }
                require(uuid.matches(todo.id)) { "INVALID_NEW_PERIOD_TODO_ID" }
                periods[todo.id] = Entry(todo, null, record, todo)
            }
            val operations = record.operations.filter { operation ->
                val type = operation.text("type")
                if (type in normalTypes) normalIds.add(operation.getValue("todo").jsonObject.text("id"))
                if (type in periodTypes || type in checkinTypes) {
                    accept(record, operation, type)
                    false
                } else true
            }
            record.copy(operations = operations)
        }
        require(normalIds.none { it in periods }) { "PERIOD_NORMAL_ID_CONFLICT" }
        return inherited
    }

    private fun accept(record: Record, operation: JsonObject, type: String) {
        val todo = if (type in periodTypes) periodCandidate(operation, type) else null
        val id = todo?.id ?: operation.text("todo_id")
        val entry = periods.getOrPut(id) {
            val original = seeded[id] ?: error("PERIOD_TARGET_WITHOUT_CREATION")
            require(validPeriod(original) && !original.deleted) { "CHECKIN_TARGET_NOT_ACTIVE_PERIOD" }
            Entry(original, rawRows.getValue(id), null, null)
        }
        require(seesRecord(record, entry.creation, byId)) { "PERIOD_CREATION_NOT_IN_CAUSAL_HISTORY" }
        if (todo == null) {
            collectCheckin(checkins, operation, type)
            return
        }
        require(todo.taskType == entry.identity.taskType && todo.date == entry.identity.date) { "PERIOD_MOVE_UNSUPPORTED" }
        val legacy = if (entry.original != null) entry.identity.subtasks.map { it.id }.toSet() else emptySet()
        require(todo.subtasks.all { it.id in legacy || uuid.matches(it.id) }) { "INVALID_NEW_PERIOD_SUBTASK_ID" }
        val baseline = entry.identity
        val target = baseline.targetCount?.takeIf { it > 0 }
        val previous = entry.winner ?: baseline.copy(
            targetCount = target, completedDates = emptyList(),
            completed = target == null && baseline.completed,
            completedAt = baseline.completedAt.takeIf { target == null },
            label = NormalTodoConflict.normalizeLabel(baseline.label)
        )
        if (NormalTodoConflict.choosePeriodBase(previous, todo) === todo) entry.winner = todo
    }

    fun apply(rows: MutableMap<String, JsonObject>) {
        for ((id, entry) in periods) {
            val winner = entry.winner
            val baseline = entry.identity
            val original = entry.original
            var projected = winner ?: baseline
            if (winner != null && original != null) {
                val retainCompletion = winner.targetCount != null && winner.targetCount == baseline.targetCount && baseline.completed
                projected = winner.copy(completedDates = baseline.completedDates,
                    completed = retainCompletion || winner.completed,
                    completedAt = if (retainCompletion) baseline.completedAt else winner.completedAt)
            }
            val raw = if (winner == null) requireNotNull(original) else encodeTodo(projected)
            rows[id] = projectCheckins(raw, projected, checkins[id].orEmpty(), winner != null)
        }
    }
}

private fun applyReminderRecord(
    fields: MutableMap<String, JsonElement>, operation: JsonObject, known: MutableSet<String>, baselineTime: String
) {
    require(operation.keys == setOf("type", "settings")) { "INVALID_REMINDER_RECORD" }
    val raw = operation.getValue("settings").jsonObject
    val candidate = ReminderSettingsConflict.normalize(replayJson.decodeFromJsonElement<ReminderSettings>(raw))
    val encoded = replayJson.encodeToJsonElement(ReminderSettings.serializer(), candidate)
    require(NormalTodoConflict.canonicalDigest(raw) == NormalTodoConflict.canonicalDigest(encoded)) { "INVALID_REMINDER_RECORD" }
    clock(raw.text("updated_at"))
    val current = fields["reminder_settings"]?.let { replayJson.decodeFromJsonElement<ReminderSettings>(it) } ?: ReminderSettings()
    current.globalRules.forEach { known.add(it.id) }
    for (rule in candidate.globalRules) {
        require(rule.condition in ruleConditions && rule.taskScope in ruleScopes) { "UNSUPPORTED_REMINDER_RULE_ENUM" }
        require(rule.id in known || uuid.matches(rule.id)) { "INVALID_NEW_REMINDER_RULE_ID" }
        known.add(rule.id)
    }
    val fixed = TodoData(1, baselineTime, emptyList(), reminderSettings = current)
    val winner = ReminderSettingsConflict.choose(fixed, fixed.copy(reminderSettings = candidate))
    fields["reminder_settings"] = replayJson.encodeToJsonElement(ReminderSettings.serializer(), winner)
}

/** 在独立副本投影，调用方只在整批通过时采用结果。 */
internal const val PLANNING_OPERATION_SET = "lab-planning/1"
internal const val CLOUD_PLANNING_OPERATION_SET = "planning/1"

internal fun replayPersonalRecords(
    baseline: JsonObject, journal: JournalState, expected: JournalState, operationSet: String = LEGACY_SERIES_OPERATION_SET
): JsonObject {
    val records = journal.recordsForReplay(expected)
    val version = baseline["version"] as? JsonPrimitive
    require(version != null && !version.isString && version.intOrNull == 1) { "INVALID_RECORD_BASELINE" }
    if (operationSet == CLOUD_PLANNING_OPERATION_SET) {
        val types = setOf("planning.version.save", "planning.version.delete", "planning.selection.resolve", "planning.rating.put")
        require(baseline.getValue("todos").jsonArray.isEmpty() && records.all {
            it.operations.size == 1 && it.operations.single().text("type") in types
        }) { "INVALID_PLANNING_OPERATION" }
        WeeklyPlanning.validateRecords(baseline, records)
        return WeeklyPlanning.apply(baseline, records.flatMap { it.operations })
    }
    val planning = operationSet == PLANNING_OPERATION_SET
    val causalSeries = planning || operationSet == CAUSAL_SERIES_OPERATION_SET
    require(causalSeries || operationSet == LEGACY_SERIES_OPERATION_SET) { "UNSUPPORTED_RECORD_OPERATION_SET" }
    if (planning) WeeklyPlanning.validateRecords(baseline, records)
    val translated = translateCollaborationRecords(baseline.getValue("todos").jsonArray.map { it.jsonObject.text("id") }, records)
    val project = { data: JsonObject, events: List<Record> -> replayBaseRecords(data, events, planning) }
    return if (hasSeriesWorkflowRecords(translated, causalSeries)) replaySeriesWorkflows(baseline, translated, causalSeries, project)
    else project(baseline, translated)
}

private fun replayBaseRecords(baseline: JsonObject, records: List<Record>, planning: Boolean): JsonObject {
    val baselineTime = baseline.text("last_updated")
    clock(baselineTime)
    val rows = sortedMapOf<String, JsonObject>()
    val candidates = mutableMapOf<String, Todo>()
    val children = mutableMapOf<String, MutableSet<String>>()
    for (element in baseline.getValue("todos").jsonArray) {
        val row = element.jsonObject
        val todo = MergeUtils.migrateTodo(replayJson.decodeFromJsonElement<Todo>(row))
        require(todo.id !in rows) { "AMBIGUOUS_BASELINE_TODO_ID" }
        val normalized = if (todo.taskType == TaskType.NORMAL) NormalTodoConflict.normalize(todo) else todo
        candidates[todo.id] = normalized
        rows[todo.id] = if (todo.taskType == TaskType.NORMAL) replayJson.encodeToJsonElement(Todo.serializer(), normalized).jsonObject else row
        children[todo.id] = todo.subtasks.mapTo(mutableSetOf()) { it.id }
    }
    val fields = baseline.toMutableMap()
    val reminderRuleIds = mutableSetOf<String>()
    val learning = NativeLearningRecordReplay()
    val plans = mutableListOf<JsonObject>()
    val series = NativeSeriesRecordReplay(baseline, candidates.toMap())
    val translated = series.prepare(records)
    val periods = PeriodReplay(candidates.toMap(), rows.toMap(), translated)
    for (record in periods.prepare(translated)) {
        clock(record.created_at)
        for (operation in record.operations) {
            val type = operation.text("type")
            if (planning && type.startsWith("planning.")) {
                plans.add(operation)
                continue
            }
            if (learning.collect(operation, type)) continue
            if (type == "reminder.settings.put") {
                applyReminderRecord(fields, operation, reminderRuleIds, baselineTime)
                continue
            }
            require(type in normalTypes) { "UNSUPPORTED_RECORD_OPERATION" }
            require(operation.keys == setOf("type", "todo")) { "INVALID_NORMAL_RECORD" }
            val raw = operation.getValue("todo").jsonObject
            val candidate = NormalTodoConflict.normalize(MergeUtils.migrateTodo(replayJson.decodeFromJsonElement<Todo>(raw)))
            val encoded = replayJson.encodeToJsonElement(Todo.serializer(), candidate)
            require(candidate.deleted == (type == "todo.normal.delete") &&
                NormalTodoConflict.canonicalDigest(raw) == NormalTodoConflict.canonicalDigest(encoded)) { "INVALID_NORMAL_RECORD" }
            val previous = candidates[candidate.id]
            require(previous == null || previous.taskType == TaskType.NORMAL) { "NORMAL_RECORD_TARGET_TYPE_CONFLICT" }
            require(previous != null || uuid.matches(candidate.id)) { "INVALID_NEW_TODO_ID" }
            val known = children.getOrPut(candidate.id) { mutableSetOf() }
            for (child in candidate.subtasks) {
                require(child.id in known || uuid.matches(child.id)) { "INVALID_NEW_SUBTASK_ID" }
                known.add(child.id)
            }
            val winner = previous?.let { NormalTodoConflict.choose(it, candidate) } ?: candidate
            candidates[candidate.id] = winner
            rows[candidate.id] = replayJson.encodeToJsonElement(Todo.serializer(), winner).jsonObject
        }
    }
    periods.apply(rows)
    series.apply(fields)
    learning.apply(fields)
    fields["todos"] = JsonArray(rows.values.toList())
    records.lastOrNull()?.let { fields["last_updated"] = JsonPrimitive(it.created_at) }
    val result = JsonObject(fields)
    return if (planning) WeeklyPlanning.apply(result, plans) else result
}
