package com.todo.app.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonObject

@Serializable(with = GlobalReminderRuleJsonSerializer::class)
data class GlobalReminderRule(
    val id: String,
    val enabled: Boolean = true,
    val time: String,
    val condition: String = "unconditional",    // none_completed | any_remaining | unconditional
    @SerialName("task_scope") val taskScope: String = "all",   // all | today_only | recurring_only
    val title: String = "",
    val body: String = "",
    @Transient val extraFields: JsonObject = JsonObject(emptyMap())
)

@Serializable(with = ReminderSettingsJsonSerializer::class)
data class ReminderSettings(
    @SerialName("updated_at") val updatedAt: String? = null,
    val enabled: Boolean = true,
    @SerialName("privacy_mode") val privacyMode: Boolean = false,
    @SerialName("global_rules") val globalRules: List<GlobalReminderRule> = emptyList(),
    @Transient val extraFields: JsonObject = JsonObject(emptyMap())
)

@Serializable
data class TodoData(
    val version: Int,
    val last_updated: String,
    val todos: List<Todo>,
    @SerialName("reminder_settings") val reminderSettings: ReminderSettings = ReminderSettings(),
    @SerialName("time_entries") val timeEntries: List<TimeEntry> = emptyList(),
    @SerialName("daily_reviews") val dailyReviews: List<DailyReview> = emptyList(),
    @SerialName("task_series") val taskSeries: List<TaskSeries> = emptyList(),
    @SerialName("task_series_links") val taskSeriesLinks: List<TaskSeriesLink> = emptyList()
)
