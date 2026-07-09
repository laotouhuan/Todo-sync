package com.todo.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable
data class Subtask(
    val id: String,
    var content: String,
    var completed: Boolean,
    @SerialName("completed_at") var completedAt: String? = null
)

@Serializable
data class Todo(
    val id: String,
    var content: String,
    var date: String? = null,
    var time: String? = null,
    var completed: Boolean = false,
    @SerialName("created_at") val createdAt: String,
    @SerialName("completed_at") var completedAt: String? = null,
    var order: Double = 0.0,
    @SerialName("updated_at") var updatedAt: String = createdAt,
    var deleted: Boolean = false,
    var recurring: String = "none", // none, daily_repeat
    @SerialName("task_type") var taskType: String = "normal", // normal, weekly_checkin, monthly_checkin
    @SerialName("completed_dates") var completedDates: List<String> = emptyList(),
    @SerialName("target_count") var targetCount: Int? = null,
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
                createdAt = now,
                order = System.currentTimeMillis().toDouble(),
                updatedAt = now
            )
        }
    }
}
