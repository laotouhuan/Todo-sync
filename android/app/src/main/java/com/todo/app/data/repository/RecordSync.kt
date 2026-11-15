package com.todo.app.data.repository

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.currentCoroutineContext

/** 传输实现固定一个数据集。只有明确不存在才返回 null。正文使用规范 Base64。 */
internal interface RecordTransport {
    val namespace: String
    suspend fun list(): List<String>
    suspend fun read(name: String): String?
    suspend fun write(name: String, content: String)
}

internal class RecordTransportIntegrityException(code: String) : IllegalStateException(code)

internal fun CoroutineScope.startRecordSync(
    intervalMs: Long,
    sync: suspend () -> RecordSyncResult,
    onResult: (RecordSyncResult) -> Unit,
    onError: (Exception) -> Unit
): kotlinx.coroutines.Job {
    require(intervalMs > 0) { "INVALID_RECORD_SYNC_INTERVAL" }
    return launch {
        while (isActive) {
            try {
                onResult(sync())
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onError(error)
                if (error is RecordTransportIntegrityException) break
            }
            delay(intervalMs)
        }
    }
}

internal data class RecordSyncResult(
    val state: RecordRecoveryPreview,
    val listFailed: Boolean,
    val readFailures: List<String>,
    val uploadFailures: List<String>
)

internal suspend fun syncRecordJournal(
    store: RecordRecoveryStore, binding: RecordRecoveryInput, transport: RecordTransport
): RecordSyncResult = withContext(Dispatchers.IO) {
    require(transport.namespace == binding.pin.namespace) { "RECORD_TRANSPORT_TARGET_MISMATCH" }
    val target = RecordRecoveryInput(binding.pin, binding.descriptor, binding.baseline)
    var state = store.prepare(target).preview
    fun requireWritable() {
        state.journal.fault?.let { throw RecordTransportIntegrityException(it.code) }
    }
    requireWritable()
    val readFailures = mutableListOf<String>()
    val uploadFailures = mutableListOf<String>()
    fun save(input: RecordRecoveryInput) = store.commit(input, store.prepare(input).receipt)
    fun observe(name: String, content: String, confirm: Boolean = false) {
        state = save(target.copy(observation = RecordObservation(Artifact(name, content), confirm)))
        requireWritable()
    }

    val listed = network { transport.list() }
    listed.getOrNull()?.takeIf { it.isNotEmpty() }?.let { state = save(target.copy(discovered = it)) }
    val attempted = mutableSetOf<String>()
    while (true) {
        val pending = state.journal.pending.toSet()
        val known = state.journal.records.associate { it.name to it.content }
        val names = (state.journal.unread + state.missing + (known.keys - pending)).distinct().filter { attempted.add(it) }
        if (names.isEmpty()) break
        for (name in names) {
            val content = network { transport.read(name) }.getOrNull()
            if (content == null) readFailures.add(name)
            else if (known[name] != content) observe(name, content)
        }
    }
    if (listed.isSuccess && state.view != null) {
        val artifacts = state.journal.records.associateBy { it.name }
        for (name in state.journal.pending) {
            val local = artifacts.getValue(name)
            val confirmed = network {
                transport.read(name) ?: run {
                    transport.write(name, local.content)
                    transport.read(name)
                }
            }.getOrNull()
            if (confirmed == null) uploadFailures.add(name)
            else observe(name, confirmed, confirm = true)
        }
    }
    RecordSyncResult(state, listed.isFailure, readFailures, uploadFailures)
}

private suspend inline fun <T> network(action: () -> T): Result<T> = try {
    currentCoroutineContext().ensureActive()
    val result = action()
    currentCoroutineContext().ensureActive()
    Result.success(result)
} catch (error: CancellationException) {
    throw error
} catch (error: RecordTransportIntegrityException) {
    throw error
} catch (error: Exception) {
    Result.failure(error)
}
