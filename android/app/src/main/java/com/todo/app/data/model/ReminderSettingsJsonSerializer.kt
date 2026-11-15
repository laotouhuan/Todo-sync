package com.todo.app.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

@Serializable
private data class GlobalReminderRuleFields(
    val id: String, val time: String, val enabled: Boolean = true,
    val condition: String = "unconditional", val task_scope: String = "all",
    val title: String = "", val body: String = ""
)

@Serializable
private data class ReminderSettingsFields(
    val updated_at: String? = null, val enabled: Boolean = true,
    val privacy_mode: Boolean = false, val global_rules: List<GlobalReminderRule> = emptyList()
)

private fun reminderStringField(raw: JsonObject, key: String, nullable: Boolean = false) {
    if (key !in raw) return
    val value = raw.getValue(key)
    require(nullable && value == JsonNull || value is JsonPrimitive && value.isString) { "提醒字段 $key 必须为字符串${if (nullable) "或 null" else ""}" }
}

private fun reminderBooleanField(raw: JsonObject, key: String) {
    if (key !in raw) return
    val value = raw.getValue(key)
    require(value is JsonPrimitive && !value.isString && value.booleanOrNull != null) { "提醒字段 $key 必须为布尔值" }
}

// 未知字段保留在设置或规则的原位置，不生成额外的线上载体字段。
object GlobalReminderRuleJsonSerializer : KSerializer<GlobalReminderRule> {
    override val descriptor = GlobalReminderRuleFields.serializer().descriptor
    override fun deserialize(decoder: Decoder): GlobalReminderRule {
        val (value, extra) = readExtensibleJsonFields(decoder, GlobalReminderRuleFields.serializer()) { raw ->
            listOf("id", "time", "condition", "task_scope", "title", "body").forEach { reminderStringField(raw, it) }
            reminderBooleanField(raw, "enabled")
            raw
        }
        return with(value) { GlobalReminderRule(id, enabled, time, condition, task_scope, title, body, extra) }
    }
    override fun serialize(encoder: Encoder, value: GlobalReminderRule) = with(value) {
        writeExtensibleJsonFields(encoder, GlobalReminderRuleFields.serializer(),
            GlobalReminderRuleFields(id, time, enabled, condition, taskScope, title, body), extraFields)
    }
}

object ReminderSettingsJsonSerializer : KSerializer<ReminderSettings> {
    override val descriptor = ReminderSettingsFields.serializer().descriptor
    override fun deserialize(decoder: Decoder): ReminderSettings {
        val (value, extra) = readExtensibleJsonFields(decoder, ReminderSettingsFields.serializer()) { raw ->
            reminderStringField(raw, "updated_at", nullable = true)
            reminderBooleanField(raw, "enabled")
            reminderBooleanField(raw, "privacy_mode")
            require("global_rules" !in raw || raw["global_rules"] is JsonArray) { "提醒规则必须为数组" }
            raw
        }
        return with(value) { ReminderSettings(updated_at, enabled, privacy_mode, global_rules, extra) }
    }
    override fun serialize(encoder: Encoder, value: ReminderSettings) = with(value) {
        writeExtensibleJsonFields(encoder, ReminderSettingsFields.serializer(),
            ReminderSettingsFields(updatedAt, enabled, privacyMode, globalRules), extraFields)
    }
}
