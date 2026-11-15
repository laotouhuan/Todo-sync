import com.todo.app.data.recordsync.*
import java.io.ByteArrayOutputStream
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.time.LocalDate
import kotlinx.serialization.json.*

private fun hex(text: String): ByteArray {
    if (text.length % 2 != 0 || !text.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' } || text.length > MAX_BYTES * 2) bad("INVALID_HEX")
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

private fun obj(value: Value): Map<String, Value> = (value as? Obj)?.values ?: bad("EXPECTED_OBJECT")
private fun str(value: Value?): String = (value as? Str)?.value ?: bad("EXPECTED_STRING")
private fun exact(value: Value, keys: List<String>): Map<String, Value> = obj(value).also { if (it.keys != keys.toSet()) bad("INVALID_FIELDS") }
private val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
private val SHA = Regex("[0-9a-f]{64}")
private fun uuid(value: Value?): String = str(value).also { if (!UUID.matches(it)) bad("INVALID_UUID") }
private fun digest(value: Value?): String = str(value).also { if (!SHA.matches(it)) bad("INVALID_SHA") }
private fun timestamp(text: String): Long {
    val match = Regex("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})").matchEntire(text) ?: bad("INVALID_TIMESTAMP")
    val groups = match.groupValues
    val day = try { LocalDate.of(groups[1].toInt(), groups[2].toInt(), groups[3].toInt()) } catch (_: Exception) { bad("INVALID_TIMESTAMP") }
    val hour = groups[4].toInt(); val minute = groups[5].toInt(); val second = groups[6].toInt()
    if (hour > 23 || minute > 59 || second > 59) bad("INVALID_TIMESTAMP")
    val zone = groups[8]
    val offset = if (zone == "Z") 0 else {
        val hours = zone.substring(1, 3).toInt(); val minutes = zone.substring(4, 6).toInt()
        if (hours > 23 || minutes > 59) bad("INVALID_TIMESTAMP")
        (hours * 3600 + minutes * 60) * if (zone[0] == '+') 1 else -1
    }
    val milliseconds = (groups[7] + "000").take(3).toInt()
    return (day.toEpochDay() * 86400 + hour * 3600 + minute * 60 + second - offset) * 1000 + milliseconds
}

private fun pin(value: Value): Map<String, Value> {
    val fields = exact(value, listOf("protocol", "dataset_id", "descriptor_sha256", "baseline_sha256", "namespace"))
    if (str(fields["protocol"]) != "todo-record-sync/1") bad("INVALID_PROTOCOL")
    val dataset = uuid(fields["dataset_id"])
    digest(fields["descriptor_sha256"]); digest(fields["baseline_sha256"])
    if (str(fields["namespace"]) != "record-sync/$dataset/") bad("INVALID_NAMESPACE")
    return fields
}
private fun join(pin: Value, descriptorBytes: ByteArray, baselineBytes: ByteArray) {
    val identity = pin(pin)
    if (sha(descriptorBytes) != str(identity["descriptor_sha256"]) || sha(baselineBytes) != str(identity["baseline_sha256"])) bad("DATASET_HASH_MISMATCH")
    val descriptor = exact(parse(descriptorBytes, true), listOf("protocol", "dataset_id", "baseline_sha256", "data_schema_version", "operation_set", "created_at"))
    val baseline = exact(parse(baselineBytes, true), listOf("protocol", "dataset_id", "data"))
    if (descriptor["protocol"] != identity["protocol"] || descriptor["dataset_id"] != identity["dataset_id"] || descriptor["baseline_sha256"] != identity["baseline_sha256"] ||
        (descriptor["data_schema_version"] as? Num)?.value != 1.0 || str(descriptor["operation_set"]) != "lab-note/1" ||
        baseline["protocol"] != identity["protocol"] || baseline["dataset_id"] != identity["dataset_id"] || baseline["data"] !is Obj) bad("INVALID_DATASET_BINDING")
    timestamp(str(descriptor["created_at"]))
}
private fun record(identity: Value, name: String, bytes: ByteArray) {
    val pinned = pin(identity)
    val filename = Regex("records/([0-9a-f-]+)\\.([0-9a-f]{64})\\.json").matchEntire(name) ?: bad("INVALID_RECORD_FILENAME")
    if (!UUID.matches(filename.groupValues[1]) || sha(bytes) != filename.groupValues[2]) bad("RECORD_FILENAME_HASH_MISMATCH")
    val fields = exact(parse(bytes, true), listOf("protocol", "dataset_id", "descriptor_sha256", "id", "actor_id", "parents", "lamport", "created_at", "operations"))
    if (fields["protocol"] != pinned["protocol"] || fields["dataset_id"] != pinned["dataset_id"] || fields["descriptor_sha256"] != pinned["descriptor_sha256"] ||
        str(fields["id"]) != filename.groupValues[1]) bad("INVALID_RECORD_BINDING")
    uuid(fields["actor_id"]); timestamp(str(fields["created_at"]))
    val clock = (fields["lamport"] as? Num)?.value ?: bad("INVALID_LAMPORT")
    if (clock < 1.0 || clock > 9007199254740991.0 || clock % 1.0 != 0.0) bad("INVALID_LAMPORT")
    val parents = (fields["parents"] as? Arr)?.values ?: bad("INVALID_PARENTS")
    val ids = mutableSetOf<String>(); var previous: Pair<String, String>? = null
    for (parent in parents) {
        val reference = exact(parent, listOf("id", "sha256"))
        val parentId = uuid(reference["id"]); val parentHash = digest(reference["sha256"])
        if (parentId == str(fields["id"]) || !ids.add(parentId)) bad("INVALID_PARENT_REFERENCE")
        val old = previous
        if (old != null && (old.first > parentId || old.first == parentId && old.second > parentHash)) bad("UNSORTED_PARENT_REFERENCES")
        previous = parentId to parentHash
    }
    val operations = (fields["operations"] as? Arr)?.values ?: bad("INVALID_OPERATIONS")
    if (operations.isEmpty()) bad("INVALID_OPERATIONS")
    for (operation in operations) {
        val op = exact(operation, listOf("type", "key", "value"))
        if (str(op["type"]) != "lab.note.set" || str(op["key"]).isEmpty()) bad("UNSUPPORTED_OPERATION")
        str(op["value"])
    }
}

// 业务平局排序沿用现有学习记录的UTF-16词序，不用JCS字节顺序代替。
private fun learning(value: Value): String = when (value) {
    Nil -> "n"
    is Bool -> if (value.value) "b1" else "b0"
    is Num -> "d" + number(value.value)
    is Str -> "s${value.value.length}:${value.value}"
    is Arr -> "a" + value.values.joinToString("") { learning(it) } + "e"
    is Obj -> "o" + value.values.keys.sorted().joinToString("") { learning(Str(it)) + learning(value.values.getValue(it)) } + "e"
}

private fun nullableString(value: Value) {
    if (value !== Nil && value !is Str) bad("INVALID_TODO_STRING")
}
private val TODO_UUID = Regex(UUID.pattern, RegexOption.IGNORE_CASE)
private fun optionalTimestamp(value: Value) {
    if (value !== Nil) timestamp(str(value))
}
private fun labelWhitespace(code: Int): Boolean = code in 9..13 || code == 32 || code == 160 || code == 5760 ||
    code in 8192..8202 || code == 8232 || code == 8233 || code == 8239 || code == 8287 || code == 12288 || code == 65279
private fun todoLabel(value: Value): Value {
    if (value !is Str) return Nil
    var start = 0; var end = value.value.length
    while (start < end && labelWhitespace(value.value[start].code)) start++
    while (end > start && labelWhitespace(value.value[end - 1].code)) end--
    val normalized = java.text.Normalizer.normalize(value.value.substring(start, end), java.text.Normalizer.Form.NFC)
    return if (normalized.isEmpty() || normalized == "未分类") Nil else Str(normalized)
}

// 普通任务实验只补缺失字段；子任务、提醒及所有未知扩展保留，不借机改动打卡规则。
private fun normalizeTodo(raw: Value): Obj {
    val fields = obj(raw).toMutableMap()
    val defaults = linkedMapOf<String, Value>(
        "date" to Nil, "time" to Nil, "completed_at" to Nil, "label" to Nil, "reminder" to Nil,
        "completed" to Bool(false), "deleted" to Bool(false), "order" to Num(0.0), "recurring" to Str("none"),
        "task_type" to Str("normal"), "completed_dates" to Arr(emptyList()), "target_count" to Nil, "subtasks" to Arr(emptyList())
    )
    for ((name, default) in defaults) if (!fields.containsKey(name)) fields[name] = default
    val todoId = str(fields["id"])
    if (!TODO_UUID.matches(todoId)) bad("INVALID_TODO_ID")
    str(fields["content"])
    val created = str(fields["created_at"]); timestamp(created)
    val updated = fields["updated_at"]
    if (updated == null || updated === Nil || updated is Str && updated.value.isEmpty()) fields["updated_at"] = Str(created)
    else timestamp(str(updated))
    if (str(fields["task_type"]) != "normal") bad("NON_NORMAL_TODO")
    for (name in listOf("date", "time")) nullableString(fields.getValue(name))
    optionalTimestamp(fields.getValue("completed_at"))
    for (name in listOf("completed", "deleted")) if (fields[name] !is Bool) bad("INVALID_TODO_BOOLEAN")
    if (fields["order"] !is Num || !(fields["order"] as Num).value.isFinite()) bad("INVALID_TODO_ORDER")
    str(fields["recurring"])
    val dates = fields["completed_dates"] as? Arr ?: bad("INVALID_COMPLETED_DATES")
    dates.values.forEach { str(it) }
    val target = fields["target_count"] as? Num
    fields["target_count"] = if (target != null && target.value > 0 && target.value <= 9007199254740991.0 && target.value % 1.0 == 0.0) target else Nil
    fields["label"] = todoLabel(fields.getValue("label"))
    val subtasks = fields["subtasks"] as? Arr ?: bad("INVALID_SUBTASKS")
    fields["subtasks"] = Arr(subtasks.values.map { value ->
        val child = obj(value).toMutableMap()
        str(child["id"]); str(child["content"])
        if (!child.containsKey("completed")) child["completed"] = Bool(false)
        if (!child.containsKey("completed_at")) child["completed_at"] = Nil
        if (child["completed"] !is Bool) bad("INVALID_SUBTASK_BOOLEAN")
        optionalTimestamp(child.getValue("completed_at"))
        Obj(child)
    })
    val reminder = fields.getValue("reminder")
    if (reminder !== Nil) {
        val settings = obj(reminder).toMutableMap()
        str(settings["reminder_time"])
        if (!settings.containsKey("reminder_date")) settings["reminder_date"] = Nil
        if (!settings.containsKey("repeat_daily")) settings["repeat_daily"] = Bool(false)
        nullableString(settings.getValue("reminder_date"))
        if (settings["repeat_daily"] !is Bool) bad("INVALID_REMINDER_BOOLEAN")
        fields["reminder"] = Obj(settings)
    }
    return Obj(fields)
}

private fun todoBusiness(records: JsonArray): JsonArray {
    data class Candidate(val normalized: Obj, val time: Long, val businessKey: String, val metadataKey: String)
    val winners = sortedMapOf<String, Candidate>()
    for (raw in records) {
        val normalized = normalizeTodo(Parser(raw.toString()).parse())
        val fields = normalized.values
        val candidate = Candidate(normalized, timestamp(str(fields["updated_at"])),
            learning(Obj(fields.filterKeys { it !in setOf("id", "created_at", "updated_at") })), sha(canonical(normalized)))
        val previous = winners[str(fields["id"])]
        val comparison = if (previous == null) 1 else candidate.time.compareTo(previous.time).takeIf { it != 0 } ?:
            candidate.businessKey.compareTo(previous.businessKey).takeIf { it != 0 } ?: candidate.metadataKey.compareTo(previous.metadataKey)
        if (comparison > 0) winners[str(fields["id"])] = candidate
    }
    return JsonArray(winners.values.map { Json.parseToJsonElement(render(it.normalized)) })
}

private fun business(domain: String, records: JsonArray): JsonArray {
    if (domain == "todo") return todoBusiness(records)
    if (domain !in listOf("review", "rating")) bad("INVALID_BUSINESS_DOMAIN")
    data class Candidate(val raw: JsonElement, val ast: Value, val time: Long)
    val winners = sortedMapOf<String, Candidate>()
    for (raw in records) {
        val ast = Parser(raw.toString()).parse(); val fields = obj(ast)
        val day = str(fields["date"]); val current = Candidate(raw, ast, timestamp(str(fields["updated_at"])))
        val previous = winners[day]
        val compare = if (previous == null) 1 else {
            val old = obj(previous.ast)
            current.time.compareTo(previous.time).takeIf { it != 0 } ?:
                ((fields["deleted"] as? Bool)?.value == true).compareTo((old["deleted"] as? Bool)?.value == true).takeIf { it != 0 } ?:
                (if (domain == "rating") (fields["score"] == Nil).compareTo(old["score"] == Nil) else 0).takeIf { it != 0 } ?:
                learning(ast).compareTo(learning(previous.ast))
        }
        if (compare > 0) winners[day] = current
    }
    return JsonArray(winners.values.map { it.raw })
}

private fun request(raw: String): JsonObject {
    var id: JsonElement = JsonNull
    try {
        val input = Json.parseToJsonElement(raw).jsonObject
        id = input["id"] ?: JsonNull
        fun field(name: String): String {
            val value = input[name] as? JsonPrimitive ?: bad("MISSING_REQUEST_FIELD")
            if (!value.isString) bad("EXPECTED_REQUEST_STRING")
            return value.content
        }
        val reply = linkedMapOf<String, JsonElement>("id" to id, "ok" to JsonPrimitive(true))
        when (field("kind")) {
            "canonicalize" -> {
                val encoded = canonical(parse(validString(field("input")).toByteArray(Charsets.UTF_8), false))
                reply["canonical"] = JsonPrimitive(utf8(encoded)); reply["sha256"] = JsonPrimitive(sha(encoded))
            }
            "decode" -> {
                val encoded = canonical(parse(hex(field("hex")), true))
                reply["canonical"] = JsonPrimitive(utf8(encoded)); reply["sha256"] = JsonPrimitive(sha(encoded))
            }
            "number" -> {
                val bits = field("hex")
                if (!Regex("[0-9a-fA-F]{16}").matches(bits)) bad("INVALID_NUMBER_BITS")
                val encoded = canonical(Num(java.lang.Double.longBitsToDouble(java.lang.Long.parseUnsignedLong(bits, 16))))
                reply["canonical"] = JsonPrimitive(utf8(encoded)); reply["sha256"] = JsonPrimitive(sha(encoded))
            }
            "join" -> join(Parser((input["pin"] ?: bad("MISSING_PIN")).toString()).parse(), hex(field("descriptor_hex")), hex(field("baseline_hex")))
            "record" -> record(Parser((input["pin"] ?: bad("MISSING_PIN")).toString()).parse(), field("name"), hex(field("hex")))
            "business" -> reply["winners"] = business(field("domain"), input["records"] as? JsonArray ?: bad("INVALID_BUSINESS_RECORDS"))
            else -> bad("UNKNOWN_REQUEST_KIND")
        }
        return JsonObject(reply)
    } catch (_: Exception) { return JsonObject(mapOf("id" to id, "ok" to JsonPrimitive(false))) }
}

fun main() {
    val output = PrintWriter(OutputStreamWriter(System.out, Charsets.UTF_8), true)
    val buffer = ByteArrayOutputStream(); var oversized = false
    while (true) {
        val byte = System.`in`.read()
        if (byte < 0 || byte == 10) {
            if (buffer.size() > 0 || oversized) {
                val response = try { if (oversized) bad("REQUEST_SIZE_LIMIT"); request(utf8(buffer.toByteArray())) }
                    catch (_: Exception) { JsonObject(mapOf("id" to JsonNull, "ok" to JsonPrimitive(false))) }
                output.println(response.toString())
            }
            buffer.reset(); oversized = false
            if (byte < 0) break
        } else if (!oversized) {
            if (buffer.size() >= MAX_BYTES * 4) { oversized = true; buffer.reset() } else buffer.write(byte)
        }
    }
}
