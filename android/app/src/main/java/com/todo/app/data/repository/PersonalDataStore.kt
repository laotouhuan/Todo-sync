package com.todo.app.data.repository

import com.todo.app.data.model.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/** 替换之前的所有失败都只影响临时文件，绝不打开原文件进行覆盖。 */
internal class AtomicJsonFile(
    private val target: File,
    private val writeTemporary: (File, String) -> Unit = { temporary, content ->
        FileOutputStream(temporary).use { output ->
            output.write(content.toByteArray(Charsets.UTF_8))
            output.fd.sync()
        }
    },
    private val replace: (File, File) -> Unit = { temporary, destination ->
        Files.move(temporary.toPath(), destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        Unit
    }
) {
    fun write(content: String) {
        val temporary = File.createTempFile("todo-", ".tmp", target.parentFile)
        try {
            writeTemporary(temporary, content)
            replace(temporary, target)
        } finally {
            // 替换成功后的清理失败不能把已提交的数据误报为未保存。
            runCatching { temporary.delete() }
        }
    }
}

/** 个人数据共用一把锁；锁内方法只供已经持锁的仓库调用。 */
internal class PersonalDataStore(
    private val file: File,
    private val write: (String) -> Unit = AtomicJsonFile(file)::write
) {
    val mutex = Mutex()
    val data = MutableStateFlow(TodoData(1, nowIso(), emptyList()))
    val loadError = MutableStateFlow<String?>(null)
    private var loaded = false
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; prettyPrint = true }

    fun decode(content: String): TodoData = MergeUtils.normalizeData(json.decodeFromString<TodoData>(content))

    fun loadLocked(): TodoData {
        if (loaded) return data.value
        try {
            if (file.exists()) {
                var parsed = decode(file.readText(Charsets.UTF_8))
                if (parsed.todos.size > 1 && parsed.todos.all { it.order == 0.0 }) {
                    // 迁移副本写入成功后才发布，避免改动已展示对象。
                    parsed = parsed.copy(todos = parsed.todos.sortedByDescending { it.createdAt }
                        .mapIndexed { index, todo -> todo.copy(order = index.toDouble()) })
                    commitLocked(parsed)
                } else {
                    data.value = parsed
                }
            }
            loaded = true
            loadError.value = null
            return data.value
        } catch (e: Exception) {
            loadError.value = "数据加载失败，请重试或在设置中恢复备份：${e.message}"
            throw e
        }
    }

    suspend fun ensureLoaded(): TodoData = mutex.withLock { loadLocked() }

    fun commitLocked(updated: TodoData) {
        write(json.encodeToString(updated))
        data.value = updated
        loaded = true
        loadError.value = null
    }

    suspend fun restore(content: String) = mutex.withLock {
        // 恢复不依赖损坏的本地文件，也不与默认空数据合并。
        commitLocked(decode(content))
    }

    suspend fun start(todo: Todo, ref: TaskReference, enabled: () -> Boolean, now: String? = null) = mutex.withLock {
        val current = loadLocked()
        require(enabled()) { "本机任务计时已关闭" }
        require(ref.todo_id == todo.id) { "任务引用不匹配" }
        val latest = when (ref.source_type) {
            "personal" -> {
                require(ref.source_id == null) { "个人任务来源无效" }
                current.todos.find { it.id == ref.todo_id } ?: error("任务已不存在，请重新选择")
            }
            "collaboration" -> {
                require(!ref.source_id.isNullOrBlank()) { "协作任务来源无效" }
                todo
            }
            else -> error("任务来源无效")
        }
        require(!latest.deleted) { "已删除任务不能开始计时" }
        require(current.timeEntries.none { !it.deleted && it.ended_at == null }) { "已有任务正在计时，请先结束或处理记录" }
        val timestamp = now ?: nowIso()
        commitLocked(current.copy(last_updated = timestamp, timeEntries = current.timeEntries + TimeEntry(
            id = UUID.randomUUID().toString(), task_ref = ref, started_at = timestamp,
            created_at = timestamp, updated_at = timestamp, task_content_snapshot = latest.content,
            label_snapshot = Learning.label(latest.label))))
    }

    suspend fun stop(id: String, enabled: () -> Boolean, now: String? = null): Int = mutex.withLock {
        val current = loadLocked()
        require(enabled()) { "本机任务计时已关闭" }
        val entry = current.timeEntries.find { it.id == id && !it.deleted && it.ended_at == null }
            ?: return@withLock 0
        val timestamp = now ?: nowIso()
        val finished = Learning.finishTimeEntry(entry, timestamp)
        commitLocked(current.copy(last_updated = timestamp, timeEntries = current.timeEntries.map {
            if (it.id == id) finished else it
        }))
        if (finished.deleted) 1 else 0
    }

    suspend fun saveTimingPreferences(
        expected: List<TimeEntry>?, saveSettings: () -> Unit, now: String? = null
    ): Int = mutex.withLock {
        var discarded = 0
        var recordsFinished = false
        if (expected != null) {
            val current = loadLocked()
            val running = current.timeEntries.filter { !it.deleted && it.ended_at == null }
            require(running.toSet() == expected.toSet()) { "运行记录已变化，请重新保存并确认" }
            if (running.isNotEmpty()) {
                val timestamp = now ?: nowIso()
                val updated = current.copy(last_updated = timestamp, timeEntries = current.timeEntries.map { entry ->
                    if (entry in running) Learning.finishTimeEntry(entry, timestamp).also { if (it.deleted) discarded++ }
                    else entry
                })
                commitLocked(updated)
                recordsFinished = true
            }
        }
        try {
            saveSettings()
        } catch (e: Exception) {
            if (recordsFinished) throw IllegalStateException("记录已结束，关闭计时失败，请重试", e)
            throw e
        }
        discarded
    }
}
