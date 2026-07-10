package com.todo.app.data.repository

import android.content.Context
import android.util.Log
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.data.ConfigManager
import com.todo.app.data.WebDavClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import com.todo.app.data.model.nowIso
import com.todo.app.data.model.nowInstant
import com.todo.app.data.model.isWeekDate
import com.todo.app.data.model.isMonthDate
import com.todo.app.data.model.getWeeklyCompletedCount
import com.todo.app.data.model.getMonthlyCompletedCount
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.RecurringType
import java.time.OffsetDateTime

/**
 * UI events that can be sent from Repository to the UI layer.
 * Replaces direct Toast calls from non-UI code.
 */
sealed class UiEvent {
    data class ShowMessage(val message: String) : UiEvent()
    data class ShowError(val error: String) : UiEvent()
}

/**
 * 待办事项数据仓库接口，模拟本地持久化。
 */
class TodoRepository(private val context: Context) {
    private val TAG = "TodoRepository"

    private val jsonFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }

    private val dataFile = File(context.filesDir, "todo_data.json")
    private val tmpFile = File(context.filesDir, "todo_data.tmp")
    private val configManager = ConfigManager(context)
    @Volatile private var webDavClient: WebDavClient? = null
    private val webDavMutex = Mutex()

    // Repository-scoped coroutine scope: SupervisorJob ensures one failed upload doesn't cancel future ones.
    // Not cancelled explicitly -- TodoRepository is an app-singleton; call repoScope.cancel() if ever scoped shorter.
    private val repoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()

    private val _uiEvent = Channel<UiEvent>(Channel.BUFFERED)
    val uiEvent: Flow<UiEvent> = _uiEvent.receiveAsFlow()

    private suspend fun initWebDavClient() {
        webDavMutex.withLock {
            if (webDavClient != null) return
            if (configManager.isConfigured()) {
                webDavClient = WebDavClient(configManager.webDavUrl, configManager.username, configManager.appPassword)
            }
        }
    }

    fun resetWebDavClient() {
        // Uses @Volatile for visibility; reference assignment is atomic on JVM
        webDavClient = null
    }

    /**
     * Atomic write: write to tmp file then sync to disk, then rename to prevent data corruption on crash.
     * Uses FileOutputStream + fd.sync() for reliability across Android filesystems.
     */
    private fun atomicWriteJson(json: String) {
        try {
            tmpFile.outputStream().use { fos ->
                fos.write(json.toByteArray(Charsets.UTF_8))
                fos.fd.sync()
            }
            // Try atomic rename first
            if (!tmpFile.renameTo(dataFile)) {
                // Fallback: copy bytes to dataFile then delete tmp
                dataFile.outputStream().use { fos ->
                    fos.write(json.toByteArray(Charsets.UTF_8))
                    fos.fd.sync()
                }
                tmpFile.delete()
            }
        } catch (e: IOException) {
            Log.e(TAG, "atomicWriteJson failed, falling back to direct write", e)
            try {
                dataFile.writeText(json)
                tmpFile.delete()
            } catch (_: Exception) {}
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

    private val uploadChannel = Channel<Unit>(Channel.CONFLATED)

    init {
        // P1-12: Load from disk asynchronously
        repoScope.launch {
            loadFromDisk()
        }
        repoScope.launch {
            for (item in uploadChannel) {
                delay(500) // debounce
                performBackgroundUpload()
            }
        }
    }



    private suspend fun loadFromDisk() {
        if (dataFile.exists()) {
            try {
                val jsonString = dataFile.readText()
                val parsed = jsonFormat.decodeFromString<TodoData>(jsonString)
                val migratedData = com.todo.app.data.model.MergeUtils.normalizeData(parsed)
                val migratedTodos = migratedData.todos

                // 旧数据迁移：所有 todo 的 order 都为 0.0 时，按 createdAt 降序分配递增序号
                if (migratedTodos.size > 1 && migratedTodos.all { it.order == 0.0 }) {
                    val sorted = migratedTodos.sortedByDescending { it.createdAt }
                    sorted.forEachIndexed { index, todo -> todo.order = index.toDouble() }
                    _todoData.value = migratedData.copy(todos = sorted)
                    // 持久化迁移结果
                    try { atomicWriteJson(jsonFormat.encodeToString(TodoData.serializer(), _todoData.value)) } catch (_: Exception) {}
                } else {
                    _todoData.value = migratedData
                }
            } catch (e: Exception) {
                Log.e(TAG, "loadFromDisk failed, using empty list", e)
                _uiEvent.send(UiEvent.ShowError("数据加载失败，已使用空列表: ${e.message}"))
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
            Log.e(TAG, "createLocalBackup failed", e)
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
                Log.e(TAG, "restoreFromBackup failed", e)
            }
            return@withContext false
        }
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
                    val mergedData = com.todo.app.data.model.MergeUtils.mergeTodoData(localData, cloudData)

                    val mergedJson = jsonFormat.encodeToString(mergedData)
                    val localChanged = mergedData.todos != localData.todos
                    val cloudChanged = mergedData.todos != cloudData.todos
                    if (localChanged) {
                        createLocalBackup()
                        _todoData.value = mergedData
                        atomicWriteJson(mergedJson)
                        com.todo.app.widget.refreshAllWidgets(context)
                        _uiEvent.send(UiEvent.ShowMessage("检测到云端更新，已自动同步完成"))
                    }
                    if (cloudChanged || localChanged) {
                        client.uploadFile(configManager.filePath, mergedJson)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "syncWithCloud merge failed", e)
                }
            } else {
                // 当云端不存在该文件，或获取失败时，尝试将本地数据作为初始版本上传
                client.uploadFile(configManager.filePath, jsonFormat.encodeToString(_todoData.value))
            }
            _syncStatus.value = 0
            com.todo.app.widget.refreshAllWidgets(context)
        } catch (e: Exception) {
            Log.e(TAG, "syncWithCloud failed", e)
            _syncStatus.value = 2
            com.todo.app.widget.refreshAllWidgets(context)
            _uiEvent.send(UiEvent.ShowError("同步失败: ${e.message}"))
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
                val migratedData = com.todo.app.data.model.MergeUtils.normalizeData(cloudData)
                _todoData.value = migratedData
                atomicWriteJson(jsonFormat.encodeToString(migratedData))
                com.todo.app.widget.refreshAllWidgets(context)
                _uiEvent.send(UiEvent.ShowMessage("强制拉取成功！"))
            } else {
                _uiEvent.send(UiEvent.ShowError("下载失败：找不到文件或密码错误"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "forcePullCloud failed", e)
            val msg = if (e.message?.contains("云端") == true) e.message!! else "云端同步失败，请检查网络连接和 WebDAV 配置"
            _uiEvent.send(UiEvent.ShowError(msg))
        }
    }
    }

    fun getTodoData(): Flow<TodoData> = _todoData.asStateFlow()

    /** 将源 Todo 克隆到新周期，重置完成状态和子任务 */
    private fun cloneTodoForNewPeriod(source: Todo, targetDateStr: String): Todo {
        return Todo.create(source.content, targetDateStr).copy(
            taskType = source.taskType,
            targetCount = source.targetCount,
            completed = false,
            completedAt = null,
            completedDates = emptyList(),
            subtasks = source.subtasks.map { sub ->
                sub.copy(id = UUID.randomUUID().toString(), completed = false, completedAt = null)
            },
            createdAt = nowIso(),
            updatedAt = nowIso()
        )
    }

    /** 同步获取当前内存中的最新数据（非挂起），供 Glance provideContent 内部使用 */
    fun getCurrentData(): TodoData = _todoData.value

    /**
     * Save the given list of todos to disk and trigger a background upload.
     * Callers must hold [mutex] before invoking this method.
     */
    private suspend fun saveTodos(todos: List<Todo>) = withContext(Dispatchers.IO) {
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

            // 触发后台同步
            uploadChannel.trySend(Unit)
        } catch (e: Exception) {
            Log.e(TAG, "saveTodos failed", e)
            _todoData.value = previous // rollback on write failure
            _uiEvent.send(UiEvent.ShowError("保存失败: ${e.message}"))
        }
    }

    private suspend fun performBackgroundUpload() {
        if (!configManager.isConfigured()) return
        val jsonString = try {
            val currentData = _todoData.value
            jsonFormat.encodeToString(currentData)
        } catch (e: Exception) {
            Log.e(TAG, "performBackgroundUpload serialize failed", e)
            return
        }

        _syncStatus.value = 1
        com.todo.app.widget.refreshAllWidgets(context)
        try {
            initWebDavClient()
            webDavClient?.uploadFile(configManager.filePath, jsonString)
            _syncStatus.value = 0
        } catch (e: Exception) {
            Log.e(TAG, "performBackgroundUpload upload failed", e)
            _syncStatus.value = 2
        }
        com.todo.app.widget.refreshAllWidgets(context)
    }

    suspend fun addTodo(todo: Todo) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        todo.updatedAt = nowIso()
        current.add(todo)
        saveTodos(current)
    }

    suspend fun updateTodo(todo: Todo) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == todo.id }
        if (index != -1) {
            todo.updatedAt = nowIso()
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
                todo.updatedAt = now
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
                updatedAt = nowIso()
            )
            current[index] = updated
            saveTodos(current)
        }
    }

    // ====== Toggle: Check-in task (weekly/monthly) ======

    private suspend fun toggleCheckinTask(
        todo: Todo,
        current: MutableList<Todo>,
        index: Int
    ) {
        val todayStr = java.time.LocalDate.now().toString()
        val dates = todo.completedDates.toMutableList()

        if (todo.completed) {
            _uiEvent.send(UiEvent.ShowMessage("已达到目标次数！如需消卡，请进入编辑弹窗。"))
            return
        }

        if (dates.contains(todayStr)) {
            _uiEvent.send(UiEvent.ShowMessage("今天已打卡！如需消卡，请进入编辑弹窗。"))
            return
        }

        dates.add(todayStr)
        dates.sort()

        val updatedTodoForCount = todo.copy(completedDates = dates)
        val completedCount = if (todo.taskType == TaskType.WEEKLY_CHECKIN) {
            updatedTodoForCount.getWeeklyCompletedCount()
        } else {
            updatedTodoForCount.getMonthlyCompletedCount()
        }
        val isCompletedNow = todo.targetCount != null && completedCount >= todo.targetCount!!
        val updatedTodo = todo.copy(
            completedDates = dates,
            completed = isCompletedNow,
            completedAt = if (isCompletedNow) nowInstant() else null,
            updatedAt = nowIso()
        )
        current[index] = updatedTodo
        saveTodos(current)
    }

    // ====== Toggle: Daily repeat task ======

    private suspend fun toggleDailyRepeatTask(
        todo: Todo,
        current: MutableList<Todo>
    ) {
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
                completedAt = null,
                createdAt = nowIso(),
                updatedAt = nowIso(),
                order = -System.currentTimeMillis().toDouble(), // 负数置顶
                subtasks = todo.subtasks.map {
                    it.copy(id = UUID.randomUUID().toString(), completed = false, completedAt = null)
                }
            )
            current.add(clone)
        }
    }

    // ====== Toggle: Normal task ======

    private suspend fun toggleNormalTask(
        todo: Todo,
        current: MutableList<Todo>,
        index: Int
    ) {
        val isCompletedNow = !todo.completed
        val updatedTodo = todo.copy(
            completed = isCompletedNow,
            completedAt = if (isCompletedNow) nowInstant() else null,
            subtasks = if (isCompletedNow) {
                todo.subtasks.map { s ->
                    s.copy(completed = true, completedAt = s.completedAt ?: nowIso())
                }
            } else {
                todo.subtasks
            },
            updatedAt = nowIso()
        )
        current[index] = updatedTodo
        saveTodos(current)
    }

    suspend fun toggleTodoStatus(id: String) = mutex.withLock {
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == id }
        if (index != -1) {
            val todo = current[index]

            // 周/月打卡任务分支
            if (todo.taskType == TaskType.WEEKLY_CHECKIN || todo.taskType == TaskType.MONTHLY_CHECKIN) {
                toggleCheckinTask(todo, current, index)
                return@withLock
            }

            if (!todo.completed && todo.recurring == RecurringType.DAILY_REPEAT) {
                toggleDailyRepeatTask(todo, current)
            }
            toggleNormalTask(todo, current, index)
        }
    }

    // ====== Import Helpers ======

    /**
     * Common logic for importing cloned tasks into a target period.
     * @param candidates Source todos to clone
     * @param targetPeriodStr Target period date string
     * @return Number of tasks actually imported
     */
    private suspend fun doImport(candidates: List<Todo>, targetPeriodStr: String): Int {
        val current = _todoData.value.todos.toMutableList()
        val existingTitles = current.filter { !it.deleted && it.date == targetPeriodStr }.map { it.content }.toSet()

        var importCount = 0
        candidates.forEach { src ->
            if (existingTitles.contains(src.content)) return@forEach
            current.add(cloneTodoForNewPeriod(src, targetPeriodStr))
            importCount++
        }

        if (importCount > 0) {
            saveTodos(current)
        }
        return importCount
    }

    suspend fun importSelectedFromLastPeriod(type: String, selectedIds: List<String>) = mutex.withLock { withContext(Dispatchers.IO) {
        val today = java.time.LocalDate.now()
        val targetPeriodStr = if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today)
        } else {
            com.todo.app.data.model.monthStringOf(today)
        }

        val current = _todoData.value.todos.toMutableList()
        val candidates = current.filter { it.id in selectedIds }

        val importCount = doImport(candidates, targetPeriodStr)
        if (importCount > 0) {
            _uiEvent.send(UiEvent.ShowMessage("成功导入 $importCount 个打卡任务"))
        }
    }}

    suspend fun importFromLastPeriod(type: String) = mutex.withLock { withContext(Dispatchers.IO) {
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
            (it.taskType == TaskType.WEEKLY_CHECKIN || it.taskType == TaskType.MONTHLY_CHECKIN) &&
            it.date == sourcePeriodStr
        }

        if (candidates.isEmpty()) {
            _uiEvent.send(UiEvent.ShowMessage("上一周期没有打卡任务可供导入"))
            return@withContext
        }

        val importCount = doImport(candidates, targetPeriodStr)
        if (importCount > 0) {
            _uiEvent.send(UiEvent.ShowMessage("成功导入 $importCount 个打卡任务"))
        } else {
            _uiEvent.send(UiEvent.ShowMessage("任务已存在，无需重复导入"))
        }
    }}
}
