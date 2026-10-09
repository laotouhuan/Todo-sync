package com.todo.app.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.todo.app.data.ConfigManager
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import com.todo.app.data.model.learningViewData
import com.todo.app.data.model.requirePersonalTarget
import com.todo.app.data.model.CollaborationSubmitter
import com.todo.app.data.model.HealthMetrics
import com.todo.app.data.model.calculateHealthMetrics
import com.todo.app.data.model.parseDateSyntax
import com.todo.app.data.repository.TodoRepository
import com.todo.app.data.repository.CloudSyncState
import com.todo.app.data.model.SyncOutcome
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.async

import java.util.UUID
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Dispatchers

class TodoViewModel(private val repository: TodoRepository, val configManager: ConfigManager) : ViewModel() {
    val timeTrackingEnabled: StateFlow<Boolean> = repository.timeTrackingEnabled
    val dataLoadError = repository.loadError
    private val _discardedShortTimers = MutableStateFlow(0)
    val discardedShortTimers: StateFlow<Int> = _discardedShortTimers.asStateFlow()

    fun dismissShortTimerNotice() { _discardedShortTimers.value = 0 }

    suspend fun savePreferences(dueDate: String, insertion: String, timing: Boolean,
        endRecords: List<com.todo.app.data.model.TimeEntry>? = null,
        completeSubtasks: Boolean = configManager.completeSubtasksWithParent,
        completeParent: Boolean = configManager.completeParentWithSubtasks): Result<Unit> {
        return repository.saveTimingPreferences(dueDate, insertion, timing, endRecords, completeSubtasks, completeParent).map { discarded ->
            _discardedShortTimers.value += discarded
        }
    }

    suspend fun updatePersonalLabels(plan: com.todo.app.data.model.LabelChangePlan, target: String?) = repository.updatePersonalLabels(plan, target)

    sealed class ActiveSource {
        object Personal : ActiveSource()
        data class Collaboration(val collab: com.todo.app.data.model.CollaborationSource) : ActiveSource()
    }

    private val _activeSource = MutableStateFlow<ActiveSource>(ActiveSource.Personal)
    val activeSource: StateFlow<ActiveSource> = _activeSource.asStateFlow()

    val collaborations: StateFlow<List<com.todo.app.data.model.CollaborationSource>> = repository.collaborations

    suspend fun importCollaboration(code: String, key: String, name: String): Boolean {
        val res = repository.importCollaboration(code, key, name)
        if (res.isFailure) {
            val error = res.exceptionOrNull()?.message ?: "未知错误"
            _uiEvent.emit("导入失败: ${if (error == "EXPIRED") "授权已过期，请联系对方重新生成。" else error}")
        } else {
            val source = res.getOrThrow()
            if ((_activeSource.value as? ActiveSource.Collaboration)?.collab?.id == source.id) {
                switchToCollaboration(source)
            }
            _uiEvent.emit("协作清单已验证并导入")
        }
        return res.isSuccess
    }

    fun deleteCollaboration(id: String) {
        viewModelScope.launch {
            val res = repository.deleteCollaboration(id)
            if (res.isFailure) {
                _uiEvent.emit("解绑失败: ${res.exceptionOrNull()?.message ?: "未知错误"}")
            } else {
                _uiEvent.emit("解绑成功")
            }
        }
    }

    private val _collabSnapshot = MutableStateFlow<Pair<String, TodoData>?>(null)
    private val _collabData = MutableStateFlow<List<Todo>?>(null)
    val collabData: StateFlow<List<Todo>?> = _collabData.asStateFlow()

    private val _collabLoading = MutableStateFlow(false)
    val collabLoading: StateFlow<Boolean> = _collabLoading.asStateFlow()

    private val _collabError = MutableStateFlow<String?>(null)
    val collabError: StateFlow<String?> = _collabError.asStateFlow()
    private var collabRequest = 0L
    private val collabSyncState = CloudSyncState()
    private fun syncTarget(source: ActiveSource): String = when (source) {
        is ActiveSource.Personal -> "personal"
        is ActiveSource.Collaboration -> "collaboration:${source.collab.id}:${source.collab.updatedAt}"
    }

    fun switchToPersonal() {
        collabRequest++
        collabSyncState.reset()
        _activeSource.value = ActiveSource.Personal
        _collabData.value = null
        _collabSnapshot.value = null
        _collabError.value = null
        _collabLoading.value = false
    }

