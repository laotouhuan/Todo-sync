package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.recordsync.parse
import com.todo.app.data.recordsync.sha
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private const val PROTOCOL = "todo-record-sync/1"

@Serializable
internal data class RecordDatasetPin(
    val protocol: String,
    val dataset_id: String,
    val descriptor_sha256: String,
    val baseline_sha256: String,
    val namespace: String
) {
    fun validate() {
        require(protocol == PROTOCOL && recordId.matches(dataset_id) && sha256.matches(descriptor_sha256) &&
            sha256.matches(baseline_sha256) && namespace == "record-sync/$dataset_id/") { "INVALID_DATASET_PIN" }
    }

    fun emptyJournal() = JournalState(dataset_id, descriptor_sha256, emptyList(), emptyList())
}

@Serializable
private data class Descriptor(
    val protocol: String,
    val dataset_id: String,
    val baseline_sha256: String,
    val data_schema_version: Int,
    val operation_set: String,
    val created_at: String
)

@Serializable
private data class Baseline(val protocol: String, val dataset_id: String, val data: JsonObject)

internal data class RecordRecoveryPreview(
    val journal: JournalState,
    val missing: List<String>,
    val view: JsonObject?,
    val submitted: Artifact? = null,
    val focusHistory: Boolean = false
)

internal data class RecordRepair(val observedSha256: String, val restored: Artifact)

private inline fun <reified T> openArtifact(content: String, expectedHash: String): T {
    val raw = bytes(content)
    require(sha(raw) == expectedHash) { "DATASET_HASH_MISMATCH" }
    parse(raw, strict = true)
    return Json.decodeFromString(raw.decodeToString(throwOnInvalidSequence = true))
}

// 调用方从已选目标提供 pin。恢复包只提供记录，不能改绑目标。
internal fun previewRecordRecovery(
    pin: RecordDatasetPin,
    descriptor: String,
    baseline: String,
    current: String? = null,
    backup: String? = null,
    received: List<Artifact> = emptyList(),
    intent: RecordCommitIntent? = null,
    discovered: List<String> = emptyList(),
    confirmed: List<Artifact> = emptyList(),
    observation: RecordObservation? = null,
    repair: RecordRepair? = null
): RecordRecoveryPreview {
    val importing = backup != null || received.isNotEmpty() || discovered.isNotEmpty() || confirmed.isNotEmpty()
    require(intent == null || (!importing && observation == null)) {
        "RECORD_INTENT_MUST_BE_SEPARATE"
    }
    require(!importing || observation == null) { "RECORD_OBSERVATION_MUST_BE_SEPARATE" }
    require(repair == null || (!importing && intent == null && observation == null)) { "RECORD_REPAIR_MUST_BE_SEPARATE" }
    pin.validate()
    val fixed = openArtifact<Descriptor>(descriptor, pin.descriptor_sha256)
    val snapshot = openArtifact<Baseline>(baseline, pin.baseline_sha256)
    require(fixed.protocol == PROTOCOL && snapshot.protocol == PROTOCOL && fixed.dataset_id == pin.dataset_id &&
        snapshot.dataset_id == pin.dataset_id && fixed.baseline_sha256 == pin.baseline_sha256 &&
        fixed.data_schema_version == 1 && runCatching { NormalTodoConflict.timestampMillis(fixed.created_at) }.isSuccess) {
        "INVALID_DATASET_BINDING"
    }
    require(fixed.operation_set in setOf(LEGACY_SERIES_OPERATION_SET, CAUSAL_SERIES_OPERATION_SET, PLANNING_OPERATION_SET, CLOUD_PLANNING_OPERATION_SET)) {
        "UNSUPPORTED_RECORD_OPERATION_SET"
    }
    val expected = pin.emptyJournal()
    val currentState = current?.let { decodeJournalEnvelope(it, expected) } ?: expected
    require(currentState.fault == null || (!importing && intent == null && observation == null)) { "RECORD_DATASET_FROZEN" }
    val restored = if (backup == null) currentState else currentState.union(decodeJournalEnvelope(backup, expected))
    val receivedState = confirmed.fold(restored.union(expected.copy(records = received)).noteDiscovered(discovered)) { state, remote ->
        state.acknowledge(remote.name, bytes(remote.content))
    }
    var observed = if (observation == null) receivedState else receivedState.observe(observation)
    if (repair != null) {
        require(current?.encodeToByteArray()?.let(::sha) == repair.observedSha256) { "RECORD_RECOVERY_PREVIEW_STALE" }
        observed = observed.resolveChangedObject(repair.restored)
    }
    val (journal, submitted) = if (intent == null) observed to null
    else observed.stageLocal(intent, current?.encodeToByteArray()?.let(::sha))
    val missing = journal.dependencies(expected).missing
    val view = if (missing.isEmpty() && journal.fault == null) replayPersonalRecords(snapshot.data, journal, expected, fixed.operation_set) else null
    val focusHistory = view != null && fixed.operation_set in setOf(PLANNING_OPERATION_SET, CLOUD_PLANNING_OPERATION_SET) &&
        journal.recordsForReplay(expected).any { record ->
            record.operations.any { operation -> (operation["version"] as? JsonObject)?.containsKey("focus") == true }
        }
    return RecordRecoveryPreview(journal, missing, view, submitted, focusHistory)
}
