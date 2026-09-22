package com.todo.app.data.model

data class LabelGroup(val label: String?, val count: Int)
data class LabelChangePlan(val label: String?, val wholeLabel: Boolean, val expected: Map<String, String?>)

object LabelUtils {
    fun groups(todos: List<Todo>): List<LabelGroup> {
        val counts = todos.filterNot { it.deleted }.groupingBy { Learning.label(it.label) }.eachCount()
        return (listOf<String?>(null) + counts.keys.filterNotNull().sorted()).map { LabelGroup(it, counts[it] ?: 0) }
    }

    fun plan(todos: List<Todo>, label: String?, selectedIds: Set<String>? = null): LabelChangePlan {
        val normalized = Learning.label(label)
        return LabelChangePlan(normalized, selectedIds == null, todos.filter {
            !it.deleted && Learning.label(it.label) == normalized && (selectedIds == null || it.id in selectedIds)
        }.associate { it.id to Learning.label(it.label) })
    }

    // 在最新对象上仅修改标签，不能用打开页面时的整条旧任务覆盖同步结果。
    fun apply(todos: List<Todo>, plan: LabelChangePlan, target: String?, now: String): Pair<List<Todo>, Int> {
        if (plan.wholeLabel) require(todos.filter { !it.deleted && Learning.label(it.label) == plan.label }.map { it.id }.toSet() == plan.expected.keys) {
            "标签所属任务已变化，请重新确认"
        }
        plan.expected.forEach { (id, label) ->
            val todo = todos.find { it.id == id && !it.deleted }
            require(todo != null && Learning.label(todo.label) == label) { "任务标签已变化或任务已删除，请重新确认" }
        }
        val label = Learning.label(target)
        var count = 0
        val result = todos.map {
            if (it.id in plan.expected && Learning.label(it.label) != label) {
                count++
                it.copy(label = label, updatedAt = now)
            } else it
        }
        return result to count
    }
}