    fun switchToCollaboration(collab: com.todo.app.data.model.CollaborationSource) {
        _collabData.value = null
        _collabSnapshot.value = null
        _activeSource.value = ActiveSource.Collaboration(collab)
        loadCollabData(collab)
    }

    fun loadCollabData(collab: com.todo.app.data.model.CollaborationSource) {
        if ((_activeSource.value as? ActiveSource.Collaboration)?.collab != collab) return
        val request = ++collabRequest
        _collabSnapshot.value = null
        _collabData.value = null
        _collabLoading.value = true
        viewModelScope.launch {
            if (request != collabRequest || (_activeSource.value as? ActiveSource.Collaboration)?.collab != collab) return@launch
            _collabError.value = null
            val result = try {
                var snapshot: TodoData? = null
                val outcome = collabSyncState.run(true, syncTarget(ActiveSource.Collaboration(collab))) {
                    snapshot = repository.readCollaborationTodos(collab).getOrThrow()
                }
                if (outcome.isSuccess) Result.success(requireNotNull(snapshot))
                else Result.failure(requireNotNull(outcome.error))
            } catch (e: CancellationException) {
                if (request == collabRequest) _collabLoading.value = false
                throw e
            }
            if (request != collabRequest || (_activeSource.value as? ActiveSource.Collaboration)?.collab != collab) return@launch
            if (result.isSuccess) {
                _collabSnapshot.value = collab.id to result.getOrThrow()
                _collabData.value = result.getOrThrow().todos
            } else {
                _collabData.value = null
                _collabSnapshot.value = null
                val err = result.exceptionOrNull()?.message ?: "未知错误"
                _collabError.value = if (err == "EXPIRED") {
                    "授权已过期，请联系对方重新生成授权码"
                } else {
                    err
                }
            }
            _collabLoading.value = false
        }
    }

    private val _todayDate = MutableStateFlow(java.time.LocalDate.now().toString())
    val todayDate: StateFlow<String> = _todayDate.asStateFlow()

    private val _isEditingDialogShowing = MutableStateFlow(false)
    val isEditingDialogShowing: StateFlow<Boolean> = _isEditingDialogShowing.asStateFlow()

    private var pendingMidnightRefresh = false

    private val _uiEvent = MutableSharedFlow<String>()
    val uiEvent: SharedFlow<String> = _uiEvent.asSharedFlow()
    val repositoryEvents = repository.uiEvent

    fun refreshTodayDate() {
        _todayDate.value = java.time.LocalDate.now().toString()
    }

    fun setEditingDialogShowing(showing: Boolean) {
        _isEditingDialogShowing.value = showing
    }

    fun consumePendingMidnightRefresh(): Boolean {
        if (pendingMidnightRefresh) {
            pendingMidnightRefresh = false
            return true
        }
        return false
    }

