package com.todo.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.UUID
import java.time.LocalDate

@Serializable
data class Subtask(
    val id: String,
    var content: String,
    var completed: Boolean,
    @SerialName("completed_at") var completedAt: String? = null
)

@Serializable
data class Reminder(
    @SerialName("reminder_date") val reminderDate: String? = null,
    @SerialName("reminder_time") val reminderTime: String,
    @SerialName("repeat_daily") val repeatDaily: Boolean = false
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
    var reminder: Reminder? = null,
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

        /**
         * 基于语法解析结果创建待办事项，统一处理默认截止日期偏好、插入位置权重及子任务列表。
         *
         * @param parsed 语法解析后的结果
         * @param content 待办内容（若传入签名文本则优先使用，默认取 parsed.content）
         * @param currentList 当前待办列表，用于根据插入偏好计算 order
         * @param defaultDueDatePref 默认截止日期偏好（"today" / "tomorrow" / "none"）
         * @param defaultInsertion 默认插入位置偏好（"top" / "bottom"）
         */
        fun createFromParsed(
            parsed: ParsedSyntax,
            content: String = parsed.content,
            currentList: List<Todo>,
            defaultDueDatePref: String = "none",
            defaultInsertion: String = "top"
        ): Todo {
            val finalDate = when {
                parsed.hasExplicitDateSyntax -> parsed.date
                parsed.taskType == TaskType.NORMAL -> when (defaultDueDatePref) {
                    "today" -> LocalDate.now().toString()
                    "tomorrow" -> LocalDate.now().plusDays(1).toString()
                    else -> null
                }
                else -> parsed.date
            }

            val activeTasks = currentList.filter { !it.deleted && !it.completed }
            val orderVal = if (defaultInsertion == "bottom") {
                (activeTasks.maxOfOrNull { it.order } ?: System.currentTimeMillis().toDouble()) + 1.0
            } else {
                (activeTasks.minOfOrNull { it.order } ?: System.currentTimeMillis().toDouble()) - 1.0
            }

            val subtaskList = parsed.subtasks.map {
                Subtask(
                    id = UUID.randomUUID().toString(),
                    content = it,
                    completed = false,
                    completedAt = null
                )
            }

            return create(content, finalDate).copy(
                taskType = parsed.taskType,
                targetCount = parsed.targetCount,
                recurring = if (parsed.taskType == "daily_repeat") "daily_repeat" else "none",
                order = orderVal,
                subtasks = subtaskList
            )
        }
    }
}
