package com.todo.app.data.model

import kotlinx.serialization.Serializable
import java.util.UUID

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
    var date: String? = null,
    var time: String? = null,
    var completed: Boolean = false,
    val created_at: String,
    var completed_at: String? = null,
    var order: Double = 0.0,
    var updated_at: String = created_at,
    var deleted: Boolean = false,
    var recurring: String = "none", // none, daily, weekly, monthly
    var subtasks: List<Subtask> = emptyList()
) {
    companion object {
        /**
         * 创建新的待办事项，自动生成 id、时间戳和默认值。
         * @param content 待办内容
         * @param date 可选的截止日期
         */
        fun create(content: String, date: String? = null): Todo {
            val now = nowIso()
            return Todo(
                id = UUID.randomUUID().toString(),
                content = content,
                date = date,
                time = null,
                completed = false,
                created_at = now,
                completed_at = null,
                order = System.currentTimeMillis().toDouble(),
                updated_at = now,
                deleted = false,
                recurring = "none",
                subtasks = emptyList()
            )
        }
    }
}
