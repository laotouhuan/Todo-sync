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

internal fun generateShareCodeKey(random: java.security.SecureRandom = java.security.SecureRandom()): String {
    val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    return buildString(12) {
        repeat(12) { append(alphabet[random.nextInt(alphabet.length)]) }
    }
}

/**
 * 待办事项数据仓库接口，模拟本地持久化。
 */
class TodoRepository(private val context: Context) {
    private val TAG = "TodoRepository"
    private val PURGE_DELETED_AFTER_DAYS = 7

    private val jsonFormat = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }

    private val dataFile = File(context.filesDir, "todo_data.json")
    private val personalStore = PersonalDataStore(dataFile)
    private val collabFile = File(context.filesDir, "collaborations.json")
    private val collabTmpFile = File(context.filesDir, "collaborations.tmp")
    private val configManager = ConfigManager(context)
    @Volatile private var webDavClient: WebDavClient? = null
    private val webDavMutex = Mutex()

    // Repository-scoped coroutine scope: SupervisorJob ensures one failed upload doesn't cancel future ones.
    // Not cancelled explicitly -- TodoRepository is an app-singleton; call repoScope.cancel() if ever scoped shorter.
    private val repoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = personalStore.mutex

    val loadError = personalStore.loadError.asStateFlow()
    private val _timeTrackingEnabled = MutableStateFlow(configManager.timeTrackingEnabled)
    val timeTrackingEnabled = _timeTrackingEnabled.asStateFlow()

    // 等持有数据锁的修改完成后刷新，Glance 读取时不会重入同一把锁。
    private fun requestWidgetRefresh() {
        repoScope.launch {
            mutex.withLock { }
            com.todo.app.widget.refreshAllWidgets(context)
        }
    }

    private fun refreshReminders(data: TodoData) {
        runCatching { com.todo.app.notification.ReminderScheduler(context).rescheduleAll(data) }
            .onFailure { Log.e(TAG, "提醒刷新失败", it) }
    }

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

    private val _todoData = personalStore.data

    private val cloudSyncState = CloudSyncState()
    val isSyncing = cloudSyncState.syncing
    private val _syncStatus = cloudSyncState.status // 0：空闲，1：同步中，2：失败
    val syncStatus: kotlinx.coroutines.flow.StateFlow<Int> = _syncStatus.asStateFlow()

    private val uploadChannel = Channel<Unit>(Channel.CONFLATED)

    init {
        // P1-12: Load from disk asynchronously
        repoScope.launch {
            try {
                ensureDataLoaded()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _uiEvent.trySend(UiEvent.ShowError(loadError.value ?: "数据加载失败"))
            }
        }
        repoScope.launch {
            for (item in uploadChannel) {
                delay(500) // debounce
                performBackgroundUpload()
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

                val jsonString = backupFile.readText()
                val restored = personalStore.decode(jsonString)
                // 先读取并验证恢复源，避免备份轮换或同秒命名覆盖正在恢复的内容。
                createLocalBackup()
                personalStore.commitLocked(restored)
                refreshReminders(_todoData.value)
                uploadChannel.trySend(Unit)
                requestWidgetRefresh()
                true
            }.onFailure { e ->
                if (e is CancellationException) throw e
                Log.e(TAG, "restoreFromBackup failed", e)
            }.getOrDefault(false)
        }
    }



    suspend fun syncWithCloud() = mutex.withLock { withContext(Dispatchers.IO) {
        try {
            val result = cloudSyncState.run(configManager.isConfigured()) {
                requestWidgetRefresh()
                personalStore.loadLocked()
                initWebDavClient()
                val client = webDavClient ?: error("同步客户端初始化失败")
                val cloudJson = client.downloadFile(configManager.filePath)
                if (cloudJson != null) {
                    val cloudData = jsonFormat.decodeFromString<TodoData>(cloudJson)
                    val localData = _todoData.value
                    val mergedData = com.todo.app.data.model.MergeUtils.mergeTodoData(localData, cloudData)

                    val mergedJson = jsonFormat.encodeToString(mergedData)
                    val localChanged = com.todo.app.data.model.MergeUtils.hasContentChanges(mergedData, localData)
                    val cloudChanged = com.todo.app.data.model.MergeUtils.hasContentChanges(mergedData, cloudData)
                    if (localChanged) {
                        createLocalBackup()
                        personalStore.commitLocked(mergedData)
                        requestWidgetRefresh()
                        refreshReminders(mergedData)
                    }
                    if (cloudChanged) {
                        client.uploadFile(configManager.filePath, mergedJson)
                    }
                    if (localChanged) _uiEvent.trySend(UiEvent.ShowMessage("检测到云端更新，已自动同步完成"))
                } else {
                    // 只有成功加载的数据才能上传。
                    client.uploadFile(configManager.filePath, jsonFormat.encodeToString(_todoData.value))
                }
            }
            result.exceptionOrNull()?.let { e ->
                Log.e(TAG, "syncWithCloud failed", e)
                _uiEvent.trySend(UiEvent.ShowError("同步失败: ${e.message}"))
            }
        } finally {
            requestWidgetRefresh()
        }
    }
    }

    suspend fun forcePullCloud() = mutex.withLock { withContext(Dispatchers.IO) {
        try {
            initWebDavClient()
            val client = webDavClient ?: throw Exception("配置信息未填写完整")
            val cloudJson = client.downloadFile(configManager.filePath)
            if (cloudJson != null) {
                val cloudData = jsonFormat.decodeFromString<TodoData>(cloudJson)
                val migratedData = com.todo.app.data.model.MergeUtils.normalizeData(cloudData)
                createLocalBackup()
                personalStore.commitLocked(migratedData)
                requestWidgetRefresh()
                refreshReminders(migratedData)
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

    // 学习数据与普通待办共用锁，落盘成功后再公布状态。
    private suspend fun changeLearning(change: (TodoData) -> TodoData): Result<Unit> = mutex.withLock {
        withContext(Dispatchers.IO) {
            try {
                personalStore.loadLocked()
                val updated = change(_todoData.value).copy(last_updated = nowIso())
                personalStore.commitLocked(updated)
                uploadChannel.trySend(Unit)
                requestWidgetRefresh()
                Result.success(Unit)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                Result.failure(e)
            }
        }
    }

    suspend fun startLearning(todo: Todo, ref: com.todo.app.data.model.TaskReference): Result<Unit> {
        try {
            ensureDataLoaded()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            return Result.failure(e)
        }
        syncWithCloud()
        return withContext(Dispatchers.IO) {
            try {
                personalStore.start(todo, ref, { configManager.timeTrackingEnabled })
                uploadChannel.trySend(Unit)
                requestWidgetRefresh()
                Result.success(Unit)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                Result.failure(e)
            }
        }
    }

    suspend fun stopLearning(id: String): Result<Int> = withContext(Dispatchers.IO) {
        try {
            val discarded = personalStore.stop(id, { configManager.timeTrackingEnabled })
            uploadChannel.trySend(Unit)
            Result.success(discarded)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Result.failure(e)
        } finally {
            requestWidgetRefresh()
        }
    }

    suspend fun saveTimeEntry(entry: com.todo.app.data.model.TimeEntry): Result<Unit> = changeLearning { data ->
        require(configManager.timeTrackingEnabled) { "本机任务计时已关闭" }
        if (!entry.deleted) {
            require(entry.ended_at != null || data.timeEntries.any { it.id == entry.id && it.ended_at == null && !it.deleted }) { "补录必须填写结束时间" }
            val error = com.todo.app.data.model.Learning.validate(entry, data.timeEntries)
            require(error == null) { error ?: "记录无效" }
        }
        data.copy(timeEntries = com.todo.app.data.model.Learning.mergeTimes(data.timeEntries.filter { it.id != entry.id } + entry.copy(
            updated_at = nowIso(), label_snapshot = com.todo.app.data.model.Learning.label(entry.label_snapshot))))
    }

    suspend fun saveTimingPreferences(dueDate: String, insertion: String, timing: Boolean,
        expected: List<com.todo.app.data.model.TimeEntry>?): Result<Int> = withContext(Dispatchers.IO) {
        val before = _todoData.value
        try {
            val discarded = personalStore.saveTimingPreferences(expected, {
                configManager.savePreferences(dueDate, insertion, timing)
            })
            Result.success(discarded)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            Result.failure(e)
        } finally {
            _timeTrackingEnabled.value = configManager.timeTrackingEnabled
            if (_todoData.value !== before) uploadChannel.trySend(Unit)
            requestWidgetRefresh()
        }
    }

    suspend fun updatePersonalLabels(plan: com.todo.app.data.model.LabelChangePlan, target: String?): Result<Int> {
        return mutex.withLock {
            withContext(Dispatchers.IO) {
                try {
                    personalStore.loadLocked()
                    val (todos, count) = com.todo.app.data.model.LabelUtils.apply(_todoData.value.todos, plan, target, nowIso())
                    if (count > 0) {
                        // 标签操作完整保留个人扩展数据，不触发任务删除或运行记录清理。
                        val updated = _todoData.value.copy(todos = todos, last_updated = nowIso())
                        personalStore.commitLocked(updated)
                        uploadChannel.trySend(Unit)
                        requestWidgetRefresh()
                    }
                    Result.success(count)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    Result.failure(e)
                }
            }
        }
    }

    suspend fun saveDailyReview(review: com.todo.app.data.model.DailyReview): Result<Unit> = changeLearning { data ->
        java.time.LocalDate.parse(review.date)
        require(com.todo.app.data.model.Learning.fields(review).any { it.second.isNotBlank() }) { "请至少填写一项复盘内容" }
        val existing = data.dailyReviews.find { it.date == review.date }
        data.copy(dailyReviews = com.todo.app.data.model.Learning.mergeReviews(data.dailyReviews.filter { it.date != review.date } + review.copy(
            id = existing?.id ?: review.id, created_at = existing?.created_at ?: review.created_at, updated_at = nowIso())))
    }

    /** 将源 Todo 克隆到新周期，重置完成状态和子任务 */
    private fun cloneTodoForNewPeriod(source: Todo, targetDateStr: String): Todo {
        return Todo.create(source.content, targetDateStr).copy(
            label = source.label,
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
     * 等待磁盘数据加载完成后返回当前数据。
     * 已加载时在锁内复用缓存，不重复读取磁盘。
     * 供冷启动场景（BroadcastReceiver / Boot / Widget / App 启动）使用。
     */
    suspend fun ensureDataLoaded(): TodoData = withContext(Dispatchers.IO) { personalStore.ensureLoaded() }

    /** 物理清理已删除超过 PURGE_DELETED_AFTER_DAYS 天的旧记录，防止 JSON 无限膨胀。
     *  与 Windows 端 purgeOldDeletedTodos() 逻辑完全对齐。 */
    private fun purgeOldDeletedTodos(todos: List<Todo>): List<Todo> {
        val cutoff = System.currentTimeMillis() - PURGE_DELETED_AFTER_DAYS * 24L * 60 * 60 * 1000
        val result = todos.filter { todo ->
            if (!todo.deleted) return@filter true
            val ts = todo.updatedAt.ifEmpty { todo.createdAt }
            val millis = try {
                java.time.OffsetDateTime.parse(ts).toInstant().toEpochMilli()
            } catch (_: Exception) {
                try { java.time.Instant.parse(ts).toEpochMilli() } catch (_: Exception) {
                    Long.MAX_VALUE // 解析失败时保守保留，避免误删
                }
            }
            millis >= cutoff // 保留未超期的
        }
        val purgedCount = todos.size - result.size
        if (purgedCount > 0) {
            Log.d(TAG, "[Purge] 自动物理清理了 $purgedCount 个已删除超过 ${PURGE_DELETED_AFTER_DAYS} 天的旧任务记录。")
        }
        return result
    }

    /**
     * Save the given list of todos to disk and trigger a background upload.
     * Callers must hold [mutex] before invoking this method.
     */
    private suspend fun saveTodos(todos: List<Todo>) = withContext(Dispatchers.IO) {
        personalStore.loadLocked()
        val previous = _todoData.value
        // 物理清理：删除超过 7 天的软删除记录，与 Windows 端 purgeOldDeletedTodos() 对齐
        val purged = purgeOldDeletedTodos(todos)
        val updated = TodoData(
            version = previous.version,
            last_updated = nowIso(),
            todos = purged,
            reminderSettings = previous.reminderSettings,
            timeEntries = previous.timeEntries.map { entry ->
                if (!entry.deleted && entry.ended_at == null && entry.task_ref.source_type == "personal" && todos.any { it.id == entry.task_ref.todo_id && it.deleted })
                    entry.copy(ended_at = nowIso(), updated_at = nowIso()) else entry
            },
            dailyReviews = previous.dailyReviews
        )
        personalStore.commitLocked(updated)
        requestWidgetRefresh()
        refreshReminders(updated)
        uploadChannel.trySend(Unit)
        Unit
    }

    suspend fun updateReminderSettings(settings: com.todo.app.data.model.ReminderSettings) = mutex.withLock {
        withContext(Dispatchers.IO) {
            personalStore.loadLocked()
            val previous = _todoData.value
            val settingsUpdatedAt = nowInstant()
            val updated = previous.copy(
                last_updated = settingsUpdatedAt,
                reminderSettings = settings.copy(updatedAt = settingsUpdatedAt)
            )
            try {
                personalStore.commitLocked(updated)
                refreshReminders(updated)
                uploadChannel.trySend(Unit)
                requestWidgetRefresh()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _uiEvent.trySend(UiEvent.ShowError("提醒设置保存失败：${e.message}"))
            }
        }
    }

    private suspend fun performBackgroundUpload() = mutex.withLock {
        try {
            cloudSyncState.run(configManager.isConfigured()) {
                val currentData = personalStore.loadLocked()
                requestWidgetRefresh()
                initWebDavClient()
                val client = webDavClient ?: error("同步客户端初始化失败")
                client.uploadFile(configManager.filePath, jsonFormat.encodeToString(currentData))
            }.onFailure { Log.e(TAG, "performBackgroundUpload upload failed", it) }
        } finally {
            requestWidgetRefresh()
        }
    }

    suspend fun addTodo(todo: Todo) = mutex.withLock {
        withContext(Dispatchers.IO) { personalStore.loadLocked() }
        val current = _todoData.value.todos.toMutableList()
        current.add(todo.copy(updatedAt = nowIso()))
        saveTodos(current)
    }

    suspend fun updateTodo(todo: Todo) = mutex.withLock {
        withContext(Dispatchers.IO) { personalStore.loadLocked() }
        val current = _todoData.value.todos.toMutableList()
        val index = current.indexOfFirst { it.id == todo.id }
        if (index != -1) {
            current[index] = todo.copy(updatedAt = nowIso())
            saveTodos(current)
        }
    }

    suspend fun batchUpdateTodos(updatedTodos: List<Todo>) = mutex.withLock {
        withContext(Dispatchers.IO) { personalStore.loadLocked() }
        val current = _todoData.value.todos.toMutableList()
        val indexMap = current.withIndex().associate { (i, t) -> t.id to i }
        val now = nowIso()
        for (todo in updatedTodos) {
            val index = indexMap[todo.id] ?: -1
            if (index != -1) {
                current[index] = todo.copy(updatedAt = now)
            }
        }
        saveTodos(current)
    }

    suspend fun deleteTodo(id: String) = mutex.withLock {
        withContext(Dispatchers.IO) { personalStore.loadLocked() }
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
        withContext(Dispatchers.IO) { personalStore.loadLocked() }
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

        val nowEpochMs = System.currentTimeMillis()
        var importCount = 0
        var orderOffset = 0L

        candidates.forEach { src ->
            if (existingTitles.contains(src.content)) return@forEach
            val cloned = cloneTodoForNewPeriod(src, targetPeriodStr).copy(
                order = (nowEpochMs + orderOffset * 1000).toDouble(),
                createdAt = java.time.Instant.ofEpochMilli(nowEpochMs + orderOffset * 10).toString()
            )
            current.add(cloned)
            orderOffset++
            importCount++
        }

        if (importCount > 0) {
            saveTodos(current)
        }
        return importCount
    }

    suspend fun importSelectedFromLastPeriod(type: String, selectedIds: List<String>) = mutex.withLock { withContext(Dispatchers.IO) {
        personalStore.loadLocked()
        val today = java.time.LocalDate.now()
        val targetPeriodStr = if (type == "weekly") {
            com.todo.app.data.model.weekStringOf(today)
        } else {
            com.todo.app.data.model.monthStringOf(today)
        }

        val current = _todoData.value.todos.toMutableList()
        val candidates = current.filter { it.id in selectedIds }.sortedWith(com.todo.app.data.model.TodoComparator)

        val importCount = doImport(candidates, targetPeriodStr)
        if (importCount > 0) {
            _uiEvent.send(UiEvent.ShowMessage("成功导入 $importCount 个打卡任务"))
        }
    }}

    suspend fun importFromLastPeriod(type: String) = mutex.withLock { withContext(Dispatchers.IO) {
        personalStore.loadLocked()
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
        val key = generateShareCodeKey()

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
