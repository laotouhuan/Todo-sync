package com.todo.app.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.*

// 仅代理既有字段；未知字段不能因模型版本不同而从胜出的整条任务中消失。
@Serializable
private data class TodoFields(
    val id: String, val content: String, val created_at: String,
    val date: String? = null, val time: String? = null, val completed: Boolean = false,
    val completed_at: String? = null, val order: Double = 0.0,
    val updated_at: String = created_at, val deleted: Boolean = false,
    val recurring: String = "none", val task_type: String = "normal",
    val completed_dates: List<String> = emptyList(), val target_count: Int? = null,
    val reminder: Reminder? = null, val subtasks: List<Subtask> = emptyList(), val label: String? = null
)

@Serializable
private data class SubtaskFields(val id: String, val content: String, val completed: Boolean = false, val completed_at: String? = null)

@Serializable
private data class ReminderFields(val reminder_time: String, val reminder_date: String? = null, val repeat_daily: Boolean = false)

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private fun keys(descriptor: SerialDescriptor): Set<String> =
    (0 until descriptor.elementsCount).map { descriptor.getElementName(it) }.toSet()

internal fun <T> readExtensibleJsonFields(decoder: Decoder, serializer: KSerializer<T>, prepare: (JsonObject) -> JsonObject = { it }): Pair<T, JsonObject> {
    val input = decoder as? JsonDecoder ?: error("共享数据仅支持 JSON 序列化")
    val raw = input.decodeJsonElement().jsonObject
    val known = keys(serializer.descriptor)
    val value = input.json.decodeFromJsonElement(serializer, JsonObject(prepare(raw).filterKeys { it in known }))
    return value to JsonObject(raw.filterKeys { it !in known })
}

internal fun <T> writeExtensibleJsonFields(encoder: Encoder, serializer: KSerializer<T>, value: T, extra: JsonObject) {
    val output = encoder as? JsonEncoder ?: error("共享数据仅支持 JSON 序列化")
    val known = keys(serializer.descriptor)
    // 即使调用方不输出默认值，扩展字段也不能伪装成已知字段覆盖它。
    output.encodeJsonElement(JsonObject(extra.filterKeys { it !in known } + output.json.encodeToJsonElement(serializer, value).jsonObject))
}

object TodoJsonSerializer : KSerializer<Todo> {
    override val descriptor = TodoFields.serializer().descriptor
    override fun deserialize(decoder: Decoder): Todo {
        val (v, extra) = readExtensibleJsonFields(decoder, TodoFields.serializer()) { raw ->
            JsonObject(raw.toMutableMap().apply {
                val type = (this["task_type"] as? JsonPrimitive)?.content ?: TaskType.NORMAL
                val recurring = (this["recurring"] as? JsonPrimitive)?.content
                val date = (this["date"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                val normal = (type.isEmpty() || type == TaskType.NORMAL) && recurring !in setOf("weekly", "monthly") &&
                    (date == null || (!isWeekDate(date) && !isMonthDate(date)))
                if (normal && (this["updated_at"] == JsonNull || (this["updated_at"] as? JsonPrimitive)?.content == "")) remove("updated_at")
                if (normal && "label" in this && (this["label"] as? JsonPrimitive)?.isString != true) this["label"] = JsonNull
                if (normal && "target_count" in this) {
                    val primitive = this["target_count"] as? JsonPrimitive
                    val target = primitive?.takeUnless { it.isString }?.doubleOrNull
                    this["target_count"] = if (target == null || !target.isFinite() || target <= 0 || target % 1.0 != 0.0 || target > 9007199254740991.0) JsonNull
                    else {
                        require(target <= Int.MAX_VALUE) { "目标次数超出 Android 模型范围" }
                        JsonPrimitive(target.toInt())
                    }
                }
            })
        }
        return Todo(v.id, v.content, v.date, v.time, v.completed, v.created_at, v.completed_at, v.order,
            v.updated_at, v.deleted, v.recurring, v.task_type, v.completed_dates, v.target_count, v.reminder, v.subtasks, v.label, extra)
    }
    override fun serialize(encoder: Encoder, value: Todo) = with(value) {
        writeExtensibleJsonFields(encoder, TodoFields.serializer(), TodoFields(id, content, createdAt, date, time, completed,
            completedAt, order, updatedAt, deleted, recurring, taskType, completedDates, targetCount, reminder, subtasks, label), extraFields)
    }
}

object SubtaskJsonSerializer : KSerializer<Subtask> {
    override val descriptor = SubtaskFields.serializer().descriptor
    override fun deserialize(decoder: Decoder): Subtask {
        val (v, extra) = readExtensibleJsonFields(decoder, SubtaskFields.serializer())
        return Subtask(v.id, v.content, v.completed, v.completed_at, extra)
    }
    override fun serialize(encoder: Encoder, value: Subtask) = with(value) {
        writeExtensibleJsonFields(encoder, SubtaskFields.serializer(), SubtaskFields(id, content, completed, completedAt), extraFields)
    }
}

object ReminderJsonSerializer : KSerializer<Reminder> {
    override val descriptor = ReminderFields.serializer().descriptor
    override fun deserialize(decoder: Decoder): Reminder {
        val (v, extra) = readExtensibleJsonFields(decoder, ReminderFields.serializer())
        return Reminder(v.reminder_date, v.reminder_time, v.repeat_daily, extra)
    }
    override fun serialize(encoder: Encoder, value: Reminder) = with(value) {
        writeExtensibleJsonFields(encoder, ReminderFields.serializer(), ReminderFields(reminderTime, reminderDate, repeatDaily), extraFields)
    }
}
