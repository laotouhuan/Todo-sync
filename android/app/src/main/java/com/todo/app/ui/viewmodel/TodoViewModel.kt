package com.todo.app.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.todo.app.data.ConfigManager
import com.todo.app.data.model.Todo
import com.todo.app.data.repository.TodoRepository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.WeekFields
import java.util.Locale
import java.util.UUID

class TodoViewModel(val repository: TodoRepository, val configManager: ConfigManager) : ViewModel() {
    
    val todos = repository.getTodoData().map { it.todos }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = emptyList()
    )

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

    fun deleteTodo(id: String) {
        viewModelScope.launch {
            repository.deleteTodo(id)
        }
    }

    fun addTodoSmart(rawContent: String) {
        if (rawContent.isBlank()) return
        
        var content = rawContent.trim()
        var importance = 2
        var urgency = 2
        var taskDate: String? = LocalDate.now().toString()

        val syntaxRegex = Regex("""(?:\s+|^)!([1-3])([1-3])?$""")
        val dateRegex = Regex("""(?:\s+|^)@(today|tomorrow|week|month|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$""", RegexOption.IGNORE_CASE)

        // 解析评分
        var match = syntaxRegex.find(content)
        if (match != null) {
            importance = match.groupValues[1].toInt()
            if (match.groupValues[2].isNotEmpty()) {
                urgency = match.groupValues[2].toInt()
            }
            content = content.removeRange(match.range).trim()
        }

        // 解析日期
        val dateMatch = dateRegex.find(content)
        if (dateMatch != null) {
            val dateVal = dateMatch.groupValues[1].lowercase()
            taskDate = when {
                dateVal == "today" -> LocalDate.now().toString()
                dateVal == "tomorrow" -> LocalDate.now().plusDays(1).toString()
                dateVal == "week" -> {
                    val date = LocalDate.now()
                    val week = date.get(WeekFields.of(Locale.getDefault()).weekOfYear())
                    "${date.year}-W${week.toString().padStart(2, '0')}"
                }
                dateVal == "month" -> {
                    val date = LocalDate.now()
                    "${date.year}-${date.monthValue.toString().padStart(2, '0')}"
                }
                dateVal.matches(Regex("""^\d{4}-\d{2}-\d{2}$""")) -> dateVal
                dateVal.matches(Regex("""^\d{2}-\d{2}$""")) -> "${LocalDate.now().year}-$dateVal"
                else -> taskDate
            }
            content = content.removeRange(dateMatch.range).trim()
        }

        // 再次尝试解析评分 (顺序颠倒情况)
        match = syntaxRegex.find(content)
        if (match != null) {
            importance = match.groupValues[1].toInt()
            if (match.groupValues[2].isNotEmpty()) {
                urgency = match.groupValues[2].toInt()
            }
            content = content.removeRange(match.range).trim()
        }

        if (content.isBlank()) return

        val newTodo = Todo(
            id = UUID.randomUUID().toString(),
            content = content,
            date = taskDate,
            time = null,
            importance = importance,
            urgency = urgency,
            completed = false,
            created_at = OffsetDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            recurring = "none",
            subtasks = emptyList()
        )

        viewModelScope.launch {
            repository.addTodo(newTodo)
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
