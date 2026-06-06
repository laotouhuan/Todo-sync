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
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
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

    private fun nowIso(): String =
        java.time.OffsetDateTime.now().format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
    
    private val dataFile = File(context.filesDir, "todo_data.json")
    private val configManager = ConfigManager(context)
    private var webDavClient: WebDavClient? = null
    // Repository-scoped coroutine scope: SupervisorJob ensures one failed upload doesn't cancel future ones.
    // Not cancelled explicitly — TodoRepository is an app-singleton; call repoScope.cancel() if ever scoped shorter.
    private val repoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    
    private fun initWebDavClient() {
        if (configManager.isConfigured()) {
            webDavClient = WebDavClient(configManager.webDavUrl, configManager.username, configManager.appPassword)
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
    var syncStatus = 0 // 0: success/none, 1: syncing, 2: error

    init {
        loadFromDisk()
    }

    private fun loadFromDisk() {
        if (dataFile.exists()) {
            try {
                val jsonString = dataFile.readText()
                val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)
                _todoData.value = parsed
            } catch (e: Exception) {
                e.printStackTrace()
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

    suspend fun restoreFromBackup(filename: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val backupFile = File(File(context.filesDir, "backups"), filename)
            if (backupFile.exists()) {
                createLocalBackup() // backup the current state before restoring
                
                val jsonString = backupFile.readText()
                val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)
                _todoData.value = parsed
                dataFile.writeText(jsonString)
                
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

    suspend fun syncWithCloud() = withContext(Dispatchers.IO) {
        if (isSyncing.value) return@withContext
        isSyncing.value = true
        syncStatus = 1
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
                        dataFile.writeText(mergedJson)
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
            syncStatus = 0
            com.todo.app.widget.refreshAllWidgets(context)
        } catch (e: Exception) {
            e.printStackTrace()
            syncStatus = 2
            com.todo.app.widget.refreshAllWidgets(context)
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "同步失败: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
            }
        } finally {
            isSyncing.value = false
        }
    }

    suspend fun forcePullCloud() = withContext(Dispatchers.IO) {
        try {
            initWebDavClient()
            val client = webDavClient ?: throw Exception("配置信息未填写完整")
            val cloudJson = client.downloadFile(configManager.filePath)
            if (cloudJson != null) {
                createLocalBackup()
                val cloudData = jsonFormat.decodeFromString<TodoData>(cloudJson)
                _todoData.value = cloudData
                dataFile.writeText(cloudJson)
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

    fun getTodoData(): Flow<TodoData> = _todoData.asStateFlow()
    
    /** 同步获取当前内存中的最新数据（非挂起），供 Glance provideContent 内部使用 */
    fun getCurrentData(): TodoData = _todoData.value

    suspend fun saveTodos(todos: List<Todo>) = withContext(Dispatchers.IO) {
        val updated = TodoData(
            version = _todoData.value.version,
            last_updated = nowIso(),
            todos = todos
        )
        _todoData.value = updated
        try {
            val jsonString = jsonFormat.encodeToString(updated)
            dataFile.writeText(jsonString)
            
            // 立即刷新小组件
            com.todo.app.widget.refreshAllWidgets(context)
            
            // 异步后台同步到云端，不阻塞当前流程
            repoScope.launch {
                syncStatus = 1
                try {
                    initWebDavClient()
                    webDavClient?.uploadFile(configManager.filePath, jsonString)
                    syncStatus = 0
                } catch (e: Exception) {
                    e.printStackTrace()
                    syncStatus = 2
                }
                com.todo.app.widget.refreshAllWidgets(context)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    suspend fun addTodo(todo: Todo) {
        val current = _todoData.value.todos.toMutableList()
        todo.updated_at = nowIso()
        current.add(todo)
        saveTodos(current)
    }

    suspend fun updateTodo(todo: Todo) {
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == todo.id }
        if (index != -1) {
            todo.updated_at = nowIso()
            current[index] = todo
            saveTodos(current)
        }
    }

    suspend fun deleteTodo(id: String) {
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

    suspend fun toggleTodoStatus(id: String) {
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
            val updatedTodo = todo.copy(
                completed = !todo.completed,
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
