package com.todo.app.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.text.Normalizer
import java.time.*

@Serializable
data class TaskReference(val todo_id: String, val source_type: String = "personal", val source_id: String? = null)

@Serializable
data class TimeEntry(
    val id: String, val task_ref: TaskReference, val started_at: String,
    val created_at: String, val updated_at: String,
    val task_content_snapshot: String = "", val label_snapshot: String? = null,
    val ended_at: String? = null, val deleted: Boolean = false
)

@Serializable
data class DailyReview(
    val id: String, val date: String, val created_at: String, val updated_at: String,
    val fact: String = "", val obstacle: String = "", val effective_action: String = "",
    val next_step: String = "", val deleted: Boolean = false
)

data class LearningPart(val date: LocalDate, val duration: Long, val entry: TimeEntry,
    val startedAt: Instant, val endedAt: Instant)
data class LearningGroup(val label: String, val duration: Long, val count: Int)
data class LearningSummary(val duration: Long, val count: Int, val parts: List<LearningPart>,
    val groups: List<LearningGroup>, val pending: Int, val running: Int)

object Learning {
    private val json = Json { encodeDefaults = true }
    fun label(value: String?): String? = value?.trim()?.let { Normalizer.normalize(it, Normalizer.Form.NFC) }
        ?.takeIf { it.isNotEmpty() && it != "未分类" }
    fun instant(value: String?): Instant? = runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
    fun availableLabels(todos: List<Todo>): List<String> = todos.filterNot { it.deleted }.mapNotNull { label(it.label) }.distinct().sorted()

