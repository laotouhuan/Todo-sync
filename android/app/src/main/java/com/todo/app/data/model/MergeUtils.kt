package com.todo.app.data.model

import java.time.OffsetDateTime

/**
 * 数据合并与迁移工具类。
 * 从 TodoRepository 中提取，便于单元测试。
 */
object MergeUtils {

    /**
     * 迁移旧格式的 Todo，将废弃的 recurring 值转换为 taskType。
     * 例如 recurring="weekly" → taskType="weekly_checkin"
     */
    fun migrateTodo(todo: Todo): Todo {
        var recurring = todo.recurring
        var taskType = todo.taskType

        when (recurring) {
            "daily" -> {
                recurring = RecurringType.DAILY_REPEAT
                if (taskType.isEmpty() || taskType == TaskType.NORMAL) taskType = TaskType.NORMAL
            }
            "weekly" -> {
                recurring = RecurringType.NONE
                taskType = TaskType.WEEKLY_CHECKIN
            }
            "monthly" -> {
                recurring = RecurringType.NONE
                taskType = TaskType.MONTHLY_CHECKIN
            }
        }

        val dateStr = todo.date
        if (dateStr != null) {
            when {
                isWeekDate(dateStr) -> taskType = TaskType.WEEKLY_CHECKIN
                isMonthDate(dateStr) -> taskType = TaskType.MONTHLY_CHECKIN
            }
        }

        val completedDates = todo.completedDates ?: emptyList()

        return todo.copy(
            recurring = recurring,
            taskType = taskType.ifEmpty { TaskType.NORMAL },
            completedDates = completedDates,
            targetCount = todo.targetCount
        )
    }

    /**
     * 规范化数据：迁移旧格式、去重复ID、去重复打卡日期。
     */
    fun normalizeData(data: TodoData): TodoData {
        TaskSeriesLogic.validate(data)
        val migratedTodos = data.todos.map { migrateTodo(it) }.map {
            when {
                it.taskType == TaskType.NORMAL -> NormalTodoConflict.normalize(it)
                NormalTodoConflict.isPeriod(it) -> NormalTodoConflict.validatePeriodCandidate(
                    it.copy(completedDates = deduplicateDates(it.completedDates), label = NormalTodoConflict.normalizeLabel(it.label)))
                else -> it
            }
        }

        // 去重复 ID（保留 updatedAt 最新的）
        val uniqueTodos = migratedTodos.groupBy { it.id }
            .map { (_, list) ->
                when {
                    list.all { it.taskType == TaskType.NORMAL } -> list.reduce(NormalTodoConflict::choose)
                    list.all(NormalTodoConflict::isPeriod) -> list.reduce(NormalTodoConflict::choosePeriodBase)
                    else -> list.maxByOrNull {
                        runCatching { OffsetDateTime.parse(it.updatedAt) }.getOrDefault(OffsetDateTime.MIN)
                    } ?: list.first()
                }
            }

        // 去重复 completedDates
        val deduplicatedTodos = uniqueTodos.map { todo ->
            if (todo.taskType == TaskType.NORMAL) return@map todo
            val deduped = deduplicateDates(todo.completedDates)
            if (deduped != todo.completedDates) {
                todo.copy(completedDates = deduped)
            } else {
                todo
            }
        }

        return data.copy(reminderSettings = ReminderSettingsConflict.normalize(data.reminderSettings), todos = deduplicatedTodos.map {
            if (it.taskType == TaskType.NORMAL || NormalTodoConflict.isPeriod(it)) it else it.copy(label = Learning.label(it.label))
        }, timeEntries = Learning.mergeTimes(data.timeEntries), dailyReviews = Learning.mergeReviews(data.dailyReviews))
    }

    private fun deduplicateDates(dates: List<String>): List<String> {
        return dates.groupBy { it.substringBefore('T') }
            .map { (_, group) ->
                group.reduce(::chooseCheckinDate)
            }
            .sorted()
    }

