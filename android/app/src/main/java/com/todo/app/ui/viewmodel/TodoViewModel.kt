package com.todo.app.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.todo.app.data.ConfigManager
import com.todo.app.data.model.Todo
import com.todo.app.data.model.parseDateSyntax
import com.todo.app.data.repository.TodoRepository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

import java.util.UUID
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.IsoFields
import com.todo.app.data.model.calcTaskAgeDays
import com.todo.app.data.model.TaskType
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Dispatchers

data class HealthMetrics(
    val currentAvgCompletedLife: Double = 0.0,
    val currentAvgBacklogLife: Double = 0.0,
    val baselineAvgCompletedLife: Double = 0.0,
    val baselineAvgBacklogLife: Double = 0.0,
    val baselineSleepingCountVal: Int = 0
)

class TodoViewModel(private val repository: TodoRepository, val configManager: ConfigManager) : ViewModel() {

    sealed class ActiveSource {
        object Personal : ActiveSource()
        data class Collaboration(val collab: com.todo.app.data.model.CollaborationSource) : ActiveSource()
    }

    private val _activeSource = MutableStateFlow<ActiveSource>(ActiveSource.Personal)
    val activeSource: StateFlow<ActiveSource> = _activeSource.asStateFlow()

    val collaborations: StateFlow<List<com.todo.app.data.model.CollaborationSource>> = repository.collaborations

