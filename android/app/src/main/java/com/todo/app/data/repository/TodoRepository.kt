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
import com.todo.app.data.model.isWeekDate
import com.todo.app.data.model.isMonthDate
import com.todo.app.data.model.getWeeklyCompletedCount
import com.todo.app.data.model.getMonthlyCompletedCount
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.RecurringType
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

    private fun migrateTodo(todo: Todo): Todo {
        var recurring = todo.recurring
        var taskType = todo.task_type
        
        if (recurring == "daily") {
            recurring = RecurringType.DAILY_REPEAT
            taskType = if (taskType.isEmpty() || taskType == TaskType.NORMAL) TaskType.NORMAL else taskType
        } else if (recurring == "weekly") {
            recurring = RecurringType.NONE
            taskType = TaskType.WEEKLY_CHECKIN
        } else if (recurring == "monthly") {
            recurring = RecurringType.NONE
            taskType = TaskType.MONTHLY_CHECKIN
        }

        val dateStr = todo.date
        if (dateStr != null) {
            if (isWeekDate(dateStr)) {
                taskType = TaskType.WEEKLY_CHECKIN
            } else if (isMonthDate(dateStr)) {
                taskType = TaskType.MONTHLY_CHECKIN
            }
        }
        
        val completedDates = todo.completed_dates ?: emptyList()

        return todo.copy(
            recurring = recurring,
            task_type = taskType.ifEmpty { TaskType.NORMAL },
            completed_dates = completedDates,
            target_count = todo.target_count
        )
    }

    private fun normalizeData(data: TodoData): TodoData {
        val migratedTodos = data.todos.map { migrateTodo(it) }
        
        // Remove duplicate IDs (keep the latest updated)
        val uniqueTodos = migratedTodos.groupBy { it.id }
            .map { (_, list) -> 
                if (list.size > 1) {
                    list.maxByOrNull { try { OffsetDateTime.parse(it.updated_at) } catch (_: Exception) { OffsetDateTime.MIN } } ?: list.first()
                } else {
                    list.first()
                }
            }
        
        // Remove duplicate completed_dates
        val deduplicatedTodos = uniqueTodos.map { todo ->
            if (todo.completed_dates.size != todo.completed_dates.toSet().size) {
                todo.copy(completed_dates = todo.completed_dates.distinct().sorted())
            } else {
                todo
            }
        }
        
        return data.copy(todos = deduplicatedTodos)
    }

    private fun loadFromDisk() {
        if (dataFile.exists()) {
            try {
                val jsonString = dataFile.readText()
                val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)
                val migratedData = normalizeData(parsed)
                val migratedTodos = migratedData.todos

                // 旧数据迁移：所有 todo 的 order 都为 0.0 时，按 created_at 降序分配递增序号
                if (migratedTodos.size > 1 && migratedTodos.all { it.order == 0.0 }) {
                    val sorted = migratedTodos.sortedByDescending { it.created_at }
                    sorted.forEachIndexed { index, todo -> todo.order = index.toDouble() }
                    _todoData.value = migratedData.copy(todos = sorted)
                    // 持久化迁移结果
                    try { atomicWriteJson(jsonFormat.encodeToString(TodoData.serializer(), _todoData.value)) } catch (_: Exception) {}
                } else {
                    _todoData.value = migratedData
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
        val localTodos = normalizeData(local).todos.associateBy { it.id }
        val cloudTodos = normalizeData(cloud).todos.associateBy { it.id }
        val merged = mutableMapOf<String, Todo>()
        for (id in localTodos.keys + cloudTodos.keys) {
            val l = localTodos[id]
            val c = cloudTodos[id]
            if (l != null && c != null) {
                val lTime = try { OffsetDateTime.parse(l.updated_at) } catch (_: Exception) { OffsetDateTime.MIN }
                val cTime = try { OffsetDateTime.parse(c.updated_at) } catch (_: Exception) { OffsetDateTime.MIN }
                val base = if (cTime.isAfter(lTime)) c else l
                
                // completed_dates 并集去重并排序
                val mergedDates = (l.completed_dates + c.completed_dates).distinct().sorted()
                merged[id] = base.copy(completed_dates = mergedDates)
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
                        withContext(Dispatchers.Main) {
                            android.widget.Toast.makeText(context, "检测到云端更新，已自动同步完成", android.widget.Toast.LENGTH_SHORT).show()
                        }
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
                val migratedData = normalizeData(cloudData)
                _todoData.value = migratedData
                atomicWriteJson(jsonFormat.encodeToString(migratedData))
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
            // 不向用户展示服务器错误详情和目录结构，防止信息泄露
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "云端同步失败，请检查网络连接和 WebDAV 配置", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    }

    fun getTodoData(): Flow<TodoData> = _todoData.asStateFlow()

    /** 将源 Todo 克隆到新周期，重置完成状态和子任务 */
    private fun cloneTodoForNewPeriod(source: Todo, targetDateStr: String): Todo {
        return Todo.create(source.content, targetDateStr).copy(
            task_type = source.task_type,
            target_count = source.target_count,
            completed = false,
            completed_at = null,
            completed_dates = emptyList(),
            subtasks = source.subtasks.map { sub ->
                sub.copy(id = UUID.randomUUID().toString(), completed = false, completed_at = null)
            },
            created_at = nowIso(),
            updated_at = nowIso()
        )
    }
    
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

            // 周/月打卡任务分支
            if (todo.task_type == TaskType.WEEKLY_CHECKIN || todo.task_type == TaskType.MONTHLY_CHECKIN) {
                val todayStr = java.time.LocalDate.now().toString()
                val dates = todo.completed_dates.toMutableList()

                if (todo.completed) {
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(context, "已达到目标次数！如需消卡，请进入编辑弹窗。", android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@withLock
                }

                if (dates.contains(todayStr)) {
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(context, "今天已打卡！如需消卡，请进入编辑弹窗。", android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@withLock
                }

                dates.add(todayStr)
                dates.sort()

                val updatedTodoForCount = todo.copy(completed_dates = dates)
                val completedCount = if (todo.task_type == TaskType.WEEKLY_CHECKIN) {
                    updatedTodoForCount.getWeeklyCompletedCount()
                } else {
                    updatedTodoForCount.getMonthlyCompletedCount()
                }
                val isCompletedNow = todo.target_count != null && completedCount >= todo.target_count!!
                val updatedTodo = todo.copy(
                    completed_dates = dates,
                    completed = isCompletedNow,
                    completed_at = if (isCompletedNow) nowInstant() else null,
                    updated_at = nowIso()
                )
                current[index] = updatedTodo
                saveTodos(current)
                return@withLock
            }

            if (!todo.completed && todo.recurring == RecurringType.DAILY_REPEAT) {
                val tomorrowStr = java.time.LocalDate.now().plusDays(1).toString()
                val existsClone = current.any {
                    it.content == todo.content && it.date == tomorrowStr
                    && it.recurring == RecurringType.DAILY_REPEAT && !it.deleted
                }
                if (!existsClone) {
                    val clone = todo.copy(
                        id = UUID.randomUUID().toString(),
                        date = tomorrowStr,
                        completed = false,
                        completed_at = null,
                        created_at = nowIso(),
                        updated_at = nowIso(),
                        order = -System.currentTimeMillis().toDouble(), // 负数置顶
                        subtasks = todo.subtasks.map {
                            it.copy(id = UUID.randomUUID().toString(), completed = false, completed_at = null)
                        }
                    )
                    current.add(clone)
                }
            }
            val isCompletedNow = !todo.completed
            val updatedTodo = todo.copy(
                completed = isCompletedNow,
                completed_at = if (isCompletedNow) nowInstant() else null,
                subtasks = if (isCompletedNow) {
                    todo.subtasks.map { s ->
                        s.copy(completed = true, completed_at = s.completed_at ?: nowIso())
                    }
                } else {
                    todo.subtasks
                },
                updated_at = nowIso()
            )
            current[index] = updatedTodo
            saveTodos(current)
        }
    }

    suspend fun importSelectedFromLastPeriod(type: String, selectedIds: List<String>, context: android.content.Context) = mutex.withLock { withContext(Dispatchers.IO) {
        val today = java.time.LocalDate.now()
        val targetPeriodStr = if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today)
        } else {
            com.todo.app.data.model.monthStringOf(today)
        }

        val current = _todoData.value.todos.toMutableList()
        val candidates = current.filter { it.id in selectedIds }

        val existingTitles = current.filter { !it.deleted && it.date == targetPeriodStr }.map { it.content }.toSet()

        var importCount = 0
        candidates.forEach { src ->
            if (existingTitles.contains(src.content)) return@forEach
            current.add(cloneTodoForNewPeriod(src, targetPeriodStr))
            importCount++
        }

        if (importCount > 0) {
            saveTodos(current)
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "成功导入 $importCount 个打卡任务", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }}

    suspend fun importFromLastPeriod(type: String, context: android.content.Context) = mutex.withLock { withContext(Dispatchers.IO) {
        val today = java.time.LocalDate.now()
        val sourcePeriodStr = if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today.minusWeeks(1))
        } else {
            com.todo.app.data.model.monthStringOf(today.minusMonths(1))
        }
        val targetPeriodStr = if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today)
        } else {
            com.todo.app.data.model.monthStringOf(today)
        }

        val current = _todoData.value.todos.toMutableList()
        val candidates = current.filter {
            !it.deleted &&
            (it.task_type == TaskType.WEEKLY_CHECKIN || it.task_type == TaskType.MONTHLY_CHECKIN) &&
            it.date == sourcePeriodStr
        }

        if (candidates.isEmpty()) {
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "上一周期没有打卡任务可供导入", android.widget.Toast.LENGTH_SHORT).show()
            }
            return@withContext
        }

        val existingTitles = current.filter { !it.deleted && it.date == targetPeriodStr }.map { it.content }.toSet()

        var importCount = 0
        candidates.forEach { src ->
            if (existingTitles.contains(src.content)) return@forEach
            current.add(cloneTodoForNewPeriod(src, targetPeriodStr))
            importCount++
        }

        if (importCount > 0) {
            saveTodos(current)
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "成功导入 $importCount 个打卡任务", android.widget.Toast.LENGTH_SHORT).show()
            }
        } else {
            withContext(Dispatchers.Main) {
                android.widget.Toast.makeText(context, "任务已存在，无需重复导入", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }}
}
