package com.todo.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class GlobalReminderRule(
    val id: String,
    val enabled: Boolean = true,
    val time: String,
    val condition: String = "unconditional",    // none_completed | any_remaining | unconditional
    @SerialName("task_scope") val taskScope: String = "all",   // all | today_only | recurring_only
    val title: String = "",
    val body: String = ""
)

@Serializable
data class ReminderSettings(
    @SerialName("privacy_mode") val privacyMode: Boolean = false,
    @SerialName("global_rules") val globalRules: List<GlobalReminderRule> = emptyList()
)

@Serializable
data class TodoData(
    val version: Int,
    val last_updated: String,
    val todos: List<Todo>,
    @SerialName("reminder_settings") val reminderSettings: ReminderSettings = ReminderSettings()
)
