package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import com.todo.app.data.model.WeeklyPlanning
import com.todo.app.data.recordsync.canonical
import com.todo.app.data.recordsync.parse
import com.todo.app.data.recordsync.sha
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal data class PlanningCloudConnection(val endpoint: String, val username: String, val password: String, val filePath: String) {
    private fun normalizedEndpoint(): String {
        val url = endpoint.trim().toHttpUrlOrNull()
        require(url != null && url.isHttps && url.username.isEmpty() && url.password.isEmpty() &&
            url.query == null && url.fragment == null) { "RECORD_DAV_INVALID_TARGET" }
        return url.toString().trimEnd('/')
    }

    fun target(actorId: String): RecordSandboxTarget {
        val identity = Json.encodeToString(ListSerializer(String.serializer()), listOf("todo-planning/1", normalizedEndpoint(), username, filePath))
        val hash = sha(canonical(parse(identity.encodeToByteArray(), strict = false)))
        val id = "${hash.substring(0, 8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-8${hash.substring(17, 20)}-${hash.substring(20, 32)}"
        return RecordSandboxTarget(id, actorId, "1970-01-01T00:00:00Z")
    }

    fun transport(binding: RecordRecoveryInput) = RecordWebDavTransport(
        normalizedEndpoint(), filePath.split('/').dropLast(1), username, password, binding.pin, initialization = binding)
}

@Serializable
internal data class RecordSandboxTarget(val datasetId: String, val actorId: String, val at: String) {
    fun binding(operationSet: String = PLANNING_OPERATION_SET): RecordRecoveryInput {
        val protocol = "todo-record-sync/1"
        fun seal(body: JsonObject): Pair<String, String> {
            val raw = canonical(parse(body.toString().encodeToByteArray(), strict = false))
            return sha(raw) to Base64.getEncoder().encodeToString(raw)
        }
        val (baselineHash, baseline) = seal(buildJsonObject {
            put("protocol", protocol)
            put("dataset_id", datasetId)
            put("data", buildJsonObject {
                put("version", 1)
                put("last_updated", at)
                put("todos", JsonArray(emptyList()))
            })
        })
        val (descriptorHash, descriptor) = seal(buildJsonObject {
            put("protocol", protocol)
            put("dataset_id", datasetId)
            put("baseline_sha256", baselineHash)
            put("data_schema_version", 1)
            put("operation_set", operationSet)
            put("created_at", at)
        })
        return RecordRecoveryInput(RecordDatasetPin(protocol, datasetId, descriptorHash, baselineHash, "record-sync/$datasetId/"),
            descriptor, baseline)
    }
}

internal data class RecordSandboxView(val preview: RecordRecoveryPreview, val revision: String?, val uploadFailures: Int = 0,
                                     val syncIncomplete: Boolean = false)

// 已清除的本机评分只属于旧清单，不能覆盖云端评分或阻止加入云端。
internal fun RecordRecoveryPreview.retainsLocalPlanning(): Boolean {
    val data = view ?: return true
    return journal.fault != null ||
        data.getValue("weekly_plan_versions").jsonArray.isNotEmpty() ||
        data.getValue("weekly_plan_selections").jsonArray.isNotEmpty() ||
        data.getValue("daily_ratings").jsonArray.any {
            val rating = it.jsonObject
            rating["deleted"]?.jsonPrimitive?.booleanOrNull != true && rating.getValue("score") != JsonNull
        }
}

internal class RecordSandbox(files: File, target: RecordSandboxTarget, localOnly: Boolean = false, cloud: PlanningCloudConnection? = null) {
    private val binding = target.binding(if (cloud == null) PLANNING_OPERATION_SET else CLOUD_PLANNING_OPERATION_SET)
    private val actorId = target.actorId
    private val store = RecordRecoveryStore(files)
    private val transport = cloud?.transport(binding) ?: if (localOnly) null else RecordFolderTransport.sandbox(files, binding)
    private val mutex = Mutex()
    private val json = Json { encodeDefaults = true }
    private var pending: RecordCommitIntent? = null
    private var closed = false