    /**
     * 合并本地和云端数据。
     * 普通待办选择整条版本；周/月任务继续使用独立的打卡冲突规则。
     */
    fun mergeTodoData(local: TodoData, cloud: TodoData): TodoData {
        val localTodos = normalizeData(local).todos.associateBy { it.id }
        val cloudTodos = normalizeData(cloud).todos.associateBy { it.id }
        val merged = mutableMapOf<String, Todo>()
        for (id in localTodos.keys + cloudTodos.keys) {
            val l = localTodos[id]
            val c = cloudTodos[id]
            if (l != null && c != null) {
                if (l.taskType == TaskType.NORMAL && c.taskType == TaskType.NORMAL) {
                    merged[id] = NormalTodoConflict.choose(l, c)
                    continue
                }
                val lTime = try { OffsetDateTime.parse(l.updatedAt) } catch (_: Exception) { OffsetDateTime.MIN }
                val cTime = try { OffsetDateTime.parse(c.updatedAt) } catch (_: Exception) { OffsetDateTime.MIN }
                val base = if (NormalTodoConflict.isPeriod(l) && NormalTodoConflict.isPeriod(c)) {
                    NormalTodoConflict.choosePeriodBase(l, c)
                } else if (cTime.isAfter(lTime)) c else l

                // completedDates 智能合并：支持销卡（删除打卡）同步与离线补卡合并
                val mergedDates = mergeCompletedDates(l.completedDates, c.completedDates, l.updatedAt, c.updatedAt)
                var updatedTodo = base.copy(completedDates = mergedDates)
                if (mergedDates != base.completedDates) {
                    updatedTodo = updatedTodo.copy(updatedAt = nowIso())
                }

                // 重新计算周/月打卡任务完成状态
                if (updatedTodo.taskType == TaskType.WEEKLY_CHECKIN || updatedTodo.taskType == TaskType.MONTHLY_CHECKIN) {
                    val completedCount = if (updatedTodo.taskType == TaskType.WEEKLY_CHECKIN) {
                        updatedTodo.getWeeklyCompletedCount()
                    } else {
                        updatedTodo.getMonthlyCompletedCount()
                    }
                    val shouldBeCompleted = updatedTodo.targetCount != null && completedCount >= updatedTodo.targetCount!!
                    if (updatedTodo.completed != shouldBeCompleted) {
                        updatedTodo = updatedTodo.copy(
                            completed = shouldBeCompleted,
                            completedAt = if (shouldBeCompleted) (updatedTodo.completedAt ?: nowIso()) else null,
                            updatedAt = nowIso()
                        )
                    }
                }
                merged[id] = updatedTodo
            } else if (l != null) {
                merged[id] = l
            } else if (c != null) {
                merged[id] = c
            }
        }
        val mergedSettings = mergeReminderSettings(local, cloud)
        val (series, links) = TaskSeriesLogic.merge(local, cloud)
        return TodoData(
            version = local.version,
            last_updated = nowIso(),
            todos = merged.values.sortedByDescending { it.createdAt },
            reminderSettings = mergedSettings,
            timeEntries = Learning.mergeTimes(local.timeEntries, cloud.timeEntries),
            dailyReviews = Learning.mergeReviews(local.dailyReviews, cloud.dailyReviews),
            taskSeries = series, taskSeriesLinks = links
        )
    }

    /** 比较 TodoData 的实际业务内容，忽略仅用于文件级标记的 last_updated。 */
    fun hasContentChanges(first: TodoData, second: TodoData): Boolean =
        first.copy(last_updated = "") != second.copy(last_updated = "")

    private fun mergeReminderSettings(local: TodoData, cloud: TodoData): ReminderSettings =
        ReminderSettingsConflict.choose(local, cloud)

    private fun mergeCompletedDates(
        lDates: List<String>,
        cDates: List<String>,
        lTime: String,
        cTime: String
    ): List<String> {
        val allDateParts = (lDates.map { it.substringBefore('T') } + cDates.map { it.substringBefore('T') }).distinct()
        val mergedDates = mutableListOf<String>()

        for (datePart in allDateParts) {
            val checkinL = lDates.find { it.substringBefore('T') == datePart }
            val checkinC = cDates.find { it.substringBefore('T') == datePart }

            if (checkinL != null && checkinC != null) {
                mergedDates.add(chooseCheckinDate(checkinL, checkinC))
            } else if (checkinL != null) {
                if (checkinL.length > 10) {
                    if (isCheckinNewer(checkinL, cTime)) {
                        mergedDates.add(checkinL)
                    }
                } else {
                    mergedDates.add(checkinL)
                }
            } else if (checkinC != null) {
                if (checkinC.length > 10) {
                    if (isCheckinNewer(checkinC, lTime)) {
                        mergedDates.add(checkinC)
                    }
                } else {
                    mergedDates.add(checkinC)
                }
            }
        }
        return mergedDates.sorted()
    }

    // 同日先保留较长记录；等长再按实际毫秒和 UTF-16 字符串序选择同一表示。
    internal fun chooseCheckinDate(first: String, second: String): String {
        val length = first.length.compareTo(second.length)
        if (length != 0) return if (length > 0) first else second
        val time = (checkinTimestampMillis(first) ?: Long.MIN_VALUE)
            .compareTo(checkinTimestampMillis(second) ?: Long.MIN_VALUE)
        if (time != 0) return if (time > 0) first else second
        return if (first >= second) first else second
    }

    private fun isCheckinNewer(mark: String, updatedAt: String): Boolean {
        val markTime = checkinTimestampMillis(mark) ?: return false
        val updateTime = checkinTimestampMillis(updatedAt) ?: return false
        return markTime > updateTime
    }

    private fun checkinTimestampMillis(value: String): Long? =
        runCatching { NormalTodoConflict.timestampMillis(value) }.getOrNull()
}