    // 仅返回统计副本，原始快照不因任务标签变更而批量回写。
    fun resolveEntries(entries: List<TimeEntry>, tasks: Map<TaskReference, Todo>): List<TimeEntry> {
        val latest = entries.groupBy { it.task_ref }.mapValues { (_, records) ->
            records.maxWith(compareBy<TimeEntry> { instant(it.updated_at) ?: Instant.EPOCH }.thenBy { it.id })
        }
        return entries.map { e ->
            val todo = tasks[e.task_ref]
            e.copy(label_snapshot = label(if (todo != null) todo.label else latest[e.task_ref]?.label_snapshot))
        }
    }
    // 与 JavaScript 一致的 UTF-16 长度及排序，避免同时间戳合并方向影响结果。
    private fun canonical(value: JsonElement): String = when (value) {
        JsonNull -> "n"
        is JsonObject -> "o" + value.keys.sorted().joinToString("") { canonical(JsonPrimitive(it)) + canonical(value.getValue(it)) } + "e"
        is JsonArray -> "a" + value.joinToString("") { canonical(it) } + "e"
        is JsonPrimitive -> if (value.isString) "s${value.content.length}:${value.content}" else
            when (value.content) { "true" -> "b1"; "false" -> "b0"; else -> "d${value.content}" }
    }
    private fun <T> merge(a: List<T>, b: List<T>, key: (T) -> String, time: (T) -> String,
        deleted: (T) -> Boolean, content: (T) -> JsonElement): List<T> = (a + b).groupBy(key).toSortedMap().values.map { records ->
        records.maxWith(compareBy<T> { instant(time(it))?.toEpochMilli() ?: 0L }.thenBy { deleted(it) }.thenBy { canonical(content(it)) })
    }
    fun mergeTimes(a: List<TimeEntry>, b: List<TimeEntry> = emptyList()): List<TimeEntry> = merge(
        a.map { it.copy(label_snapshot = label(it.label_snapshot)) }, b.map { it.copy(label_snapshot = label(it.label_snapshot)) },
        { it.id }, { it.updated_at }, { it.deleted }, { json.encodeToJsonElement(it) })
    fun mergeReviews(a: List<DailyReview>, b: List<DailyReview> = emptyList()): List<DailyReview> =
        merge(a, b, { it.date }, { it.updated_at }, { it.deleted }, { json.encodeToJsonElement(it) })
    fun range(period: String, date: LocalDate): Pair<LocalDate, LocalDate> {
        val start = when (period) { "week" -> date.minusDays((date.dayOfWeek.value - 1).toLong()); "month" -> date.withDayOfMonth(1); else -> date }
        return start to when (period) { "week" -> start.plusDays(7); "month" -> start.plusMonths(1); else -> start.plusDays(1) }
    }
    fun split(entry: TimeEntry, zone: ZoneId = ZoneId.systemDefault()): List<LearningPart> {
        var cursor = instant(entry.started_at) ?: return emptyList()
        val end = instant(entry.ended_at) ?: return emptyList()
        if (entry.deleted || end <= cursor) return emptyList()
        val parts = mutableListOf<LearningPart>()
        while (cursor < end) {
            val date = cursor.atZone(zone).toLocalDate()
            val next = minOf(date.plusDays(1).atStartOfDay(zone).toInstant(), end)
            parts.add(LearningPart(date, Duration.between(cursor, next).toMillis(), entry, cursor, next)); cursor = next
        }
        return parts
    }
    fun overlaps(entries: List<TimeEntry>): Set<String> {
        val active = entries.filter { !it.deleted && instant(it.started_at) != null &&
            (it.ended_at == null || (instant(it.ended_at)?.isAfter(instant(it.started_at)) == true)) }
        val ids = mutableSetOf<String>()
        active.forEachIndexed { i, a -> active.drop(i + 1).forEach { b ->
            if (instant(a.started_at)!! < (instant(b.ended_at) ?: Instant.MAX) && instant(b.started_at)!! < (instant(a.ended_at) ?: Instant.MAX)) {
                ids.add(a.id); ids.add(b.id)
            }
        } }
        return ids
    }
    fun validate(entry: TimeEntry, entries: List<TimeEntry>, now: Instant = Instant.now()): String? {
        val start = instant(entry.started_at) ?: return "请输入有效的开始日期和时间"
        val end = instant(entry.ended_at)
        if (entry.ended_at != null && end == null) return "请输入有效的结束日期和时间"
        if (start > now || (end != null && end > now)) return "不能记录未来的学习时间"
        if (end != null && end <= start) return "结束时间必须晚于开始时间"
        if (overlaps(entries.filter { it.id != entry.id } + entry).contains(entry.id)) return "与其他计时记录重叠，请检查起止时间"
        return null
    }
    fun summary(entries: List<TimeEntry>, start: LocalDate, end: LocalDate, zone: ZoneId = ZoneId.systemDefault(),
        selectedLabel: String? = null): LearningSummary {
        val conflicts = overlaps(entries)
        val startTime = start.atStartOfDay(zone).toInstant()
        val endTime = end.atStartOfDay(zone).toInstant()
        val relevant = entries.filter { !it.deleted && instant(it.started_at)?.isBefore(endTime) == true &&
            (it.ended_at == null || instant(it.ended_at)?.isAfter(startTime) == true) }
        val parts = entries.filter { it.id !in conflicts }.flatMap { split(it, zone) }.filter {
            it.date >= start && it.date < end && (selectedLabel == null || (label(it.entry.label_snapshot) ?: "未分类") == selectedLabel) }
        return LearningSummary(parts.sumOf { it.duration }, parts.size, parts,
            parts.groupBy { label(it.entry.label_snapshot) ?: "未分类" }.map { (name, list) -> LearningGroup(name, list.sumOf { it.duration }, list.size) }.sortedByDescending { it.duration },
            relevant.count { it.id in conflicts }, relevant.count { it.ended_at == null })
    }
    fun duration(ms: Long, clock: Boolean = false): String {
        val sec = (ms / 1000).coerceAtLeast(0); val h = sec / 3600; val m = sec % 3600 / 60; val s = sec % 60
        if (clock) return listOf(h, m, s).joinToString(":") { it.toString().padStart(2, '0') }
        return listOfNotNull(if (h > 0) "$h 小时" else null, if (m > 0) "$m 分钟" else null, if (s > 0 || sec == 0L) "$s 秒" else null).joinToString(" ")
    }
    fun fields(review: DailyReview) = listOf("事实" to review.fact, "卡点" to review.obstacle, "有效动作" to review.effective_action, "下一步" to review.next_step)
    fun preview(review: DailyReview): String = fields(review).firstOrNull { it.second.isNotBlank() }?.let { "${it.first}：${it.second.lines().take(2).joinToString("\n")}" } ?: ""
    fun export(data: TodoData, period: String, date: LocalDate, includeLearning: Boolean = true, zone: ZoneId = ZoneId.systemDefault(),
        tasks: Map<TaskReference, Todo> = data.todos.associateBy { TaskReference(it.id) }): Pair<String, String> {
        val resolved = resolveEntries(data.timeEntries, tasks)
        val (start, end) = range(period, date)
        val reviews = data.dailyReviews.filter { !it.deleted && it.date >= start.toString() && it.date < end.toString() }
        val totals = summary(resolved, start, end, zone)
        val dates = (reviews.map { LocalDate.parse(it.date) } + if (includeLearning) totals.parts.map { it.date } else emptyList()).toSortedSet()
        require(dates.isNotEmpty()) { "这个时间范围没有可导出的内容" }
        val lines = mutableListOf("# 每日复盘", "")
        dates.forEach { day ->
            lines.addAll(listOf("## $day", ""))
            val review = reviews.find { it.date == day.toString() }
            if (review == null) lines.addAll(listOf("当日未填写复盘", "")) else fields(review).forEach { (title, value) -> lines.addAll(listOf("### $title", "", value.trim().ifEmpty { "未填写" }, "")) }
            if (includeLearning) {
                val summary = summary(resolved, day, day.plusDays(1), zone)
                lines.addAll(listOf("### 学习投入", "", "合计：${duration(summary.duration)}，${summary.count} 次。", "", "| 标签 | 时长 | 次数 |", "| --- | --- | --- |"))
                summary.groups.forEach { g -> lines.add("| ${g.label.replace("\\", "\\\\").replace("|", "\\|").replace(Regex("[\\r\\n]"), " ")} | ${duration(g.duration)} | ${g.count} |") }; lines.add("")
            }
        }
        if (includeLearning) {
            lines.add("统计时区：${zone.id}。次数按每天有效记录计数，跨日记录每天均计次。")
            if (totals.pending > 0) lines.add("有 ${totals.pending} 条待核对记录未计入。")
            if (totals.running > 0) lines.add("有 ${totals.running} 条进行中记录未计入。")
        }
        val name = when (period) { "month" -> start.toString().take(7); "week" -> "${start}_${end.minusDays(1)}"; else -> start.toString() }
        return "$name-复盘.md" to (lines.joinToString("\n") + "\n")
    }
}
