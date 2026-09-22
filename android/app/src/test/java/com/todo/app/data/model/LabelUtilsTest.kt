package com.todo.app.data.model

import org.junit.Assert.*
import org.junit.Test

class LabelUtilsTest {
    private val now = "2026-09-17T00:00:00Z"
    private fun todo(id: String, label: String?) = Todo(id = id, content = id, label = label, createdAt = "2026-09-01T00:00:00Z")

    @Test fun groupsIncludeCompletedAndExcludeDeleted() {
        val tasks = listOf(todo("1", " 学习 "), todo("2", "学习").copy(completed = true), todo("3", "旧").copy(deleted = true), todo("4", "未分类"))
        assertEquals(listOf(LabelGroup(null, 1), LabelGroup("学习", 2)), LabelUtils.groups(tasks))
    }

    @Test fun selectedUpdatePreservesLatestFieldsAndUnchangedTasks() {
        val tasks = listOf(todo("1", "学习"), todo("2", "学习"))
        val plan = LabelUtils.plan(tasks, "学习", setOf("1"))
        val latest = listOf(tasks[0].copy(content = "同步后的内容", subtasks = listOf(Subtask("s", "步骤", false))), tasks[1])
        val (updated, count) = LabelUtils.apply(latest, plan, " 英语 ", now)
        assertEquals(1, count)
        assertEquals(latest[0].copy(label = "英语", updatedAt = now), updated[0])
        assertSame(tasks[1], updated[1])
        assertEquals("学习", latest[0].label)
    }

    @Test fun noOpAndClear() {
        val tasks = listOf(todo("1", "学习")); val plan = LabelUtils.plan(tasks, "学习")
        assertEquals(0, LabelUtils.apply(tasks, plan, " 学习 ", now).second)
        assertNull(LabelUtils.apply(tasks, plan, null, now).first[0].label)
    }

    @Test fun concurrentChangesRejectStalePlan() {
        val tasks = listOf(todo("1", "学习")); val plan = LabelUtils.plan(tasks, "学习", setOf("1"))
        listOf(emptyList(), listOf(tasks[0].copy(deleted = true)), listOf(tasks[0].copy(label = "工作"))).forEach { latest ->
            assertThrows(IllegalArgumentException::class.java) { LabelUtils.apply(latest, plan, "英语", now) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            LabelUtils.apply(tasks + todo("2", "学习"), LabelUtils.plan(tasks, "学习"), "英语", now)
        }
    }

    @Test fun mergeKeepsTargetAndHistorySnapshot() {
        val tasks = listOf(todo("1", "学习"), todo("2", "英语"))
        val (updated, count) = LabelUtils.apply(tasks, LabelUtils.plan(tasks, "学习"), "英语", now)
        assertEquals(1, count); assertSame(tasks[1], updated[1])
        val entry = TimeEntry("e", TaskReference("1"), now, now, now, label_snapshot = "学习")
        assertEquals("英语", Learning.resolveEntries(listOf(entry), mapOf(entry.task_ref to updated[0]))[0].label_snapshot)
        assertEquals("学习", entry.label_snapshot)
    }
}
