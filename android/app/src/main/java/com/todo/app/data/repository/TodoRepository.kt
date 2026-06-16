package com.todo.app.data.repository

import android.content.Context
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.data.ConfigManager
import com.todo.app.data.WebDavClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import com.todo.app.data.model.nowIso
import com.todo.app.data.model.nowInstant
import java.time.OffsetDateTime
import java.util.UUID

/**
 * 待办事项数据仓库接口，模拟本地持久化。
 */
class TodoRepository(private val context: Context) {
    private val jsonFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }

    private val dataFile = File(context.filesDir, "todo_data.json")
    private val tmpFile = File(context.filesDir, "todo_data.tmp")
    private val configManager = ConfigManager(context)
    private var webDavClient: WebDavClient? = null
    // Repository-scoped coroutine scope: SupervisorJob ensures one failed upload doesn't cancel future ones.
    // Not cancelled explicitly — TodoRepository is an app-singleton; call repoScope.cancel() if ever scoped shorter.
    private val repoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    
    private fun initWebDavClient() {
        if (webDavClient != null) return
        if (configManager.isConfigured()) {
            webDavClient = WebDavClient(configManager.webDavUrl, configManager.username, configManager.appPassword)
        }
    }

    /** Atomic write: write to tmp file then rename to prevent data corruption on crash. */
    private fun atomicWriteJson(json: String) {
        tmpFile.writeText(json)
        if (!tmpFile.renameTo(dataFile)) {
            // renameTo can fail on some Android filesystems; fall back to direct write
            dataFile.writeText(json)
            tmpFile.delete()
        }
    }

    private val _todoData = MutableStateFlow(
        TodoData(
            version = 1,
            last_updated = nowIso(),
            todos = emptyList()
        )
    )

    val isSyncing = MutableStateFlow(false)
    private val _syncStatus = MutableStateFlow(0) // 0: success/none, 1: syncing, 2: error
    val syncStatus: kotlinx.coroutines.flow.StateFlow<Int> = _syncStatus.asStateFlow()

    init {
        loadFromDisk()
    }

    private fun loadFromDisk() {
        if (dataFile.exists()) {
            try {
                val jsonString = dataFile.readText()
                val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)

                // 旧数据迁移：所有 todo 的 order 都为 0.0 时，按 created_at 降序分配递增序号
                val todos = parsed.todos
                if (todos.size > 1 && todos.all { it.order == 0.0 }) {
                    val sorted = todos.sortedByDescending { it.created_at }
                    sorted.forEachIndexed { index, todo -> todo.order = index.toDouble() }
                    _todoData.value = parsed.copy(todos = sorted)
                    // 持久化迁移结果
                    try { atomicWriteJson(jsonFormat.encodeToString(TodoData.serializer(), _todoData.value)) } catch (_: Exception) {}
                } else {
                    _todoData.value = parsed
                }
            } catch (e: Exception) {
                e.printStackTrace()
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    android.widget.Toast.makeText(context, "数据加载失败，已使用空列表: ${e.message}", android.widget.Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun createLocalBackup() {
        if (!dataFile.exists()) return
        try {
            val backupDir = File(context.filesDir, "backups")
            if (!backupDir.exists()) backupDir.mkdirs()
            
            val timestamp = java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss").format(java.time.LocalDateTime.now())
            val backupFile = File(backupDir, "todo_data_$timestamp.json")
            dataFile.copyTo(backupFile, overwrite = true)
            
            // Keep only last 5 backups
            val backups = backupDir.listFiles()?.filter { it.name.startsWith("todo_data_") && it.name.endsWith(".json") }
                ?.sortedByDescending { it.lastModified() }
            
            if (backups != null && backups.size > 5) {
                for (i in 5 until backups.size) {
                    backups[i].delete()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun listBackups(): List<String> {
        val backupDir = File(context.filesDir, "backups")
        if (!backupDir.exists()) return emptyList()
        return backupDir.listFiles()?.filter { it.name.startsWith("todo_data_") && it.name.endsWith(".json") }
            ?.sortedByDescending { it.lastModified() }
            ?.map { it.name } ?: emptyList()
    }

    suspend fun restoreFromBackup(filename: String): Boolean = mutex.withLock {
        withContext(Dispatchers.IO) {
            try {
                val backupFile = File(File(context.filesDir, "backups"), filename)
                if (backupFile.exists()) {
                    createLocalBackup() // backup the current state before restoring

                    val jsonString = backupFile.readText()
                    val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)
                    _todoData.value = parsed
                    atomicWriteJson(jsonString)

                    initWebDavClient()
                    webDavClient?.uploadFile(configManager.filePath, jsonString)

                    com.todo.app.widget.refreshAllWidgets(context)
                    return@withContext true
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
            return@withContext false
        }
    }

    private fun mergeTodoData(local: TodoData, cloud: TodoData): TodoData {
        val localTodos = local.todos.associateBy { it.id }
        val cloudTodos = cloud.todos.associateBy { it.id }
        val merged = mutableMapOf<String, Todo>()
        for (id in localTodos.keys + cloudTodos.keys) {
            val l = localTodos[id]
            val c = cloudTodos[id]
            if (l != null && c != null) {
                val lTime = try { OffsetDateTime.parse(l.updated_at) } catch (_: Exception) { OffsetDateTime.MIN }
                val cTime = try { OffsetDateTime.parse(c.updated_at) } catch (_: Exception) { OffsetDateTime.MIN }
                merged[id] = if (cTime.isAfter(lTime)) c else l
            } else {
                merged[id] = l ?: c!!
            }
        }
        return TodoData(
            version = local.version,
            last_updated = nowIso(),
            todos = merged.values.sortedByDescending { it.created_at }
        )
    }

    suspend fun syncWithCloud() = mutex.withLock { withContext(Dispatchers.IO) {
        if (isSyncing.value) return@withContext
        isSyncing.value = true
        _syncStatus.value = 1
        com.todo.app.widget.refreshAllWidgets(context)
        try {
            initWebDavClient()
            val client = webDavClient ?: return@withContext
            val cloudJson = client.downloadFile(configManager.filePath)
            if (cloudJson != null) {
                try {
                    val cloudData = jsonFormat.decodeFromString<TodoData>(cloudJson)
                    val localData = _todoData.value
                    val mergedData = mergeTodoData(localData, cloudData)

                    val mergedJson = jsonFormat.encodeToString(mergedData)
                    val localChanged = mergedData.todos != localData.todos
                    val cloudChanged = mergedData.todos != cloudData.todos
                    if (localChanged) {
                        createLocalBackup()
                        _todoData.value = mergedData
                        atomicWriteJson(mergedJson)
                        com.todo.app.widget.refreshAllWidgets(context)
                    }
                    if (cloudChanged || localChanged) {
                        client.uploadFile(configManager.filePath, mergedJson)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            } else {
                // 当云端不存在该文件，或获取失败时，尝试将本地数据作为初始版本上传
                client.uploadFile(configManager.filePath, jsonFormat.encodeToString(_todoData.value))
            }
            _syncStatus.value = 0
            com.todo.app.widget.refreshAllWidgets(context)
        } catch (e: Exception) {
            e.printStackTrace()
            _syncStatus.value = 2
            com.todo.app.widget.refreshAllWidgets(context)
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "同步失败: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
            }
        } finally {
            isSyncing.value = false
        }
    }
    }

    suspend fun forcePullCloud() = mutex.withLock { withContext(Dispatchers.IO) {
        try {
            initWebDavClient()
            val client = webDavClient ?: throw Exception("配置信息未填写完整")
            val cloudJson = client.downloadFile(configManager.filePath)
            if (cloudJson != null) {
                createLocalBackup()
                val cloudData = jsonFormat.decodeFromString<TodoData>(cloudJson)
                _todoData.value = cloudData
                atomicWriteJson(cloudJson)
                com.todo.app.widget.refreshAllWidgets(context)
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(context, "强制拉取成功！", android.widget.Toast.LENGTH_SHORT).show()
                }
            } else {
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(context, "下载失败：找不到文件或密码错误", android.widget.Toast.LENGTH_LONG).show()
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            val rootContents = try { webDavClient?.listRoot() ?: "" } catch(ex: Exception) { "" }
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "${e.message}\n$rootContents", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    }

    fun getTodoData(): Flow<TodoData> = _todoData.asStateFlow()
    
    /** 同步获取当前内存中的最新数据（非挂起），供 Glance provideContent 内部使用 */
    fun getCurrentData(): TodoData = _todoData.value

    suspend fun saveTodos(todos: List<Todo>) = withContext(Dispatchers.IO) {
        val previous = _todoData.value
        val updated = TodoData(
            version = previous.version,
            last_updated = nowIso(),
            todos = todos
        )
        _todoData.value = updated
        try {
            val jsonString = jsonFormat.encodeToString(updated)
            atomicWriteJson(jsonString)
            
            // 立即刷新小组件
            com.todo.app.widget.refreshAllWidgets(context)
            
            // 异步后台同步到云端，不阻塞当前流程
            repoScope.launch {
                _syncStatus.value = 1
                try {
                    initWebDavClient()
                    webDavClient?.uploadFile(configManager.filePath, jsonString)
                    _syncStatus.value = 0
                } catch (e: Exception) {
                    e.printStackTrace()
                    _syncStatus.value = 2
                }
                com.todo.app.widget.refreshAllWidgets(context)
            }
        } catch (e: Exception) {
            e.printStackTrace()
            _todoData.value = previous // rollback on write failure
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "保存失败: ${e.message}", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }

    suspend fun addTodo(todo: Todo) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        todo.updated_at = nowIso()
        current.add(todo)
        saveTodos(current)
    }

    suspend fun updateTodo(todo: Todo) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == todo.id }
        if (index != -1) {
            todo.updated_at = nowIso()
            current[index] = todo
            saveTodos(current)
        }
    }

    suspend fun batchUpdateTodos(updatedTodos: List<Todo>) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        val indexMap = current.withIndex().associate { (i, t) -> t.id to i }
        val now = nowIso()
        for (todo in updatedTodos) {
            val index = indexMap[todo.id] ?: -1
            if (index != -1) {
                todo.updated_at = now
                current[index] = todo
            }
        }
        saveTodos(current)
    }

    suspend fun deleteTodo(id: String) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == id }
        if (index != -1) {
            val updated = current[index].copy(
                deleted = true,
                updated_at = nowIso()
            )
            current[index] = updated
            saveTodos(current)
        }
    }

    suspend fun toggleTodoStatus(id: String) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == id }
        if (index != -1) {
            val todo = current[index]
            if (!todo.completed && todo.recurring != "none") {
                // 如果是重复任务且未完成，克隆出一个新的下周期任务
                val nextDate = getNextRecurringDate(todo.date, todo.recurring)
                val clone = todo.copy(
                    id = UUID.randomUUID().toString(),
                    date = nextDate,
                    completed = false,
                    created_at = nowIso(),
                    updated_at = nowIso(),
                    subtasks = todo.subtasks.map { it.copy(id = UUID.randomUUID().toString(), completed = false) }
                )
                current.add(clone)
            }
            val isCompletedNow = !todo.completed
            val updatedTodo = todo.copy(
                completed = isCompletedNow,
                completed_at = if (isCompletedNow) nowInstant() else null,
                updated_at = nowIso()
            )
            current[index] = updatedTodo
            saveTodos(current)
        }
    }
    
    private fun getNextRecurringDate(baseDate: String?, rule: String): String? {
        if (baseDate == null) return null
        try {
            // 支持简单的 yyyy-MM-dd 解析
            if (baseDate.length == 10 && baseDate[4] == '-' && baseDate[7] == '-') {
                val date = java.time.LocalDate.parse(baseDate)
                val next = when (rule) {
                    "daily" -> date.plusDays(1)
                    "weekly" -> date.plusWeeks(1)
                    "monthly" -> date.plusMonths(1)
                    else -> date
                }
                return next.toString()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return baseDate
    }
}
