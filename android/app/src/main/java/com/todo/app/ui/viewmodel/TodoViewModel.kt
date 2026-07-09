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

class TodoViewModel(private val repository: TodoRepository, val configManager: ConfigManager) : ViewModel() {

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

    val isSyncing = repository.isSyncing

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

    fun addTodoSmart(rawContent: String) {
        if (rawContent.isBlank()) return

        val parsed = parseDateSyntax(rawContent)

        if (parsed.content.isBlank()) return

        viewModelScope.launch {
            try {
                val currentList = todos.value
                val minOrder = currentList.filter { !it.completed }.minOfOrNull { it.order } ?: System.currentTimeMillis().toDouble()
                val todo = Todo.create(parsed.content, parsed.date).copy(
                    taskType = parsed.taskType,
                    targetCount = parsed.targetCount,
                    recurring = if (parsed.taskType == "daily_repeat") "daily_repeat" else "none",
                    order = minOrder - 1.0
                )
                repository.addTodo(todo)
            } catch (e: Exception) {
                _uiEvent.emit("添加失败: ${e.message}")
            }
        }
    }

    fun syncWithCloud() {
        viewModelScope.launch {
            try {
                repository.syncWithCloud()
            } catch (e: Exception) {
                _uiEvent.emit("同步失败: ${e.message}")
            }
        }
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