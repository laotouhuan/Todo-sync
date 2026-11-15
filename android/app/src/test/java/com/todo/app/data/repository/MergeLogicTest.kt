package com.todo.app.data.repository

import com.todo.app.data.model.MergeUtils
import com.todo.app.data.model.GlobalReminderRule
import com.todo.app.data.model.ReminderSettings
import com.todo.app.data.model.TaskType
import com.todo.app.data.model.Todo
import com.todo.app.data.model.TodoData
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.OffsetDateTime
import java.util.UUID

class MergeLogicTest {

    @Test
    fun sharedReminderSettingsVectorsUseActualMergeAndWholeFileRoundTrip() {
        val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }
        val fixture = requireNotNull(javaClass.classLoader?.getResourceAsStream("reminder-settings/conflicts.json"))
            .bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
        fun data(raw: JsonElement): TodoData = json.decodeFromJsonElement(JsonObject(
            mapOf("version" to JsonPrimitive(1), "todos" to JsonArray(emptyList())) + raw.jsonObject))
        // JSON 数字按 binary64 内容比较，允许序列化器写出等值的指数文本。
        fun semantic(value: JsonElement): Any? = when (value) {
            JsonNull -> null
            is JsonObject -> value.mapValues { semantic(it.value) }
            is JsonArray -> value.map { semantic(it) }
            is JsonPrimitive -> when {
                value.isString -> value.content
                value.booleanOrNull != null -> value.boolean
                else -> value.double.let { if (it == 0.0) 0.0 else it }
            }
        }
        for (entry in fixture.getValue("cases").jsonArray) {
            val case = entry.jsonObject
            val name = case.getValue("id").jsonPrimitive.content
            val local = data(case.getValue("local"))
            val cloud = data(case.getValue("cloud"))
            val winner = json.decodeFromJsonElement<ReminderSettings>(case.getValue("winner"))
            for ((left, right) in listOf(local to cloud, cloud to local)) {
                val merged = MergeUtils.mergeTodoData(left, right)
                assertEquals("$name 整份选择", winner, merged.reminderSettings)
                val encoded = json.encodeToJsonElement(ReminderSettings.serializer(), merged.reminderSettings)
                assertEquals("$name 原始未知字段", semantic(case.getValue("winner")), semantic(encoded))
                val restored = json.decodeFromString<TodoData>(json.encodeToString(TodoData.serializer(), merged))
                val restoredSettings = json.encodeToJsonElement(ReminderSettings.serializer(), restored.reminderSettings)
                assertEquals("$name 整文件往返", semantic(case.getValue("winner")), semantic(restoredSettings))
            }
        }
    }

    @Test
    fun reminderSettingsEqualMillisecondsChooseOneWholeSettingsObject() {
        val enabled = ReminderSettings(updatedAt = "2026-11-05T08:00:00.0001+08:00", enabled = true)
        val disabled = ReminderSettings(updatedAt = "2026-11-05T00:00:00.0009Z", enabled = false)
        fun data(settings: ReminderSettings) = TodoData(1, "2026-11-06T00:00:00Z", emptyList(), settings)
        assertEquals(enabled, MergeUtils.mergeTodoData(data(enabled), data(disabled)).reminderSettings)
        assertEquals(enabled, MergeUtils.mergeTodoData(data(disabled), data(enabled)).reminderSettings)
        val newerDisabled = disabled.copy(updatedAt = "2026-11-05T00:00:00.0010Z")
        assertEquals(newerDisabled, MergeUtils.mergeTodoData(data(enabled), data(newerDisabled)).reminderSettings)
    }

    @Test
    fun reminderSingleSidedNormalizationChecksNestedJsonAndPreservesInvalidClock() {
        val rule = GlobalReminderRule("legacy-rule", time = "legacy time")
        val settings = ReminderSettings(updatedAt = "invalid", globalRules = listOf(rule))
        fun data(value: ReminderSettings) = TodoData(1, "invalid", emptyList(), value)
        assertEquals(settings, MergeUtils.normalizeData(data(settings)).reminderSettings)
        for (value in listOf(JsonPrimitive("\ud800"), JsonPrimitive("\ufdd0"), JsonPrimitive(Double.NaN), JsonPrimitive(Double.POSITIVE_INFINITY))) {
            val damaged = settings.copy(globalRules = listOf(rule.copy(extraFields = JsonObject(mapOf("extension" to JsonObject(mapOf("nested" to value)))))))
            assertTrue(runCatching { MergeUtils.normalizeData(data(damaged)) }.isFailure)
            assertTrue(runCatching { MergeUtils.mergeTodoData(data(damaged), data(ReminderSettings(updatedAt = "2026-11-05T00:00:00Z"))) }.isFailure)
        }
    }

    @Test
    fun sharedPeriodBaseVectorsChooseWholeCandidatesBeforeExtraDateMerge() {
        val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }
        val fixture = requireNotNull(javaClass.classLoader?.getResourceAsStream("period-base/conflicts.json"))
            .bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
        fun data(todos: List<Todo>) = TodoData(1, "", todos)
        for (entry in fixture.getValue("cases").jsonArray) {
            val case = entry.jsonObject
            val name = case.getValue("id").jsonPrimitive.content
            val records = case.getValue("records").jsonArray.map { json.decodeFromJsonElement<Todo>(it) }
            val winner = json.decodeFromJsonElement<Todo>(case.getValue("winner"))
            val dates = case.getValue("expected_dates").jsonArray.map { it.jsonPrimitive.content }
            for (sequence in listOf(records, records.reversed(), records + records.reversed())) {
                assertEquals("$name 同侧重复", winner, MergeUtils.normalizeData(data(sequence)).todos.single())
                val folded = sequence.fold(data(emptyList())) { current, record ->
                    // 基础字段分批选择不把额外日期归并生成的 now 当作新的输入记录。
                    MergeUtils.normalizeData(data(current.todos + record))
                }
                assertEquals("$name 基础字段分批", winner, folded.todos.single())
            }
            for ((left, right) in listOf(records.first() to records.last(), records.last() to records.first())) {
                val merged = MergeUtils.mergeTodoData(data(listOf(left)), data(listOf(right))).todos.single()
                assertEquals("$name 额外日期", dates, merged.completedDates)
                // 共享样本中的预期打卡日均属于胜出周期。
                val completed = winner.targetCount?.let { dates.size >= it } ?: false
                assertEquals("$name 派生完成", completed, merged.completed)
                if (dates == winner.completedDates && completed == winner.completed) {
                    assertEquals("$name 无派生修改时保留原时钟", winner.updatedAt, merged.updatedAt)
                }
                assertEquals("$name 基础整条", winner, merged.copy(
                    completedDates = winner.completedDates, updatedAt = winner.updatedAt,
                    completed = winner.completed, completedAt = winner.completedAt))
            }
        }
    }

    @Test
    fun periodBaseKeepsOriginalZeroTargetAndUsesFixedLabelNormalization() {
        val zeroTarget = Todo("period", "零目标", date = "2026-W45", taskType = TaskType.WEEKLY_CHECKIN,
            createdAt = "2026-11-01T00:00:00Z", updatedAt = "2026-11-05T01:00:00Z", targetCount = 0,
            label = "\u0085标签\u0085")
        val older = zeroTarget.copy(content = "旧版", updatedAt = "2026-11-05T00:00:00Z", targetCount = null)
        fun data(todos: List<Todo>) = TodoData(1, "", todos)
        for (rows in listOf(listOf(zeroTarget, older), listOf(older, zeroTarget))) {
            assertEquals(0, MergeUtils.normalizeData(data(rows)).todos.single().targetCount)
            val merged = MergeUtils.mergeTodoData(data(listOf(rows[0])), data(listOf(rows[1]))).todos.single()
            assertEquals("零目标", merged.content)
            assertEquals(0, merged.targetCount)
            assertTrue(merged.completed)
            assertEquals(zeroTarget.label, merged.label)
        }
        val trimmed = MergeUtils.normalizeData(data(listOf(zeroTarget.copy(label = "\ufeff标签\ufeff")))).todos.single()
        assertEquals("标签", trimmed.label)
        val unbounded = zeroTarget.copy(targetCount = null)
        val left = MergeUtils.normalizeData(data(listOf(zeroTarget, unbounded))).todos.single()
        val right = MergeUtils.normalizeData(data(listOf(unbounded, zeroTarget))).todos.single()
        assertEquals(left, right)
        assertTrue(left == zeroTarget || left == unbounded)
    }

    @Test
    fun mixedNormalAndPeriodTasksKeepTheirExistingBaseSelectionPath() {
        val normal = Todo("same", "普通", createdAt = "2026-11-01T00:00:00Z", updatedAt = "2026-11-05T00:00:00Z")
        val period = normal.copy(content = "周期", taskType = TaskType.WEEKLY_CHECKIN, date = "2026-W45")
        fun data(todo: Todo) = TodoData(1, "", listOf(todo))
        assertEquals("普通", MergeUtils.mergeTodoData(data(normal), data(period)).todos.single().content)
        assertEquals("周期", MergeUtils.mergeTodoData(data(period), data(normal)).todos.single().content)
    }

    @Test
    fun singlePeriodCandidateValidatesUnknownJsonWithoutReplacingItsClockOrTarget() {
        for ((type, date) in listOf(TaskType.WEEKLY_CHECKIN to "2026-W45", TaskType.MONTHLY_CHECKIN to "2026-11")) {
            val todo = Todo("period", "周期", date = date, taskType = type, targetCount = 0,
                createdAt = "2026-11-01T00:00:00Z", updatedAt = "invalid")
            fun normalize(value: Todo) = MergeUtils.normalizeData(TodoData(1, "", listOf(value))).todos.single()
            assertEquals(todo, normalize(todo))
            for (value in listOf(JsonPrimitive("\ud800"), JsonPrimitive("\ufdd0"), JsonPrimitive(Double.NaN), JsonPrimitive(Double.POSITIVE_INFINITY))) {
                val damaged = todo.copy(extraFields = JsonObject(mapOf("extension" to JsonObject(mapOf("nested" to value)))))
                assertTrue("$type $value", runCatching { normalize(damaged) }.isFailure)
            }
        }
    }

    @Test
    fun sharedCheckinVectorsUseProductionMergeAndNormalization() {
        val json = Json { ignoreUnknownKeys = true }
        val fixture = requireNotNull(javaClass.classLoader?.getResourceAsStream("checkin/conflicts.json"))
            .bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
        fun strings(value: JsonElement) = value.jsonArray.map { it.jsonPrimitive.content }
        fun data(todo: Todo) = TodoData(1, "2026-11-05T00:00:00Z", listOf(todo))
        for (entry in fixture.getValue("cases").jsonArray) {
            val case = entry.jsonObject
            val name = case.getValue("id").jsonPrimitive.content
            val expected = strings(case.getValue("expected"))
            for ((type, period) in listOf(TaskType.WEEKLY_CHECKIN to "2026-W45", TaskType.MONTHLY_CHECKIN to "2026-11")) {
                val local = Todo("checkin", "打卡", date = period, taskType = type, targetCount = 1,
                    createdAt = "2026-11-01T00:00:00Z", updatedAt = case.getValue("local_updated").jsonPrimitive.content,
                    completedDates = strings(case.getValue("local_dates")))
                val cloud = local.copy(updatedAt = case.getValue("cloud_updated").jsonPrimitive.content,
                    completedDates = strings(case.getValue("cloud_dates")))
                for ((left, right) in listOf(local to cloud, cloud to local,
                    local.copy(completedDates = local.completedDates.reversed() + local.completedDates) to
                        cloud.copy(completedDates = cloud.completedDates.reversed() + cloud.completedDates),
                    cloud.copy(completedDates = cloud.completedDates.reversed() + cloud.completedDates) to
                        local.copy(completedDates = local.completedDates.reversed() + local.completedDates))) {
                    val merged = MergeUtils.mergeTodoData(data(left), data(right)).todos.single()
                    assertEquals("$name $type 日期", expected, merged.completedDates)
                    assertEquals("$name $type 完成", expected.isNotEmpty(), merged.completed)
                    assertEquals("$name $type 幂等归一", merged.completedDates, MergeUtils.normalizeData(data(merged)).todos.single().completedDates)
                }
            }
        }
    }

    @Test
    fun sharedNormalTodoVectorsUseProductionMergeInEveryDiscoveryOrder() {
        val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }
        val fixture = requireNotNull(javaClass.classLoader?.getResourceAsStream("normal-todo/conflicts.json"))
            .bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
        fun data(todos: List<Todo>) = TodoData(1, "2026-11-05T00:00:00Z", todos)
        for (entry in fixture.getValue("validCases").jsonArray) {
            val case = entry.jsonObject
            val name = case.getValue("id").jsonPrimitive.content
            val records = case.getValue("records").jsonArray.map { json.decodeFromJsonElement<Todo>(it) }
            val expected = case.getValue("winners").jsonArray.map { json.decodeFromJsonElement<Todo>(it) }.sortedBy { it.id }
            for (sequence in listOf(records, records.reversed(), records + records.reversed())) {
                val folded = sequence.fold(data(emptyList())) { result, record -> MergeUtils.mergeTodoData(result, data(listOf(record))) }
                assertEquals("$name 分批发现", expected, folded.todos.sortedBy { it.id })
                val normalized = MergeUtils.normalizeData(data(sequence))
                assertEquals("$name 同侧重复", expected, normalized.todos.sortedBy { it.id })
                val repeated = MergeUtils.mergeTodoData(folded, data(sequence.reversed()))
                assertEquals("$name 重复同步", expected, repeated.todos.sortedBy { it.id })
            }
        }
    }

    @Test
    fun normalTodoKeepsWholeHistoricalArraysAndNeverSynthesizesUpdateTime() {
        val first = Todo("legacy-id", "z", createdAt = "2026-11-05T00:00:00Z",
            updatedAt = "2026-11-05T08:00:00.0009+08:00", completedDates = listOf("2026-11-04", "2026-11-03", "2026-11-04"))
        val second = first.copy(content = "aa", updatedAt = "2026-11-05T00:00:00.0011Z", completedDates = listOf("2026-11-02", "2026-11-01"))
        fun data(todo: Todo) = TodoData(1, "", listOf(todo))
        assertEquals(first, MergeUtils.normalizeData(data(first)).todos.single())
        assertEquals(second, MergeUtils.mergeTodoData(data(first), data(second)).todos.single())
        assertEquals(second, MergeUtils.mergeTodoData(data(second), data(first)).todos.single())
    }

    @Test
    fun normalTodoUsesFixedWhitespaceAndRejectsDamagedTimesWithoutWritingNow() {
        val todo = Todo("old-id", "任务", createdAt = "2026-11-05T00:00:00Z", label = "\u0085标签\u0085")
        val normalized = MergeUtils.normalizeData(TodoData(1, "", listOf(todo))).todos.single()
        assertEquals(todo.label, normalized.label)
        assertEquals("标签", MergeUtils.normalizeData(TodoData(1, "", listOf(todo.copy(label = "\ufeff标签\ufeff")))).todos.single().label)
        val broken = todo.copy(updatedAt = "2026-02-30T00:00:00Z")
        assertTrue(runCatching { MergeUtils.normalizeData(TodoData(1, "", listOf(broken))) }.isFailure)
        assertEquals("2026-02-30T00:00:00Z", broken.updatedAt)
    }

    @Test
    fun normalTodoRejectsInvalidNestedUnicodeEvenWithoutAConflict() {
        val todo = Todo("old-id", "任务", createdAt = "2026-11-05T00:00:00Z")
        for (text in listOf("\ud800", "\udc00", "\ufdd0", "\uffff", "\ud83f\udfff")) {
            val damaged = todo.copy(extraFields = JsonObject(mapOf("future" to JsonObject(mapOf("nested" to JsonPrimitive(text))))))
            assertTrue(runCatching { MergeUtils.normalizeData(TodoData(1, "", listOf(damaged))) }.isFailure)
        }
    }

    @Test
    fun weeklyCheckinUsesDeterministicSameDayAndMillisecondRules() {
        val first = Todo("weekly", "周任务", date = "2026-W45", createdAt = "2026-11-01T00:00:00Z",
            updatedAt = "2026-11-05T01:00:00Z", taskType = TaskType.WEEKLY_CHECKIN, targetCount = 3,
            completedDates = listOf("2026-11-05T10:00:00+08:00"))
        val second = first.copy(completedDates = listOf("2026-11-05T11:00:00+08:00"))
        fun data(todo: Todo) = TodoData(1, "", listOf(todo))
        // 等长同日记录按实际时间取较晚值，交换方向也不能改变结果。
        assertEquals(second.completedDates, MergeUtils.mergeTodoData(data(first), data(second)).todos.single().completedDates)
        assertEquals(second.completedDates, MergeUtils.mergeTodoData(data(second), data(first)).todos.single().completedDates)
        val precise = first.copy(updatedAt = "2026-11-05T00:00:00.0000Z", completedDates = listOf("2026-11-05T00:00:00.0002Z"))
        val removed = first.copy(updatedAt = "2026-11-05T00:00:00.0001Z", completedDates = emptyList())
        // 销卡比较也按毫秒，单边打卡必须严格晚于另一端更新才保留。
        assertEquals(emptyList<String>(), MergeUtils.mergeTodoData(data(precise), data(removed)).todos.single().completedDates)
        assertEquals(emptyList<String>(), MergeUtils.mergeTodoData(data(removed), data(precise)).todos.single().completedDates)
        val reversedDates = first.copy(completedDates = listOf("2026-11-04", "2026-11-03"))
        val sortedDates = reversedDates.copy(completedDates = reversedDates.completedDates.sorted())
        assertEquals(sortedDates.completedDates, MergeUtils.mergeTodoData(data(reversedDates), data(sortedDates)).todos.single().completedDates)
        assertEquals(sortedDates.completedDates, MergeUtils.mergeTodoData(data(sortedDates), data(reversedDates)).todos.single().completedDates)
    }

    @Test
    fun singleSidedCheckinDoesNotTreatAnInvalidClockAsInfinitelyOld() {
        val marked = Todo("weekly", "打卡", date = "2026-W45", taskType = TaskType.WEEKLY_CHECKIN, targetCount = 1,
            createdAt = "2026-11-01T00:00:00Z", updatedAt = "2026-11-05T01:00:00Z",
            completedDates = listOf("2026-11-05T02:00:00Z"))
        val brokenClock = marked.copy(updatedAt = "invalid", completedDates = emptyList())
        fun data(todo: Todo) = TodoData(1, "", listOf(todo))
        assertTrue(MergeUtils.mergeTodoData(data(marked), data(brokenClock)).todos.single().completedDates.isEmpty())
        assertTrue(MergeUtils.mergeTodoData(data(brokenClock), data(marked)).todos.single().completedDates.isEmpty())
        val brokenMark = marked.copy(completedDates = listOf("2026-11-05Tinvalid"))
        assertTrue(MergeUtils.mergeTodoData(data(brokenMark), data(marked.copy(completedDates = emptyList()))).todos.single().completedDates.isEmpty())
    }

    @Test
    fun checkinDayGroupingDoesNotMatchAShortDamagedPrefixToAnotherDay() {
        val shortDay = Todo("weekly", "打卡", date = "2026-W45", taskType = TaskType.WEEKLY_CHECKIN,
            createdAt = "2026-11-01T00:00:00Z", updatedAt = "2026-11-05T01:00:00Z", completedDates = listOf("2026-11-0"))
        val fullDay = shortDay.copy(completedDates = listOf("2026-11-05"))
        fun data(todo: Todo) = TodoData(1, "", listOf(todo))
        val expected = listOf("2026-11-0", "2026-11-05")
        assertEquals(expected, MergeUtils.mergeTodoData(data(shortDay), data(fullDay)).todos.single().completedDates)
        assertEquals(expected, MergeUtils.mergeTodoData(data(fullDay), data(shortDay)).todos.single().completedDates)
    }

    @Test
    fun testMergeConflict_LastWriteWins() {
        val id = UUID.randomUUID().toString()
        val localTime = "2026-06-15T12:00:00Z"
        val cloudTime = "2026-06-15T13:00:00Z"

        val localTodo = Todo.create("Local", date = "2026-06-15").copy(
            id = id,
            updatedAt = localTime,
            completed = false
        )

        val cloudTodo = Todo.create("Cloud", date = "2026-06-15").copy(
            id = id,
            updatedAt = cloudTime,
            completed = true // Cloud changed it to completed later
        )

        val localData = TodoData(1, localTime, listOf(localTodo))
        val cloudData = TodoData(1, cloudTime, listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        // Should take the cloud version because it has a later updatedAt
        assertEquals(1, mergedData.todos.size)
        assertEquals(true, mergedData.todos[0].completed)
        assertEquals("Cloud", mergedData.todos[0].content)
    }

    @Test
    fun testMerge_NonOverlapping() {
        val localTodo = Todo.create("Local Only")
        val cloudTodo = Todo.create("Cloud Only")

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        // Both should exist
        assertEquals(2, mergedData.todos.size)
        assertTrue(mergedData.todos.any { it.content == "Local Only" })
        assertTrue(mergedData.todos.any { it.content == "Cloud Only" })
    }

    @Test
    fun testMerge_CompletedDatesUnion() {
        val id = UUID.randomUUID().toString()
        
        val localTodo = Todo.create("Task").copy(taskType = TaskType.WEEKLY_CHECKIN,
            id = id,
            completedDates = listOf("2026-06-01", "2026-06-03"),
            updatedAt = "2026-06-15T12:00:00Z"
        )
        
        val cloudTodo = Todo.create("Task").copy(taskType = TaskType.WEEKLY_CHECKIN,
            id = id,
            completedDates = listOf("2026-06-02", "2026-06-03"),
            updatedAt = "2026-06-15T11:00:00Z"
        )

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        // Should union and sort completedDates
        assertEquals(1, mergedData.todos.size)
        val mergedTodo = mergedData.todos[0]
        assertEquals(listOf("2026-06-01", "2026-06-02", "2026-06-03"), mergedTodo.completedDates)
    }

    @Test
    fun testMerge_CompletedDatesDeduplicationWithTimestamp() {
        val id = UUID.randomUUID().toString()

        val localTodo = Todo.create("Task").copy(taskType = TaskType.WEEKLY_CHECKIN,
            id = id,
            completedDates = listOf("2026-06-02", "2026-06-03T10:00:00Z"),
            updatedAt = "2026-06-15T12:00:00Z"
        )

        val cloudTodo = Todo.create("Task").copy(taskType = TaskType.WEEKLY_CHECKIN,
            id = id,
            completedDates = listOf("2026-06-02T12:00:00Z", "2026-06-03"),
            updatedAt = "2026-06-15T11:00:00Z"
        )

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(1, mergedData.todos.size)
        val mergedTodo = mergedData.todos[0]
        assertEquals(listOf("2026-06-02T12:00:00Z", "2026-06-03T10:00:00Z"), mergedTodo.completedDates)
    }

    @Test
    fun testMerge_WeeklyCheckinCompletionRecalculation() {
        val id = UUID.randomUUID().toString()
        val targetDateStr = "2026-W03" // Weekly task

        val localTodo = Todo.create("Weekly Task", date = targetDateStr).copy(
            id = id,
            taskType = TaskType.WEEKLY_CHECKIN,
            targetCount = 2,
            completed = false,
            // 2026-W03 usually starts around Jan 12-18, 2026
            completedDates = listOf("2026-01-13"), // One checkin locally
            updatedAt = "2026-01-13T12:00:00Z"
        )

        val cloudTodo = Todo.create("Weekly Task", date = targetDateStr).copy(
            id = id,
            taskType = TaskType.WEEKLY_CHECKIN,
            targetCount = 2,
            completed = false,
            completedDates = listOf("2026-01-14"), // Another checkin on cloud
            updatedAt = "2026-01-14T12:00:00Z"
        )

        val localData = TodoData(1, "2026-01-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-01-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        val mergedTodo = mergedData.todos[0]
        // The union makes it 2 checkins in that week, so completed must become true
        assertEquals(listOf("2026-01-13", "2026-01-14"), mergedTodo.completedDates)
        assertTrue(mergedTodo.completed)
    }

    @Test
    fun testMerge_CompletedDatesDeletionSync() {
        val id = UUID.randomUUID().toString()

        val localTodo = Todo.create("Task").copy(taskType = TaskType.WEEKLY_CHECKIN,
            id = id,
            completedDates = listOf("2026-06-02T10:00:00Z"),
            updatedAt = "2026-06-02T10:00:00Z"
        )

        val cloudTodo = Todo.create("Task").copy(taskType = TaskType.WEEKLY_CHECKIN,
            id = id,
            completedDates = emptyList(),
            updatedAt = "2026-06-02T12:00:00Z" // Cloud deleted it later
        )

        val localData = TodoData(1, "2026-06-15T12:00:00Z", listOf(localTodo))
        val cloudData = TodoData(1, "2026-06-15T12:00:00Z", listOf(cloudTodo))

        val mergedData = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(1, mergedData.todos.size)
        val mergedTodo = mergedData.todos[0]
        assertEquals(emptyList<String>(), mergedTodo.completedDates)
    }

    @Test
    fun testNormalizeData_MigrateOldFormat() {
        val oldWeekly = Todo.create("Old Weekly", date = "2026-01-15").copy(
            recurring = "weekly",
            taskType = "normal"
        )

        val oldData = TodoData(1, "2026-06-15T12:00:00Z", listOf(oldWeekly))
        val normalized = MergeUtils.normalizeData(oldData)

        val migrated = normalized.todos[0]
        assertEquals("none", migrated.recurring)
        assertEquals(TaskType.WEEKLY_CHECKIN, migrated.taskType)
    }

    @Test
    fun testMergeReminderSettings_IgnoresNewerRootTimestampFromTodoChanges() {
        val localRule = GlobalReminderRule(
            id = "rule-1",
            time = "09:00",
            body = "提醒"
        )
        val localData = TodoData(
            version = 1,
            last_updated = "2026-09-07T08:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(
                updatedAt = "2026-09-07T07:00:00Z",
                globalRules = listOf(localRule)
            )
        )
        val cloudData = TodoData(
            version = 1,
            last_updated = "2026-09-07T12:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(updatedAt = "2026-09-07T06:00:00Z")
        )

        val merged = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(listOf(localRule), merged.reminderSettings.globalRules)
    }

    @Test
    fun testMergeReminderSettings_NewerEmptySettingsPropagateDeletion() {
        val localData = TodoData(
            version = 1,
            last_updated = "2026-09-07T07:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(
                updatedAt = "2026-09-07T07:00:00Z",
                globalRules = listOf(GlobalReminderRule(id = "rule-1", time = "09:00"))
            )
        )
        val cloudData = TodoData(
            version = 1,
            last_updated = "2026-09-07T08:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(updatedAt = "2026-09-07T08:00:00Z")
        )

        val merged = MergeUtils.mergeTodoData(localData, cloudData)

        assertTrue(merged.reminderSettings.globalRules.isEmpty())
    }

    @Test
    fun testMergeReminderSettings_LegacyConflictPreservesNonEmptyRules() {
        val legacyRule = GlobalReminderRule(id = "legacy-rule", time = "18:00")
        val localData = TodoData(
            version = 1,
            last_updated = "2026-09-07T07:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings(globalRules = listOf(legacyRule))
        )
        val cloudData = TodoData(
            version = 1,
            last_updated = "2026-09-07T12:00:00Z",
            todos = emptyList(),
            reminderSettings = ReminderSettings()
        )

        val merged = MergeUtils.mergeTodoData(localData, cloudData)

        assertEquals(listOf(legacyRule), merged.reminderSettings.globalRules)
    }

    @Test
    fun testHasContentChanges_IgnoresRootTimestampAndDetectsReminderChanges() {
        val base = TodoData(
            version = 1,
            last_updated = "2026-09-07T07:00:00Z",
            todos = emptyList()
        )
        val onlyRootChanged = base.copy(last_updated = "2026-09-07T08:00:00Z")
        val reminderChanged = onlyRootChanged.copy(
            reminderSettings = onlyRootChanged.reminderSettings.copy(privacyMode = true)
        )

        assertEquals(false, MergeUtils.hasContentChanges(base, onlyRootChanged))
        assertEquals(true, MergeUtils.hasContentChanges(base, reminderChanged))
    }

    @Test fun mergeLearningDataUsesDateAndPreservesTombstones() {
        val time = "2026-09-10T00:00:00Z"
        val review = com.todo.app.data.model.DailyReview("a", "2026-09-10", time, time, fact = "旧")
        val latest = review.copy(id = "b", updated_at = "2026-09-10T01:00:00Z", fact = "新")
        val entry = com.todo.app.data.model.TimeEntry("t", com.todo.app.data.model.TaskReference("task"), time, time, time)
        val local = TodoData(1, time, emptyList(), timeEntries = listOf(entry), dailyReviews = listOf(review))
        val cloud = local.copy(timeEntries = listOf(entry.copy(deleted = true)), dailyReviews = listOf(latest))
        val merged = MergeUtils.mergeTodoData(local, cloud)
        assertEquals(listOf(latest), merged.dailyReviews)
        assertTrue(merged.timeEntries.single().deleted)
        assertEquals(merged.dailyReviews, MergeUtils.mergeTodoData(cloud, local).dailyReviews)
        assertEquals(merged.timeEntries, MergeUtils.mergeTodoData(cloud, local).timeEntries)
    }


    @org.junit.Test fun seriesOnlyRenameTriggersContentChangeAndPreservesLearningData() {
        val t = com.todo.app.data.model.Todo.create("数学", "2026-W41").copy(taskType = "weekly_checkin")
        val original = com.todo.app.data.model.TodoData(1, "2026-10-15T12:00:00+08:00", listOf(t))
        val linked = com.todo.app.data.model.TaskSeriesLogic.import(original, listOf(t), "2026-W42", "2026-10-15T12:00:00+08:00")
        val renamed = linked.copy(taskSeries = linked.taskSeries.map { it.copy(content = "新名称", content_renamed = true) })
        val merged = com.todo.app.data.model.MergeUtils.mergeTodoData(linked, renamed)
        org.junit.Assert.assertTrue(com.todo.app.data.model.MergeUtils.hasContentChanges(merged, linked))
        org.junit.Assert.assertEquals("新名称", merged.taskSeries.single().content)
        org.junit.Assert.assertEquals(linked.timeEntries, merged.timeEntries)
        org.junit.Assert.assertEquals(linked.dailyReviews, merged.dailyReviews)
    }

}
