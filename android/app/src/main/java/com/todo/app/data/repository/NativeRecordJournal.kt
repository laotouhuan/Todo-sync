package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.recordsync.canonical
import com.todo.app.data.recordsync.parse as parseRecordJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.security.MessageDigest
import java.util.Base64

private const val FORMAT = "lab-native-journal/1"
internal val recordId = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
internal val sha256 = Regex("[0-9a-f]{64}")
internal val recordFileName = Regex("records/${recordId.pattern}\\.${sha256.pattern}\\.json")

@Serializable
internal data class Artifact(val name: String, val content: String)

@Serializable
internal data class RecordFault(val code: String, val observed: Artifact)

internal data class RecordObservation(val artifact: Artifact, val confirm: Boolean = false)

@Serializable
internal data class Parent(val id: String, val sha256: String)

@Serializable
internal data class Record(
    val protocol: String,
    val dataset_id: String,
    val descriptor_sha256: String,
    val id: String,
    val actor_id: String,
    val parents: List<Parent>,
    val lamport: Long,
    val created_at: String,
    val operations: List<JsonObject>
)

internal data class JournalDependencies(val ready: List<String>, val missing: List<String>)

internal data class RecordCommitIntent(
    val observedSha256: String?,
    val id: String,
    val actorId: String,
    val createdAt: String,
    val operations: List<JsonObject>
)