    fun importCollaboration(code: String, key: String, name: String) {
        viewModelScope.launch {
            val res = repository.importCollaboration(code, key, name)
            if (res.isFailure) {
                _uiEvent.emit("导入失败: ${res.exceptionOrNull()?.message ?: "未知错误"}")
            } else {
                _uiEvent.emit("协作清单导入成功")
            }
        }
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

    private val _collabData = MutableStateFlow<List<Todo>?>(null)
    val collabData: StateFlow<List<Todo>?> = _collabData.asStateFlow()

    private val _collabLoading = MutableStateFlow(false)
    val collabLoading: StateFlow<Boolean> = _collabLoading.asStateFlow()

    private val _collabError = MutableStateFlow<String?>(null)
    val collabError: StateFlow<String?> = _collabError.asStateFlow()

    fun switchToPersonal() {
        _activeSource.value = ActiveSource.Personal
        _collabData.value = null
        _collabError.value = null
    }

    fun switchToCollaboration(collab: com.todo.app.data.model.CollaborationSource) {
        _activeSource.value = ActiveSource.Collaboration(collab)
        loadCollabData(collab)
    }

    fun loadCollabData(collab: com.todo.app.data.model.CollaborationSource) {
        viewModelScope.launch {
            _collabLoading.value = true
            _collabError.value = null
            val result = repository.readCollaborationTodos(collab)
            if (result.isSuccess) {
                _collabData.value = result.getOrNull()?.todos?.filter { !it.deleted }
            } else {
                _collabData.value = null
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
            is ActiveSource.Collaboration -> collabList ?: emptyList()
        }
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = emptyList()
    )

    val healthMetrics: StateFlow<HealthMetrics> = activeTodos.map { todosList ->
        val activeList = todosList.filter { 
            !it.deleted && 
            it.taskType != TaskType.WEEKLY_CHECKIN && 
            it.taskType != TaskType.MONTHLY_CHECKIN &&
            it.recurring != "daily_repeat"
        }
        val incompleteTodos = activeList.filter { !it.completed }
        val completedTodos = activeList.filter { it.completed && !it.completedAt.isNullOrEmpty() }
        
        val nowTime = OffsetDateTime.now()
        val localTodayStart = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toOffsetDateTime()

        fun parseOffsetDateTimeSafe(dtStr: String?, defaultVal: OffsetDateTime): OffsetDateTime {
            if (dtStr.isNullOrEmpty()) return defaultVal
            return try {
                OffsetDateTime.parse(dtStr)
            } catch (_: Exception) {
                try {
                    OffsetDateTime.ofInstant(java.time.Instant.parse(dtStr), ZoneId.systemDefault())
                } catch (_: Exception) {
                    try {
                        LocalDate.parse(dtStr.take(10)).atStartOfDay(ZoneId.systemDefault()).toOffsetDateTime()
                    } catch (_: Exception) {
                        defaultVal
                    }
                }
            }
        }

        val currentAvgCompletedLife = if (completedTodos.isEmpty()) 0.0 else {
            completedTodos.map { t ->
                calcTaskAgeDays(t.createdAt, parseOffsetDateTimeSafe(t.completedAt, nowTime))
            }.average()
        }

        val currentAvgBacklogLife = if (incompleteTodos.isEmpty()) 0.0 else {
            val total = incompleteTodos.sumOf { calcTaskAgeDays(it.createdAt, nowTime).toDouble() }
            total / incompleteTodos.size
        }

        var baselineCompletedSum = 0.0
        var baselineCompletedCount = 0
        var baselineIncompleteSum = 0.0
        var baselineIncompleteCount = 0
        var baselineSleepingCount = 0

        activeList.forEach { t ->
            val createdTime = parseOffsetDateTimeSafe(t.createdAt, nowTime)
            if (createdTime.isBefore(localTodayStart)) {
                val completedTime = if (t.completed && !t.completedAt.isNullOrEmpty()) {
                    parseOffsetDateTimeSafe(t.completedAt, nowTime)
                } else null

                val wasCompletedBeforeToday = t.completed && (completedTime == null || completedTime.isBefore(localTodayStart))

                if (wasCompletedBeforeToday) {
                    if (completedTime != null) {
                        val age = calcTaskAgeDays(t.createdAt, completedTime).toDouble()
                        if (age >= 0) {
                            baselineCompletedSum += age
                            baselineCompletedCount++
                        }
                    }
                } else {
                    val age = calcTaskAgeDays(t.createdAt, localTodayStart).toDouble()
                    if (age >= 0) {
                        baselineIncompleteSum += age
                        baselineIncompleteCount++
                        if (age >= 7) {
                            baselineSleepingCount++
                        }
                    }
                }
            }
        }

        val baseAvgCompleted = if (baselineCompletedCount == 0) currentAvgCompletedLife else baselineCompletedSum / baselineCompletedCount
        val baseAvgBacklog = if (baselineIncompleteCount == 0) currentAvgBacklogLife else baselineIncompleteSum / baselineIncompleteCount

        HealthMetrics(
            currentAvgCompletedLife = currentAvgCompletedLife,
            currentAvgBacklogLife = currentAvgBacklogLife,
            baselineAvgCompletedLife = baseAvgCompleted,
            baselineAvgBacklogLife = baseAvgBacklog,
            baselineSleepingCountVal = baselineSleepingCount
        )
    }.flowOn(Dispatchers.Default)
    .stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = HealthMetrics()
    )

    val isSyncing = repository.isSyncing

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

    fun toggleTodoStatus(id: String) {
        viewModelScope.launch {
            try {
                repository.toggleTodoStatus(id)
            } catch (e: Exception) {
                _uiEvent.emit("切换状态失败: ${e.message}")
            }
        }
    }

    fun updateTodo(todo: Todo) {
        viewModelScope.launch {
            try {
                repository.updateTodo(todo)
            } catch (e: Exception) {
                _uiEvent.emit("更新失败: ${e.message}")
            }
        }
    }

    fun batchUpdateTodos(todos: List<Todo>) {
        viewModelScope.launch {
            try {
                repository.batchUpdateTodos(todos)
            } catch (e: Exception) {
                _uiEvent.emit("批量更新失败: ${e.message}")
            }
        }
    }

    fun deleteTodo(id: String) {
        viewModelScope.launch {
            try {
                repository.deleteTodo(id)
            } catch (e: Exception) {
                _uiEvent.emit("删除失败: ${e.message}")
            }
        }
    }

    private fun buildBaseTodo(
        parsed: com.todo.app.data.model.ParsedSyntax,
        content: String,
        currentList: List<Todo>,
        defaultDueDatePref: String,
        defaultInsertion: String
    ): Todo {
        val finalDate = when {
            parsed.hasExplicitDateSyntax -> parsed.date
            parsed.taskType == com.todo.app.data.model.TaskType.NORMAL -> when (defaultDueDatePref) {
                "today" -> LocalDate.now().toString()
                "tomorrow" -> LocalDate.now().plusDays(1).toString()
                else -> null
            }
            else -> parsed.date
        }

        val activeTasks = currentList.filter { !it.completed }
        val orderVal = if (defaultInsertion == "bottom") {
            (activeTasks.maxOfOrNull { it.order } ?: System.currentTimeMillis().toDouble()) + 1.0
        } else {
            (activeTasks.minOfOrNull { it.order } ?: System.currentTimeMillis().toDouble()) - 1.0
        }

        val subtaskList = parsed.subtasks.map {
            com.todo.app.data.model.Subtask(
                id = UUID.randomUUID().toString(),
                content = it,
                completed = false,
                completedAt = null
            )
        }

        return Todo.create(content, finalDate).copy(
            taskType = parsed.taskType,
            targetCount = parsed.targetCount,
            recurring = if (parsed.taskType == "daily_repeat") "daily_repeat" else "none",
            order = orderVal,
            subtasks = subtaskList
        )
    }

    fun addTodoSmart(rawContent: String) {
        if (rawContent.isBlank()) return

        val parsed = parseDateSyntax(rawContent)
        if (parsed.content.isBlank()) return

        val defaultPref = configManager.defaultDueDate
        val defaultInsertion = configManager.defaultInsertion

        viewModelScope.launch {
            try {
                val todo = buildBaseTodo(parsed, parsed.content, todos.value, defaultPref, defaultInsertion)
                repository.addTodo(todo)
            } catch (e: Exception) {
                _uiEvent.emit("添加失败: ${e.message}")
            }
        }
    }

    fun addCollabTodoSmart(collab: com.todo.app.data.model.CollaborationSource, rawContent: String) {
        if (rawContent.isBlank()) return
        val parsed = parseDateSyntax(rawContent)
        if (parsed.content.isBlank()) return

        val nickname = configManager.nickname.ifBlank { "匿名" }
        val signedContent = "${parsed.content} (由 [$nickname] 添加)"
        
        val defaultPref = configManager.defaultDueDate
        val defaultInsertion = configManager.defaultInsertion

        viewModelScope.launch {
            try {
                val currentList = _collabData.value ?: emptyList()
                val todo = buildBaseTodo(parsed, signedContent, currentList, defaultPref, defaultInsertion)
                
                val res = repository.writeCollaborationTodo(collab, todo)
                if (res.isSuccess) {
                    loadCollabData(collab)
                } else {
                    _uiEvent.emit("协作写入失败: ${res.exceptionOrNull()?.message}")
                }
            } catch (e: Exception) {
                _uiEvent.emit("协作写入失败: ${e.message}")
            }
        }
    }

    fun syncWithCloud() {
        viewModelScope.launch {
            try {
                repository.syncWithCloud()
                repository.syncCollaborations()
            } catch (e: Exception) {
                _uiEvent.emit("同步失败: ${e.message}")
            }
        }
    }

    fun generateShareCode(expireDays: Int?): Pair<String, String> {
        return repository.generateShareCode(expireDays)
    }

    fun importSelectedFromLastPeriod(type: String, selectedIds: List<String>) {
        viewModelScope.launch {
            try {
                repository.importSelectedFromLastPeriod(type, selectedIds)
            } catch (e: Exception) {
                _uiEvent.emit("导入失败: ${e.message}")
            }
        }
    }

    fun importFromLastPeriod(type: String) {
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