    val todoData: StateFlow<com.todo.app.data.model.TodoData> = repository.getTodoData()
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = com.todo.app.data.model.TodoData(1, "", emptyList())
        )

    fun updateReminderSettings(settings: com.todo.app.data.model.ReminderSettings) {
        viewModelScope.launch {
            try {
                repository.updateReminderSettings(settings)
                rescheduleAlarms()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _uiEvent.emit("提醒设置失败：${e.message}")
            }
        }
    }

    fun rescheduleAlarms() {
        viewModelScope.launch {
            try {
                val data = repository.ensureDataLoaded()
                com.todo.app.notification.ReminderScheduler(configManager.context).rescheduleAll(data)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                android.util.Log.e("TodoViewModel", "数据未就绪，暂不调度提醒", e)
            }
        }
    }

    val todos = repository.getTodoData().map { data ->
        data.todos.filter { !it.deleted }
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = emptyList()
    )

    val activeTodos: StateFlow<List<Todo>> = kotlinx.coroutines.flow.combine(
        todos,
        activeSource,
        collabData
    ) { personalList, activeSrc, collabList ->
        when (activeSrc) {
            is ActiveSource.Personal -> personalList
            is ActiveSource.Collaboration -> collabList?.filterNot { it.deleted } ?: emptyList()
        }
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = emptyList()
    )

    val healthMetrics: StateFlow<HealthMetrics> = activeTodos.map { todosList ->
        calculateHealthMetrics(todosList, Instant.now(), ZoneId.systemDefault())
    }.flowOn(Dispatchers.Default)
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = HealthMetrics()
        )
    val isSyncing = repository.isSyncing
    val syncOutcome = kotlinx.coroutines.flow.combine(repository.syncOutcome, collabSyncState.outcome, activeSource) { personal, collaboration, source ->
        val target = syncTarget(source)
        val result = if (source is ActiveSource.Personal) personal else collaboration
        result.takeIf { it.target == target } ?: SyncOutcome(target = target)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SyncOutcome())

    private val _showSearchBar = MutableStateFlow(false)
    val showSearchBar: StateFlow<Boolean> = _showSearchBar.asStateFlow()

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    fun setSearchQuery(query: String) {
        _searchQuery.value = query
    }

    fun setShowSearchBar(show: Boolean) {
        _showSearchBar.value = show
        if (!show) {
            _searchQuery.value = ""
        }
    }

    init {
        // 启动时自动同步云端
        syncWithCloud()
    }

    fun learningReference(todo: Todo): com.todo.app.data.model.TaskReference {
        val source = activeSource.value
        return if (source is ActiveSource.Collaboration)
            com.todo.app.data.model.TaskReference(todo.id, "collaboration", source.collab.id)
        else com.todo.app.data.model.TaskReference(todo.id)
    }
    val learningViewData = kotlinx.coroutines.flow.combine(todoData, _collabSnapshot, activeSource) { personal, remote, source ->
        if (source is ActiveSource.Collaboration) learningViewData(
            remote?.takeIf { it.first == source.collab.id }?.second ?: TodoData(1, "", emptyList()), source.collab.id)
        else learningViewData(personal)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, learningViewData(TodoData(1, "", emptyList())))
    val learningTasks = learningViewData.map { it.tasks }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())

    private fun personalTarget(source: ActiveSource) = requirePersonalTarget(source is ActiveSource.Collaboration)
    private suspend fun <T> personalWrite(target: ActiveSource, write: suspend () -> T): T {
        personalTarget(target)
        // 已接受的个人写入归 ViewModel 管理，不随原按钮或弹窗离开而取消。
        return viewModelScope.async { write() }.await()
    }
    suspend fun startLearning(todo: Todo, target: ActiveSource = activeSource.value): Result<Unit> {
        if (target is ActiveSource.Collaboration) return Result.failure(IllegalStateException("协作清单仅允许查看和新增任务"))
        return personalWrite(target) { repository.startLearning(todo, com.todo.app.data.model.TaskReference(todo.id)) }
    }
    suspend fun stopLearning(id: String, target: ActiveSource = activeSource.value): Result<Unit> {
        if (target is ActiveSource.Collaboration) return Result.failure(IllegalStateException("协作清单仅允许查看和新增任务"))
        return personalWrite(target) { repository.stopLearning(id).map { _discardedShortTimers.value += it } }
    }
    suspend fun saveTimeEntry(entry: com.todo.app.data.model.TimeEntry, target: ActiveSource = activeSource.value): Result<Unit> {
        if (target is ActiveSource.Collaboration) return Result.failure(IllegalStateException("协作清单仅允许查看和新增任务"))
        return personalWrite(target) { repository.saveTimeEntry(entry) }
    }
    suspend fun saveDailyReview(review: com.todo.app.data.model.DailyReview, target: ActiveSource = activeSource.value): Result<Unit> {
        if (target is ActiveSource.Collaboration) return Result.failure(IllegalStateException("协作清单仅允许查看和新增任务"))
        return personalWrite(target) { repository.saveDailyReview(review) }
    }
    suspend fun saveEditedTodo(todo: Todo, target: ActiveSource = activeSource.value) {
        personalWrite(target) { repository.updateTodo(todo) }
    }
    fun toggleTodoStatus(id: String) {
        if (activeSource.value is ActiveSource.Collaboration) return
        viewModelScope.launch {
            try {
                repository.toggleTodoStatus(id)
            } catch (e: Exception) {
                _uiEvent.emit("切换状态失败: ${e.message}")
            }
        }
    }

    fun updateTodo(todo: Todo) {
        if (activeSource.value is ActiveSource.Collaboration) return
        viewModelScope.launch {
            try {
                repository.updateTodo(todo)
            } catch (e: Exception) {
                _uiEvent.emit("更新失败: ${e.message}")
            }
        }
    }

    fun batchUpdateTodos(todos: List<Todo>) {
        if (activeSource.value is ActiveSource.Collaboration) return
        viewModelScope.launch {
            try {
                repository.batchUpdateTodos(todos)
            } catch (e: Exception) {
                _uiEvent.emit("批量更新失败: ${e.message}")
            }
        }
    }

    fun deleteTodo(id: String) {
        if (activeSource.value is ActiveSource.Collaboration) return
        viewModelScope.launch {
            try {
                repository.deleteTodo(id)
            } catch (e: Exception) {
                _uiEvent.emit("删除失败: ${e.message}")
            }
        }
    }

    fun addTodoSmart(rawContent: String) {
        if (activeSource.value is ActiveSource.Collaboration) return
        if (rawContent.isBlank()) return

        val parsed = parseDateSyntax(rawContent)
        if (parsed.content.isBlank()) return

        val defaultPref = configManager.defaultDueDate
        val defaultInsertion = configManager.defaultInsertion

        viewModelScope.launch {
            try {
                val todo = Todo.createFromParsed(parsed, parsed.content, todos.value, defaultPref, defaultInsertion)
                repository.addTodo(todo)
            } catch (e: Exception) {
                _uiEvent.emit("添加失败: ${e.message}")
            }
        }
    }

    private val collaborationSubmitter = CollaborationSubmitter()
    val pendingCollaborationSubmissions = collaborationSubmitter.pending

    fun discardCollaborationSubmission(id: String) = collaborationSubmitter.discard(id)

    fun retryCollaborationSubmission(id: String) {
        viewModelScope.launch {
            try {
                val saved = collaborationSubmitter.send(id, { key -> collaborations.value.find { it.id == key } }) { source, todo ->
                    repository.writeCollaborationTodo(source, todo).getOrThrow()
                }
                if (saved) {
                    _uiEvent.emit("协作任务已保存")
                    (activeSource.value as? ActiveSource.Collaboration)?.collab?.takeIf { it.id == id }?.let(::loadCollabData)
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _uiEvent.emit("新增结果待确认，请重试同一次提交：${e.message}")
            }
        }
    }

    fun addCollabTodoSmart(collab: com.todo.app.data.model.CollaborationSource, rawContent: String) {
        if (rawContent.isBlank()) return
        if (pendingCollaborationSubmissions.value.any { it.sourceId == collab.id }) {
            viewModelScope.launch { _uiEvent.emit("请先重试或放弃待确认的新增") }; return
        }
        val parsed = parseDateSyntax(rawContent)
        if (parsed.content.isBlank()) return
        val nickname = configManager.nickname.ifBlank { "匿名" }
        val signedContent = "${parsed.content} (由 [$nickname] 添加)"
        val todo = Todo.createFromParsed(parsed, signedContent, _collabData.value ?: emptyList(),
            configManager.defaultDueDate, configManager.defaultInsertion)
        collaborationSubmitter.create(collab, todo)
        retryCollaborationSubmission(collab.id)
    }

    fun syncWithCloud() {
        viewModelScope.launch {
            try {
                repository.syncWithCloud(includeCollaborations = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _uiEvent.emit("同步失败: ${e.message}")
            }
        }
    }

    suspend fun generateShareCode(expireDays: Int?): Pair<String, String> {
        return repository.generateShareCode(expireDays)
    }

    fun importSelectedFromLastPeriod(type: String, selectedIds: List<String>) {
        if (activeSource.value is ActiveSource.Collaboration) return
        viewModelScope.launch {
            try {
                repository.importSelectedFromLastPeriod(type, selectedIds)
            } catch (e: Exception) {
                _uiEvent.emit("导入失败: ${e.message}")
            }
        }
    }

    fun importFromLastPeriod(type: String) {
        if (activeSource.value is ActiveSource.Collaboration) return
        viewModelScope.launch {
            try {
                repository.importFromLastPeriod(type)
            } catch (e: Exception) {
                _uiEvent.emit("导入失败: ${e.message}")
            }
        }
    }

    fun forcePullCloud() {
        viewModelScope.launch {
            try {
                repository.forcePullCloud()
            } catch (e: Exception) {
                _uiEvent.emit("强制拉取失败: ${e.message}")
            }
        }
    }

    fun resetWebDavClient() {
        repository.resetWebDavClient()
    }

    fun saveConfig(serverUrl: String, username: String, appPassword: String, filePath: String) {
        configManager.webDavUrl = serverUrl
        configManager.username = username
        configManager.appPassword = appPassword
        configManager.filePath = filePath
        repository.resetWebDavClient()
    }

    suspend fun listBackups(): List<String> {
        return repository.listBackups()
    }

    suspend fun restoreFromBackup(filename: String): Boolean {
        return repository.restoreFromBackup(filename)
    }
}

class TodoViewModelFactory(private val repository: TodoRepository, private val configManager: ConfigManager) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(TodoViewModel::class.java)) {
            @Suppress("UNCHECKED_CAST")
            return TodoViewModel(repository, configManager) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}