@Serializable
internal data class JournalState(
    val dataset_id: String,
    val descriptor_sha256: String,
    val records: List<Artifact>,
    val pending: List<String>,
    val unread: List<String> = emptyList(),
    val fault: RecordFault? = null,
    val resolved_faults: List<RecordFault> = emptyList()
) {
    fun recordsForReplay(expected: JournalState): List<Record> {
        require(fault == null) { "RECORD_DATASET_FROZEN" }
        val dependencies = dependencies(expected)
        require(dependencies.missing.isEmpty()) { "RECORD_DEPENDENCIES_MISSING" }
        val byName = records.associateBy { it.name }
        return dependencies.ready.map { name ->
            Json.decodeFromString<Record>(bytes(byName.getValue(name).content).decodeToString(throwOnInvalidSequence = true))
        }
    }

    fun dependencies(expected: JournalState): JournalDependencies {
        require(dataset_id == expected.dataset_id && descriptor_sha256 == expected.descriptor_sha256 &&
            recordId.matches(dataset_id) && sha256.matches(descriptor_sha256)) { "RECORD_TARGET_MISMATCH" }
        for (evidence in listOfNotNull(fault) + resolved_faults) {
            require(evidence.code in setOf("RECORD_REMOTE_BYTES_CHANGED", "RECORD_REMOTE_INVALID") &&
                recordFileName.matches(evidence.observed.name) && bytes(evidence.observed.content).size <= 1024 * 1024) {
                "RECORD_INVALID_FAULT"
            }
        }
        val byId = mutableMapOf<String, Pair<Record, String>>()
        val names = mutableSetOf<String>()
        for (artifact in records) {
            val raw = bytes(artifact.content)
            require(raw.size <= 1024 * 1024) { "RECORD_SIZE_LIMIT" }
            parseRecordJson(raw, strict = true)
            val record = Json.decodeFromString<Record>(raw.decodeToString(throwOnInvalidSequence = true))
            require(record.protocol == "todo-record-sync/1" && recordId.matches(record.id) && recordId.matches(record.actor_id) &&
                record.dataset_id == dataset_id && record.descriptor_sha256 == descriptor_sha256 && record.created_at.isNotEmpty() &&
                record.lamport in 1..9_007_199_254_740_991L && record.operations.isNotEmpty() &&
                record.operations.all { it["type"]?.jsonPrimitive?.let { type -> type.isString && type.content.isNotEmpty() } == true } &&
                artifact.name == "records/${record.id}.${digest(raw)}.json" && record.id !in byId) { "RECORD_INVALID_OR_DUPLICATE" }
            var previous = ""
            for (parent in record.parents) {
                require(parent.id > previous && parent.id != record.id && recordId.matches(parent.id) &&
                    sha256.matches(parent.sha256)) { "RECORD_INVALID_PARENT" }
                previous = parent.id
            }
            byId[record.id] = record to artifact.name
            names.add(artifact.name)
        }
        require(pending.size == pending.toSet().size && pending.all { it in names }) {
            "RECORD_PENDING_WITHOUT_ARTIFACT"
        }
        require(unread.size == unread.toSet().size && unread.all { recordFileName.matches(it) && it !in names }) {
            "RECORD_INVALID_UNREAD_NAME"
        }
        val ordered = byId.values.sortedWith(compareBy<Pair<Record, String>> { it.first.lamport }
            .thenBy { it.first.actor_id }.thenBy { it.first.id })
        val available = mutableSetOf<String>()
        val ready = mutableListOf<String>()
        val missing = sortedSetOf<String>()
        for ((record, name) in ordered) {
            var complete = true
            var maximum = 0L
            for (parent in record.parents) {
                val expectedName = "records/${parent.id}.${parent.sha256}.json"
                val found = byId[parent.id]
                if (found == null) {
                    missing.add(expectedName)
                    complete = false
                } else {
                    require(found.second == expectedName) { "RECORD_PARENT_HASH_CONFLICT" }
                    require(found.first.lamport < record.lamport) { "RECORD_INVALID_PARENT_CLOCK" }
                    complete = complete && parent.id in available
                    maximum = maxOf(maximum, found.first.lamport)
                }
            }
            if (complete) {
                require(record.lamport == maximum + 1) { "RECORD_INVALID_PARENT_CLOCK" }
                available.add(record.id)
                ready.add(name)
            }
        }
        return JournalDependencies(ready, missing.toList())
    }

    fun union(other: JournalState): JournalState {
        other.dependencies(this)
        val merged = (records + other.records).distinct()
        val known = merged.mapTo(mutableSetOf()) { it.name }
        return copy(records = merged, pending = (pending + other.pending).distinct(),
            unread = (unread + other.unread).filterNot { it in known }.toSortedSet().toList(),
            fault = fault ?: other.fault, resolved_faults = (resolved_faults + other.resolved_faults).distinct())
            .also { it.dependencies(this) }
    }

    fun acknowledge(name: String, remote: ByteArray): JournalState {
        val stored = records.find { it.name == name } ?: error("RECORD_NOT_FOUND")
        require(bytes(stored.content).contentEquals(remote)) { "RECORD_ACK_MISMATCH" }
        return copy(pending = pending - name)
    }

    fun observe(observation: RecordObservation): JournalState {
        val artifact = observation.artifact
        require(recordFileName.matches(artifact.name) && bytes(artifact.content).size <= 1024 * 1024) {
            "RECORD_INVALID_OBSERVATION"
        }
        val local = records.find { it.name == artifact.name }
        if (local != null) {
            if (local.content != artifact.content) return copy(fault = RecordFault("RECORD_REMOTE_BYTES_CHANGED", artifact))
            return if (observation.confirm) copy(pending = pending - artifact.name) else this
        }
        require(!observation.confirm) { "RECORD_NOT_FOUND" }
        val incoming = copy(records = listOf(artifact), pending = emptyList(), unread = emptyList(),
            fault = null, resolved_faults = emptyList())
        return runCatching { union(incoming) }.getOrElse { copy(fault = RecordFault("RECORD_REMOTE_INVALID", artifact)) }
    }

    fun resolveChangedObject(restored: Artifact): JournalState {
        val evidence = fault ?: error("RECORD_FAULT_NOT_FOUND")
        require(evidence.code == "RECORD_REMOTE_BYTES_CHANGED") { "RECORD_FAULT_REQUIRES_REVIEW" }
        require(restored.name == evidence.observed.name && restored in records) { "RECORD_REPAIR_BYTES_MISMATCH" }
        return copy(fault = null, resolved_faults = (resolved_faults + evidence).distinct())
    }

    fun noteDiscovered(names: List<String>): JournalState {
        require(names.all(recordFileName::matches)) { "RECORD_INVALID_REMOTE_NAME" }
        val known = records.mapTo(mutableSetOf()) { it.name }
        return copy(unread = (unread + names).filterNot { it in known }.toSortedSet().toList())
    }

    fun stageLocal(intent: RecordCommitIntent, currentSha256: String?): Pair<JournalState, Artifact> {
        require(recordId.matches(intent.id) && recordId.matches(intent.actorId) && intent.operations.isNotEmpty() &&
            (intent.observedSha256 == null || sha256.matches(intent.observedSha256)) &&
            runCatching { NormalTodoConflict.timestampMillis(intent.createdAt) }.isSuccess) { "INVALID_RECORD_INTENT" }
        val dependencies = dependencies(this)
        val hashes = sortedMapOf<String, String>()
        val referenced = mutableSetOf<String>()
        var maximum = 0L
        for (artifact in records) {
            val raw = bytes(artifact.content)
            val record = Json.decodeFromString<Record>(raw.decodeToString(throwOnInvalidSequence = true))
            if (record.id == intent.id) {
                require(record.actor_id == intent.actorId && record.created_at == intent.createdAt &&
                    NormalTodoConflict.canonicalDigest(JsonArray(record.operations)) ==
                    NormalTodoConflict.canonicalDigest(JsonArray(intent.operations))) { "RECORD_ID_CONTENT_CONFLICT" }
                return this to artifact
            }
            maximum = maxOf(maximum, record.lamport)
            referenced.addAll(record.parents.map { it.id })
            hashes[record.id] = digest(raw)
        }
        require(intent.observedSha256 == currentSha256) { "RECORD_WRITE_STALE" }
        require(dependencies.missing.isEmpty()) { "RECORD_DEPENDENCIES_MISSING" }
        val parents = hashes.filterKeys { it !in referenced }.map { (id, hash) -> Parent(id, hash) }
        val record = Record("todo-record-sync/1", dataset_id, descriptor_sha256, intent.id, intent.actorId, parents,
            maximum + 1, intent.createdAt, intent.operations)
        val raw = canonical(parseRecordJson(Json.encodeToString(record).encodeToByteArray(), strict = false))
        val artifact = Artifact("records/${record.id}.${digest(raw)}.json", base64(raw))
        return union(copy(records = listOf(artifact), pending = listOf(artifact.name), unread = emptyList())) to artifact
    }
}

