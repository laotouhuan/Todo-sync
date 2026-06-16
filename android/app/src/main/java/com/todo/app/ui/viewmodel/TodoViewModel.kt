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
import kotlinx.coroutines.launch

class TodoViewModel(val repository: TodoRepository, val configManager: ConfigManager) : ViewModel() {
    
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
            repository.toggleTodoStatus(id)
        }
    }

    fun updateTodo(todo: Todo) {
        viewModelScope.launch {
            repository.updateTodo(todo)
        }
    }

    fun batchUpdateTodos(todos: List<Todo>) {
        viewModelScope.launch {
            repository.batchUpdateTodos(todos)
        }
    }

    fun deleteTodo(id: String) {
        viewModelScope.launch {
            repository.deleteTodo(id)
        }
    }

    fun addTodoSmart(rawContent: String) {
        if (rawContent.isBlank()) return

        val (content, taskDate) = parseDateSyntax(rawContent)

        if (content.isBlank()) return

        viewModelScope.launch {
            repository.addTodo(Todo.create(content, taskDate))
        }
    }

    fun syncWithCloud() {
        viewModelScope.launch {
            repository.syncWithCloud()
        }
    }

    fun forcePullCloud() {
        viewModelScope.launch {
            repository.forcePullCloud()
        }
    }

    fun listBackups(): List<String> {
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
