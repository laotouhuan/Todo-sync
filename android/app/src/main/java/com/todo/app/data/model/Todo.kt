package com.todo.app.data.model

import kotlinx.serialization.Serializable

@Serializable
data class Subtask(
    val id: String,
    var content: String,
    var completed: Boolean
)

@Serializable
data class Todo(
    val id: String,
    var content: String,
    var date: String?,
    var time: String?,
    var importance: Int,
    var urgency: Int,
    var completed: Boolean,
    val created_at: String,
    var updated_at: String = created_at,
    var deleted: Boolean = false,
    var recurring: String = "none", // none, daily, weekly, monthly
    var subtasks: List<Subtask> = emptyList()
)
