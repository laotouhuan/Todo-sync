package com.todo.app.data.model

import kotlinx.serialization.Serializable

@Serializable
data class TodoData(
    val version: Int,
    val last_updated: String,
    val todos: List<Todo>
)
