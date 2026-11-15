package com.todo.app.data.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

/** 提醒配置仍整份选择，独立时钟、旧非空规则和文件时钟优先于内容平局。 */
internal object ReminderSettingsConflict {
    private val json = Json { encodeDefaults = true }

    fun normalize(settings: ReminderSettings): ReminderSettings {
        // 坏时钟作为无效时间保留；有限 JSON 和 Unicode 仍须在单侧加载时检查。
        NormalTodoConflict.validateJson(json.encodeToJsonElement(ReminderSettings.serializer(), settings))
        return settings
    }

    fun choose(local: TodoData, cloud: TodoData): ReminderSettings {
        val left = normalize(local.reminderSettings)
        val right = normalize(cloud.reminderSettings)
        val leftTime = clock(left.updatedAt)
        val rightTime = clock(right.updatedAt)
        if (leftTime != null || rightTime != null) {
            val time = compareClocks(leftTime, rightTime)
            if (time != 0) return if (time > 0) left else right
        } else {
            val leftRules = left.globalRules.isNotEmpty()
            val rightRules = right.globalRules.isNotEmpty()
            if (leftRules != rightRules) return if (leftRules) left else right
            val fileTime = compareClocks(clock(local.last_updated), clock(cloud.last_updated))
            if (fileTime != 0) return if (fileTime > 0) left else right
        }
        val l = json.encodeToJsonElement(ReminderSettings.serializer(), left).jsonObject
        val r = json.encodeToJsonElement(ReminderSettings.serializer(), right).jsonObject
        val business = NormalTodoConflict.businessKey(JsonObject(l.filterKeys { it != "updated_at" }))
            .compareTo(NormalTodoConflict.businessKey(JsonObject(r.filterKeys { it != "updated_at" })))
        if (business != 0) return if (business > 0) left else right
        return if (NormalTodoConflict.canonicalDigest(l) >= NormalTodoConflict.canonicalDigest(r)) left else right
    }

    private fun clock(value: String?): Long? = value?.let {
        runCatching { NormalTodoConflict.timestampMillis(it) }.getOrNull()
    }

    private fun compareClocks(left: Long?, right: Long?): Int = when {
        left == null && right == null -> 0
        left == null -> -1
        right == null -> 1
        else -> left.compareTo(right)
    }
}
