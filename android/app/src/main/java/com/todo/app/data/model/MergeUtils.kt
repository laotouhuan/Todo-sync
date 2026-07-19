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
        val migratedTodos = data.todos.map { migrateTodo(it) }

        // 去重复 ID（保留 updatedAt 最新的）
        val uniqueTodos = migratedTodos.groupBy { it.id }
            .map { (_, list) ->
                list.maxByOrNull {
                    runCatching { OffsetDateTime.parse(it.updatedAt) }.getOrDefault(OffsetDateTime.MIN)
                } ?: list.first()
            }

        // 去重复 completedDates
        val deduplicatedTodos = uniqueTodos.map { todo ->
            val deduped = deduplicateDates(todo.completedDates)
            if (deduped != todo.completedDates) {
                todo.copy(completedDates = deduped)
            } else {
                todo
            }
        }

        return data.copy(todos = deduplicatedTodos)
    }

    private fun deduplicateDates(dates: List<String>): List<String> {
        return dates.groupBy { it.substringBefore('T') }
            .map { (_, group) ->
                group.maxWithOrNull(compareBy<String> { it.length }.thenBy { it })!!
            }
            .sorted()
    }

    /**
     * 合并本地和云端数据。
     * 策略：相同 id 按 updatedAt 取更新版本（Last-Write-Wins），completedDates 取并集。
     */
    fun mergeTodoData(local: TodoData, cloud: TodoData): TodoData {
        val localTodos = normalizeData(local).todos.associateBy { it.id }
        val cloudTodos = normalizeData(cloud).todos.associateBy { it.id }
        val merged = mutableMapOf<String, Todo>()
        for (id in localTodos.keys + cloudTodos.keys) {
            val l = localTodos[id]
            val c = cloudTodos[id]
            if (l != null && c != null) {
                val lTime = try { OffsetDateTime.parse(l.updatedAt) } catch (_: Exception) { OffsetDateTime.MIN }
                val cTime = try { OffsetDateTime.parse(c.updatedAt) } catch (_: Exception) { OffsetDateTime.MIN }
                val base = if (cTime.isAfter(lTime)) c else l

                // completedDates 智能合并：支持销卡（删除打卡）同步与离线补卡合并
                val mergedDates = mergeCompletedDates(l.completedDates, c.completedDates, lTime, cTime)
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
            } else {
                merged[id] = l ?: c!!
            }
        }
        return TodoData(
            version = local.version,
            last_updated = nowIso(),
            todos = merged.values.sortedByDescending { it.createdAt }
        )
    }

    private fun mergeCompletedDates(
        lDates: List<String>,
        cDates: List<String>,
        lTime: OffsetDateTime,
        cTime: OffsetDateTime
    ): List<String> {
        val allDateParts = (lDates.map { it.substringBefore('T') } + cDates.map { it.substringBefore('T') }).distinct()
        val mergedDates = mutableListOf<String>()

        for (datePart in allDateParts) {
            val checkinL = lDates.find { it.startsWith(datePart) }
            val checkinC = cDates.find { it.startsWith(datePart) }

            if (checkinL != null && checkinC != null) {
                if (checkinL.length >= checkinC.length) {
                    mergedDates.add(checkinL)
                } else {
                    mergedDates.add(checkinC)
                }
            } else if (checkinL != null) {
                if (checkinL.length > 10) {
                    val tCheck = try { OffsetDateTime.parse(checkinL) } catch (_: Exception) { OffsetDateTime.MIN }
                    if (tCheck.isAfter(cTime)) {
                        mergedDates.add(checkinL)
                    }
                } else {
                    mergedDates.add(checkinL)
                }
            } else if (checkinC != null) {
                if (checkinC.length > 10) {
                    val tCheck = try { OffsetDateTime.parse(checkinC) } catch (_: Exception) { OffsetDateTime.MIN }
                    if (tCheck.isAfter(lTime)) {
                        mergedDates.add(checkinC)
                    }
                } else {
                    mergedDates.add(checkinC)
                }
            }
        }
        return mergedDates.sorted()
    }
}
