package com.todo.app.data.model

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

fun appendCollaborationTodo(data: TodoData, todo: Todo, updatedAt: String): TodoData = data.copy(
    todos = if (data.todos.any { it.id == todo.id }) data.todos else data.todos + todo,
    last_updated = updatedAt
)

data class CollaborationSubmission(val sourceId: String, val name: String, val target: List<String>,
    val todo: Todo, val sending: Boolean = false)

// 只保留本次进程内的待确认提交，不保存凭据；重试读取原源的当前凭据。
class CollaborationSubmitter {
    private val state = MutableStateFlow<List<CollaborationSubmission>>(emptyList())
    val pending = state.asStateFlow()
    private fun target(source: CollaborationSource) = listOf(source.id, source.webdavUrl, source.webdavUsername, source.webdavFilepath)

    fun create(source: CollaborationSource, todo: Todo) {
        check(state.value.none { it.sourceId == source.id }) { "此清单还有待确认的新增，请先重试或放弃" }
        val frozen = todo.copy(subtasks = todo.subtasks.map { it.copy() }, completedDates = todo.completedDates.toList())
        state.value += CollaborationSubmission(source.id, source.name, target(source), frozen)
    }

    suspend fun send(id: String, resolve: (String) -> CollaborationSource?,
        write: suspend (CollaborationSource, Todo) -> Unit): Boolean {
        val submission = state.value.find { it.sourceId == id } ?: return false
        if (submission.sending) return false
        val source = resolve(id)
        check(source != null && !source.deleted && target(source) == submission.target) { "原目标已移除或改变，请停止重试" }
        state.value = state.value.map { if (it.sourceId == id) it.copy(sending = true) else it }
        try {
            write(source, submission.todo)
        } catch (error: Exception) {
            state.value = state.value.map { if (it.sourceId == id) it.copy(sending = false) else it }
            throw error
        }
        state.value = state.value.filterNot { it.sourceId == id }
        return true
    }

    fun discard(id: String) { state.value = state.value.filterNot { it.sourceId == id && !it.sending } }
}
