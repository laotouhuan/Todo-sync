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
import kotlinx.coroutines.CancellationException
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
    private val collabFile = File(context.filesDir, "collaborations.json")
    private val collabTmpFile = File(context.filesDir, "collaborations.tmp")
    private val configManager = ConfigManager(context)
    @Volatile private var webDavClient: WebDavClient? = null
    private val webDavMutex = Mutex()

    // Repository-scoped coroutine scope: SupervisorJob ensures one failed upload doesn't cancel future ones.
    // Not cancelled explicitly -- TodoRepository is an app-singleton; call repoScope.cancel() if ever scoped shorter.
    private val repoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()

    private val _uiEvent = Channel<UiEvent>(Channel.BUFFERED)
    val uiEvent: Flow<UiEvent> = _uiEvent.receiveAsFlow()

    private val _collaborations = MutableStateFlow<List<com.todo.app.data.model.CollaborationSource>>(emptyList())
    val collaborations = _collaborations.asStateFlow()

    init {
        repoScope.launch {
            loadCollaborationsLocally()
        }
    }

    private fun writeCollaborationsFile(json: String) {
        try {
            collabTmpFile.outputStream().use { fos ->
                fos.write(json.toByteArray(Charsets.UTF_8))
                fos.fd.sync()
            }
            if (!collabTmpFile.renameTo(collabFile)) {
                collabFile.outputStream().use { fos ->
                    fos.write(collabTmpFile.readBytes())
                    fos.fd.sync()
                }
                collabTmpFile.delete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write collaborations file atomically", e)
        }
    }

    private suspend fun loadCollaborationsLocally() = withContext(Dispatchers.IO) {
        mutex.withLock {
            // 1. 检查 SharedPreferences 中是否有旧数据（迁移逻辑）
            val legacyCollabs = configManager.collaborations
            if (legacyCollabs.isNotEmpty()) {
                Log.d(TAG, "Migrating legacy collaborations from SharedPreferences...")
                var currentData = if (collabFile.exists()) {
                    try {
                        val content = collabFile.readText(Charsets.UTF_8)
                        jsonFormat.decodeFromString<com.todo.app.data.model.CollaborationData>(content)
                    } catch (e: Exception) {
                        com.todo.app.data.model.CollaborationData()
                    }
                } else {
                    com.todo.app.data.model.CollaborationData()
                }

                val nowStr = nowIso()
                val mergedList = currentData.collaborations.toMutableList()
                for (item in legacyCollabs) {
                    if (mergedList.none { it.id == item.id }) {
                        mergedList.add(item.copy(updatedAt = nowStr, deleted = false))
                    }
                }

                val migratedData = com.todo.app.data.model.CollaborationData(
                    version = 1,
                    lastUpdated = nowStr,
                    collaborations = mergedList
                )

                writeCollaborationsFile(jsonFormat.encodeToString(migratedData))
                configManager.collaborations = emptyList()
                Log.d(TAG, "Legacy collaborations migration completed.")
            }

            // 2. 读取 collaborations.json 并加载到内存
            if (collabFile.exists()) {
                try {
                    val content = collabFile.readText(Charsets.UTF_8)
                    val data = jsonFormat.decodeFromString<com.todo.app.data.model.CollaborationData>(content)
                    _collaborations.value = data.collaborations.filter { !it.deleted }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to load collaborations.json", e)
                    _collaborations.value = emptyList()
                }
            } else {
                _collaborations.value = emptyList()
            }
        }
    }

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
                if (e is CancellationException) throw e
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
            runCatching {
                val backupFile = File(File(context.filesDir, "backups"), filename)
                if (!backupFile.exists()) return@withContext false

                createLocalBackup() // backup the current state before restoring

                val jsonString = backupFile.readText()
                _todoData.value = jsonFormat.decodeFromString<TodoData>(jsonString)
                atomicWriteJson(jsonString)

                initWebDavClient()
                webDavClient?.uploadFile(configManager.filePath, jsonString)

                com.todo.app.widget.refreshAllWidgets(context)
                true
            }.onFailure { e ->
                if (e is CancellationException) throw e
                Log.e(TAG, "restoreFromBackup failed", e)
            }.getOrDefault(false)
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
                    if (e is CancellationException) throw e
                    Log.e(TAG, "syncWithCloud merge failed", e)
                }
            } else {
                // 当云端不存在该文件，或获取失败时，尝试将本地数据作为初始版本上传
                client.uploadFile(configManager.filePath, jsonFormat.encodeToString(_todoData.value))
            }
            _syncStatus.value = 0
            com.todo.app.widget.refreshAllWidgets(context)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
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
            if (e is CancellationException) throw e
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
            if (e is CancellationException) throw e
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
            if (e is CancellationException) throw e
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
            if (e is CancellationException) throw e
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

        if (dates.any { it.startsWith(todayStr) }) {
            _uiEvent.send(UiEvent.ShowMessage("今天已打卡！如需消卡，请进入编辑弹窗。"))
            return
        }

        dates.add(nowIso())
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

    suspend fun readCollaborationTodos(collab: com.todo.app.data.model.CollaborationSource): Result<TodoData> = withContext(Dispatchers.IO) {
        try {
            val client = WebDavClient(collab.webdavUrl, collab.webdavUsername, collab.webdavPassword)
            val result = client.downloadCollaborationFile(collab.webdavFilepath)
            
            if (collab.expireAt != null) {
                val serverTime = result.serverTime
                if (serverTime.isNotEmpty()) {
                    try {
                        val zdt = java.time.ZonedDateTime.parse(serverTime, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)
                        val epochSeconds = zdt.toEpochSecond()
                        if (epochSeconds > collab.expireAt) {
                            return@withContext Result.failure(Exception("EXPIRED"))
                        }
                    } catch (e: Exception) {
                        if (e.message == "EXPIRED") return@withContext Result.failure(e)
                        return@withContext Result.failure(Exception("无法校验网络安全时间，授权已锁定"))
                    }
                } else {
                    return@withContext Result.failure(Exception("无法校验网络安全时间，授权已锁定"))
                }
            }

            val data = jsonFormat.decodeFromString<TodoData>(result.content)
            data.todos.forEach {
                if (it.recurring == "daily") {
                    it.recurring = "daily_repeat"
                } else if (it.recurring == "weekly") {
                    it.taskType = TaskType.WEEKLY_CHECKIN
                    it.recurring = "none"
                } else if (it.recurring == "monthly") {
                    it.taskType = TaskType.MONTHLY_CHECKIN
                    it.recurring = "none"
                }
            }
            Result.success(data)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Log.e(TAG, "readCollaborationTodos failed", e)
            Result.failure(e)
        }
    }

    suspend fun writeCollaborationTodo(collab: com.todo.app.data.model.CollaborationSource, todo: Todo): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            val client = WebDavClient(collab.webdavUrl, collab.webdavUsername, collab.webdavPassword)
            val result = client.downloadCollaborationFile(collab.webdavFilepath)

            if (collab.expireAt != null) {
                val serverTime = result.serverTime
                if (serverTime.isNotEmpty()) {
                    try {
                        val zdt = java.time.ZonedDateTime.parse(serverTime, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)
                        val epochSeconds = zdt.toEpochSecond()
                        if (epochSeconds > collab.expireAt) {
                            return@withContext Result.failure(Exception("EXPIRED"))
                        }
                    } catch (e: Exception) {
                        if (e.message == "EXPIRED") return@withContext Result.failure(e)
                        return@withContext Result.failure(Exception("无法校验网络安全时间，授权已锁定"))
                    }
                } else {
                    return@withContext Result.failure(Exception("无法校验网络安全时间，授权已锁定"))
                }
            }

            val data = jsonFormat.decodeFromString<TodoData>(result.content)
            val alreadyExists = data.todos.any { it.id == todo.id }
            val updatedTodos = if (alreadyExists) data.todos else data.todos + todo

            val updated = data.copy(
                todos = updatedTodos,
                last_updated = nowIso()
            )
            val json = jsonFormat.encodeToString(updated)
            val ok = client.uploadFile(collab.webdavFilepath, json)
            if (ok) Result.success(Unit) else Result.failure(Exception("上传失败"))
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Log.e(TAG, "writeCollaborationTodo failed", e)
            Result.failure(e)
        }
    }

    fun generateShareCode(expireDays: Int?): Pair<String, String> {
        val expTime = if (expireDays != null && expireDays > 0) {
            (System.currentTimeMillis() / 1000) + expireDays * 86400L
        } else {
            0L
        }
        val payload = com.todo.app.data.model.ShareCodePayload(
            url = configManager.webDavUrl,
            user = configManager.username,
            pass = configManager.appPassword,
            path = configManager.filePath,
            exp = expTime
        )
        val json = jsonFormat.encodeToString(payload)
        val key = (1..12).map {
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[(0 until 62).random()]
        }.joinToString("")

        // Derivate key via SHA-256
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val keyBytes = digest.digest(key.trim().toByteArray(Charsets.UTF_8))
        val secretKeySpec = javax.crypto.spec.SecretKeySpec(keyBytes, "AES")

        // Generate random 12-byte IV
        val iv = ByteArray(12)
        java.security.SecureRandom().nextBytes(iv)

        // AES-GCM-256 encrypt
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        val gcmParameterSpec = javax.crypto.spec.GCMParameterSpec(128, iv)
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, secretKeySpec, gcmParameterSpec)
        
        val ciphertextWithTag = cipher.doFinal(json.toByteArray(Charsets.UTF_8))

        // Pack IV + ciphertext + tag
        val packed = ByteArray(12 + ciphertextWithTag.size)
        System.arraycopy(iv, 0, packed, 0, 12)
        System.arraycopy(ciphertextWithTag, 0, packed, 12, ciphertextWithTag.size)

        val base64 = android.util.Base64.encodeToString(packed, android.util.Base64.NO_WRAP)
        return Pair("tdsync://$base64", key)
    }

    fun decryptShareCode(code: String, keyStr: String): String {
        val cleanCode = code.removePrefix("tdsync://")
        val packed = android.util.Base64.decode(cleanCode, android.util.Base64.DEFAULT)
        
        if (packed.size < 12 + 16) {
            throw Exception("授权码数据损坏")
        }

        // 1. 解析出 IV (12字节) 和 密文+Tag
        val iv = packed.sliceArray(0 until 12)
        val ciphertextWithTag = packed.sliceArray(12 until packed.size)

        // 2. 从密钥字符串派生密钥 (SHA-256)
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val keyBytes = digest.digest(keyStr.trim().toByteArray(Charsets.UTF_8))

        // 3. AES-GCM-256 解密
        val secretKeySpec = javax.crypto.spec.SecretKeySpec(keyBytes, "AES")
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        val gcmParameterSpec = javax.crypto.spec.GCMParameterSpec(128, iv)
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secretKeySpec, gcmParameterSpec)
        
        val decryptedBytes = cipher.doFinal(ciphertextWithTag)
        return String(decryptedBytes, Charsets.UTF_8)
    }

    suspend fun importCollaboration(code: String, key: String, name: String): Result<com.todo.app.data.model.CollaborationSource> = withContext(Dispatchers.IO) {
        try {
            val plaintext = decryptShareCode(code, key)
            val json = Json { ignoreUnknownKeys = true }
            val payload = json.decodeFromString<com.todo.app.data.model.ShareCodePayload>(plaintext)
            
            if (!payload.url.startsWith("https://")) {
                return@withContext Result.failure(Exception("URL 必须使用 https"))
            }

            mutex.withLock {
                val content = if (collabFile.exists()) collabFile.readText(Charsets.UTF_8) else ""
                var collabData = try {
                    jsonFormat.decodeFromString<com.todo.app.data.model.CollaborationData>(content)
                } catch (e: Exception) {
                    com.todo.app.data.model.CollaborationData()
                }

                val collabs = collabData.collaborations.toMutableList()
                val nowStr = nowIso()
                val existingIdx = collabs.indexOfFirst {
                    it.webdavUrl == payload.url && it.webdavUsername == payload.user && it.webdavFilepath == payload.path
                }

                val resultCollab: com.todo.app.data.model.CollaborationSource
                if (existingIdx != -1) {
                    val existing = collabs[existingIdx]
                    val updated = existing.copy(
                        webdavPassword = payload.pass,
                        expireAt = if (payload.exp == 0L) null else payload.exp,
                        updatedAt = nowStr,
                        deleted = false,
                        name = name
                    )
                    collabs[existingIdx] = updated
                    resultCollab = updated
                } else {
                    val newCollab = com.todo.app.data.model.CollaborationSource(
                        id = UUID.randomUUID().toString(),
                        name = name,
                        webdavUrl = payload.url,
                        webdavUsername = payload.user,
                        webdavPassword = payload.pass,
                        webdavFilepath = payload.path,
                        expireAt = if (payload.exp == 0L) null else payload.exp,
                        updatedAt = nowStr,
                        deleted = false
                    )
                    collabs.add(newCollab)
                    resultCollab = newCollab
                }

                val updatedData = collabData.copy(
                    lastUpdated = nowStr,
                    collaborations = collabs
                )

                writeCollaborationsFile(jsonFormat.encodeToString(updatedData))
                _collaborations.value = collabs.filter { !it.deleted }
                
                repoScope.launch {
                    syncCollaborations()
                }

                return@withContext Result.success(resultCollab)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Import collaboration failed", e)
            return@withContext Result.failure(e)
        }
    }

    suspend fun deleteCollaboration(id: String): Result<Unit> = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (!collabFile.exists()) return@withContext Result.success(Unit)
            val content = collabFile.readText(Charsets.UTF_8)
            var collabData = try {
                jsonFormat.decodeFromString<com.todo.app.data.model.CollaborationData>(content)
            } catch (e: Exception) {
                com.todo.app.data.model.CollaborationData()
            }

            val collabs = collabData.collaborations.toMutableList()
            val idx = collabs.indexOfFirst { it.id == id }
            if (idx != -1) {
                val nowStr = nowIso()
                collabs[idx] = collabs[idx].copy(deleted = true, updatedAt = nowStr)
                val updatedData = collabData.copy(
                    lastUpdated = nowStr,
                    collaborations = collabs
                )
                writeCollaborationsFile(jsonFormat.encodeToString(updatedData))
                _collaborations.value = collabs.filter { !it.deleted }
                
                repoScope.launch {
                    syncCollaborations()
                }
            }
            Result.success(Unit)
        }
    }

    fun mergeCollaborations(
        local: com.todo.app.data.model.CollaborationData,
        cloud: com.todo.app.data.model.CollaborationData
    ): Pair<com.todo.app.data.model.CollaborationData, Boolean> {
        val mergedList = mutableListOf<com.todo.app.data.model.CollaborationSource>()
        val localList = local.collaborations
        val cloudList = cloud.collaborations
        
        val allIds = (localList.map { it.id } + cloudList.map { it.id }).toSet()
        var changed = false
        
        for (id in allIds) {
            val localItem = localList.find { it.id == id }
            val cloudItem = cloudList.find { it.id == id }
            
            if (localItem != null && cloudItem != null) {
                val localTime = try { OffsetDateTime.parse(localItem.updatedAt).toInstant().toEpochMilli() } catch (e: Exception) { 0L }
                val cloudTime = try { OffsetDateTime.parse(cloudItem.updatedAt).toInstant().toEpochMilli() } catch (e: Exception) { 0L }
                
                if (cloudTime > localTime) {
                    mergedList.add(cloudItem)
                    changed = true
                } else {
                    mergedList.add(localItem)
                    if (localTime > cloudTime) {
                        changed = true
                    }
                }
            } else if (localItem != null) {
                mergedList.add(localItem)
                changed = true
            } else if (cloudItem != null) {
                mergedList.add(cloudItem)
                changed = true
            }
        }
        
        val nowStr = nowIso()
        val mergedData = com.todo.app.data.model.CollaborationData(
            version = 1,
            lastUpdated = if (changed) nowStr else (local.lastUpdated.takeIf { it.isNotEmpty() } ?: cloud.lastUpdated.takeIf { it.isNotEmpty() } ?: nowStr),
            collaborations = mergedList
        )
        
        return Pair(mergedData, changed)
    }

    suspend fun syncCollaborations() = withContext(Dispatchers.IO) {
        initWebDavClient()
        val client = webDavClient ?: return@withContext
        
        val basePath = configManager.filePath
        val lastSlash = basePath.lastIndexOf('/')
        val parentPath = if (lastSlash != -1) basePath.substring(0, lastSlash) else ""
        val collabFilePath = if (parentPath.isNotEmpty()) "$parentPath/collaborations.json" else "collaborations.json"
        
        mutex.withLock {
            val localContent = if (collabFile.exists()) collabFile.readText(Charsets.UTF_8) else ""
            var localData = try {
                jsonFormat.decodeFromString<com.todo.app.data.model.CollaborationData>(localContent)
            } catch (e: Exception) {
                com.todo.app.data.model.CollaborationData()
            }

            var cloudData: com.todo.app.data.model.CollaborationData? = null
            try {
                val cloudContent = client.downloadFile(collabFilePath)
                if (cloudContent != null) {
                    cloudData = jsonFormat.decodeFromString<com.todo.app.data.model.CollaborationData>(cloudContent)
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                Log.e(TAG, "Failed to download collaborations.json from cloud", e)
            }

            if (cloudData != null) {
                val (merged, changed) = mergeCollaborations(localData, cloudData)
                if (changed) {
                    val mergedStr = jsonFormat.encodeToString(merged)
                    writeCollaborationsFile(mergedStr)
                    try {
                        client.uploadFile(collabFilePath, mergedStr)
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        Log.e(TAG, "Failed to upload collaborations.json to cloud", e)
                    }
                }
                _collaborations.value = merged.collaborations.filter { !it.deleted }
            } else {
                val localStr = jsonFormat.encodeToString(localData)
                try {
                    client.uploadFile(collabFilePath, localStr)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    Log.e(TAG, "Failed to upload collaborations.json to cloud", e)
                }
                _collaborations.value = localData.collaborations.filter { !it.deleted }
            }
        }
    }
}
