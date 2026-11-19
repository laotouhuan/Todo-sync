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
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

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
    val uploadFailures: List<String>,
    val transportError: String? = null
)

internal suspend fun syncRecordJournal(
    store: RecordRecoveryStore, binding: RecordRecoveryInput, transport: RecordTransport, verifyKnown: Boolean = true
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
    var transportError: String? = null
    fun save(input: RecordRecoveryInput) = store.commit(input, store.prepare(input).receipt)
    fun observe(name: String, content: String, confirm: Boolean = false) {
        state = save(target.copy(observation = RecordObservation(Artifact(name, content), confirm)))
        requireWritable()
    }

    val listed = network { transport.list() }
    // 目录失败后停止本轮网络请求，保留待发送记录供下次重试。
    if (listed.isFailure) return@withContext RecordSyncResult(state, true, readFailures, uploadFailures, listed.exceptionOrNull()?.message)
    listed.getOrNull()?.takeIf { it.isNotEmpty() }?.let { state = save(target.copy(discovered = it)) }
    val attempted = mutableSetOf<String>()
    val auditKnown = verifyKnown || state.journal.pending.isNotEmpty()
    while (true) {
        val pending = state.journal.pending.toSet()
        val known = state.journal.records.associate { it.name to it.content }
        val history = if (auditKnown) known.keys - pending else emptySet()
        val names = (state.journal.unread + state.missing + history).distinct().filter { attempted.add(it) }
        if (names.isEmpty()) break
        // 只并行读取，校验与落盘仍按原顺序执行，限制并发避免压满 WebDAV。
        for (batch in names.chunked(4)) {
            val results = coroutineScope {
                batch.map { name -> async { network { transport.read(name) } } }.awaitAll()
            }
            for ((index, name) in batch.withIndex()) {
                val content = results[index].getOrNull()
                if (results[index].isFailure) transportError = results[index].exceptionOrNull()?.message ?: "RECORD_DAV_NETWORK"
                if (content == null) readFailures.add(name)
                else if (known[name] != content) observe(name, content)
            }
            if (transportError != null) return@withContext RecordSyncResult(state, false, readFailures, uploadFailures, transportError)
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
            }
            if (confirmed.isFailure) {
                uploadFailures.add(name)
                transportError = confirmed.exceptionOrNull()?.message
                break
            }
            val content = confirmed.getOrNull()
            if (content == null) uploadFailures.add(name)
            else observe(name, content, confirm = true)
        }
    }
    RecordSyncResult(state, listed.isFailure, readFailures, uploadFailures, transportError)
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