    private fun current(failures: Int = 0): RecordSandboxView {
        val prepared = store.prepare(binding)
        return RecordSandboxView(prepared.preview, prepared.receipt.previousSha256, failures)
    }

    suspend fun open() = use { current() }

    suspend fun sync(): RecordSandboxView = use {
        val result = syncRecordJournal(store, binding, requireNotNull(transport))
        current(result.uploadFailures.size).copy(syncIncomplete = result.listFailed || result.readFailures.isNotEmpty() || result.uploadFailures.isNotEmpty())
    }

    suspend fun change(action: JsonObject, revision: String?): RecordSandboxView = use {
        check(pending == null) { "RECORD_RETRY_PENDING" }
        val latest = current()
        val data = requireNotNull(latest.preview.view)
        check(latest.revision == revision) { "RECORD_WRITE_STALE" }
        val kind = action.getValue("kind").jsonPrimitive.content
        val todoId = action["todoId"]?.jsonPrimitive?.content
        val existing = data.getValue("todos").jsonArray.firstOrNull { it.jsonObject["id"]?.jsonPrimitive?.content == todoId }
            ?.let { json.decodeFromJsonElement<Todo>(it) }?.takeIf { !it.deleted && it.taskType == TaskType.NORMAL }
        val rating = if (kind == "rate") data.getValue("daily_ratings").jsonArray.map { it.jsonObject }.firstOrNull {
            it["date"] == action["date"]
        } else null
        val previousClock = existing?.updatedAt ?: rating?.get("updated_at")?.jsonPrimitive?.content
        val minimum = previousClock?.let { NormalTodoConflict.timestampMillis(it) + 1 } ?: 0
        val time = maxOf(System.currentTimeMillis(), minimum)
        val at = Instant.ofEpochMilli(time).toString()
        val id = UUID.randomUUID().toString()
        val operation = when (kind) {
            "add", "rename", "remove" -> {
                val remove = kind == "remove"
                val content = if (remove) requireNotNull(existing).content
                    else action.getValue("content").jsonPrimitive.content.trim().also { require(it.isNotEmpty()) { "INVALID_TASK_NAME" } }
                val todo = if (kind == "add") Todo(UUID.randomUUID().toString(), content, createdAt = at, order = time.toDouble())
                    else requireNotNull(existing).copy(content = content, updatedAt = at, deleted = remove)
                buildJsonObject {
                    put("type", if (remove) "todo.normal.delete" else "todo.normal.put")
                    put("todo", json.encodeToJsonElement(Todo.serializer(), NormalTodoConflict.normalize(todo)))
                }
            }
            else -> WeeklyPlanning.change(data, action, id, at)
        }
        if (operation == null) return@use latest
        pending = RecordCommitIntent(latest.revision, id, actorId, at, listOf(operation))
        submit()
    }

    suspend fun retry(): RecordSandboxView = retryWithResult().first

    suspend fun retryWithResult(): Pair<RecordSandboxView, Boolean> = use {
        if (pending == null) current() to false else submit() to true
    }

    suspend fun close() = mutex.withLock { closed = true }

    private fun submit(): RecordSandboxView {
        try {
            val saved = store.submitLocal(binding, requireNotNull(pending))
            pending = null
            return RecordSandboxView(saved.preview, saved.revision)
        } catch (error: Exception) {
            if (error is IllegalArgumentException || error.message in listOf("RECORD_WRITE_STALE", "RECORD_DATASET_FROZEN")) pending = null
            throw error
        }
    }

    private suspend fun <T> use(action: suspend () -> T): T = withContext(Dispatchers.IO) {
        mutex.withLock {
            check(!closed) { "RECORD_SESSION_CLOSED" }
            action()
        }
    }
}