@Serializable
internal data class Envelope(val format: String, val sha256: String, val payload: String)

private fun digest(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

internal fun bytes(text: String): ByteArray = Base64.getDecoder().decode(text).also {
    require(base64(it) == text) { "RECORD_NONCANONICAL_BASE64" }
}

// 调用方在目标专属锁内提交；记录和队列共用一次原子写入。
internal fun save(writer: AtomicJsonFile, state: JournalState, expected: JournalState) {
    writer.write(encodeJournalEnvelope(state, expected))
}

internal fun encodeJournalEnvelope(state: JournalState, expected: JournalState): String {
    state.dependencies(expected)
    val payload = Json.encodeToString(state).encodeToByteArray()
    return Json.encodeToString(Envelope(FORMAT, digest(payload), base64(payload)))
}

internal fun load(file: File, expected: JournalState): JournalState = decodeJournalEnvelope(file.readText(), expected)

internal fun decodeJournalEnvelope(content: String, expected: JournalState): JournalState {
    val envelope = Json.decodeFromString<Envelope>(content)
    val payload = bytes(envelope.payload)
    require(envelope.format == FORMAT && digest(payload) == envelope.sha256) { "RECORD_JOURNAL_CORRUPT" }
    return Json.decodeFromString<JournalState>(payload.decodeToString(throwOnInvalidSequence = true)).also {
        it.dependencies(expected)
    }
}
