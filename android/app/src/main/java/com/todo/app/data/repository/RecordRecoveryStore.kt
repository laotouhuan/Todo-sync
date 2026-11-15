package com.todo.app.data.repository

import com.todo.app.data.recordsync.sha
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.io.OutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal data class RecordRecoveryInput(
    val pin: RecordDatasetPin,
    val descriptor: String,
    val baseline: String,
    val backup: String? = null,
    val received: List<Artifact> = emptyList(),
    val intent: RecordCommitIntent? = null,
    val discovered: List<String> = emptyList(),
    val confirmed: List<Artifact> = emptyList(),
    val observation: RecordObservation? = null,
    val repair: RecordRepair? = null
)

internal data class RecordRecoveryReceipt(val previousSha256: String?, val candidateSha256: String)

internal data class PreparedRecordRecovery(val preview: RecordRecoveryPreview, val receipt: RecordRecoveryReceipt)

internal data class SavedLocalRecord(val preview: RecordRecoveryPreview, val revision: String)

/** 使用调用方的应用私有目录。仓库应在 IO 线程调用。 */
internal class RecordRecoveryStore(private val root: File) {
    fun prepare(input: RecordRecoveryInput): PreparedRecordRecovery =
        withJournalLock(input.pin) { file -> prepare(input, readCurrent(file)).first }

    suspend fun recheckFault(binding: RecordRecoveryInput, transport: RecordTransport): RecordRecoveryPreview =
        withContext(Dispatchers.IO) {
            require(transport.namespace == binding.pin.namespace) { "RECORD_TRANSPORT_TARGET_MISMATCH" }
            val target = RecordRecoveryInput(binding.pin, binding.descriptor, binding.baseline)
            val state = prepare(target)
            val fault = state.preview.journal.fault ?: error("RECORD_FAULT_NOT_FOUND")
            require(fault.code == "RECORD_REMOTE_BYTES_CHANGED") { "RECORD_FAULT_REQUIRES_REVIEW" }
            val name = fault.observed.name
            val content = transport.read(name) ?: error("RECORD_REPAIR_OBJECT_MISSING")
            val request = target.copy(repair = RecordRepair(requireNotNull(state.receipt.previousSha256), Artifact(name, content)))
            commit(request, prepare(request).receipt)
        }

    fun exportFaultEvidence(pin: RecordDatasetPin, output: OutputStream) {
        val content = withJournalLock(pin) { file ->
            pin.validate()
            val raw = readCurrent(file) ?: error("RECORD_FAULT_NOT_FOUND")
            val journal = decodeJournalEnvelope(raw.decodeToString(throwOnInvalidSequence = true), pin.emptyJournal())
            require(journal.fault != null || journal.resolved_faults.isNotEmpty()) { "RECORD_FAULT_NOT_FOUND" }
            raw
        }
        output.write(content)
        output.flush()
    }

    fun submitLocal(input: RecordRecoveryInput, intent: RecordCommitIntent): SavedLocalRecord {
        val request = input.copy(intent = intent.copy(operations = intent.operations.toList()))
        val receipt = prepare(request).receipt
        return SavedLocalRecord(commit(request, receipt), receipt.candidateSha256)
    }

    fun commit(input: RecordRecoveryInput, receipt: RecordRecoveryReceipt): RecordRecoveryPreview =
        withJournalLock(input.pin) { file ->
            val current = readCurrent(file)
            require(current?.let(::sha) == receipt.previousSha256) { "RECORD_RECOVERY_PREVIEW_STALE" }
            val (prepared, envelope) = prepare(input, current)
            require(prepared.receipt == receipt) { "RECORD_RECOVERY_PREVIEW_STALE" }
            if (receipt.previousSha256 != receipt.candidateSha256) AtomicJsonFile(file).write(envelope)
            prepared.preview
        }

    private fun prepare(input: RecordRecoveryInput, current: ByteArray?): Pair<PreparedRecordRecovery, String> {
        val preview = previewRecordRecovery(input.pin, input.descriptor, input.baseline,
            current?.decodeToString(throwOnInvalidSequence = true), input.backup, input.received, input.intent,
            input.discovered, input.confirmed, input.observation, input.repair)
        val envelope = encodeJournalEnvelope(preview.journal, preview.journal)
        val receipt = RecordRecoveryReceipt(current?.let(::sha), sha(envelope.encodeToByteArray()))
        return PreparedRecordRecovery(preview, receipt) to envelope
    }

    private fun readCurrent(file: File): ByteArray? = try {
        Files.readAllBytes(file.toPath())
    } catch (_: NoSuchFileException) {
        null
    }

    private fun <T> withJournalLock(pin: RecordDatasetPin, action: (File) -> T): T = synchronized(processLock) {
        require(recordId.matches(pin.dataset_id)) { "INVALID_DATASET_PIN" }
        val directory = File(root, "record-journals")
        Files.createDirectories(directory.toPath())
        val file = File(directory, "${pin.dataset_id}.json")
        RandomAccessFile(File(directory, "${pin.dataset_id}.lock"), "rw").use { lockFile ->
            lockFile.channel.lock().use { action(file) }
        }
    }

    private companion object {
        // FileChannel 对进程内重叠锁抛异常，先在线程间串行。
        val processLock = Any()
    }
}
