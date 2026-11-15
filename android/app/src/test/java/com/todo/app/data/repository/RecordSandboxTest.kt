package com.todo.app.data.repository

import com.todo.app.data.model.WeeklyPlanning
import com.todo.app.data.model.Learning
import com.todo.app.data.model.TodoData
import java.io.File
import java.time.LocalDate
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RecordSandboxTest {
    @get:Rule val folder = TemporaryFolder()

    private val week = "2026-11-09"
    private val at = "${week}T09:00:00Z"
    private fun id(n: Int) = "10000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun target(n: Int) = RecordSandboxTarget(id(n), id(100 + n), at)
    private fun action(kind: String, fields: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("kind", kind)
        fields()
    }
    private fun RecordSandboxView.view() = requireNotNull(preview.view)
    private fun RecordSandboxView.todo() = view().getValue("todos").jsonArray.single().jsonObject

    @Test fun ratingCoverageUsesCalendarDaysAndCountsOnlyValidScores() {
        fun rating(n: Int, date: String, score: Int?, deleted: Boolean = false, updated: String = at) = buildJsonObject {
            put("id", id(n)); put("date", date); put("score", score?.let(::JsonPrimitive) ?: JsonNull)
            put("created_at", at); put("updated_at", updated); put("deleted", deleted)
        }
        val data = buildJsonObject {
            put("daily_ratings", JsonArray(listOf(
                rating(1, "2024-02-01", 4), rating(2, "2024-02-01", 2, updated = "2026-11-09T08:00:00Z"),
                rating(3, "2024-02-02", null), rating(4, "2024-02-03", 1, deleted = true),
                rating(5, "2024-01-31", 5), rating(6, "2024-03-01", 5)
            )))
        }
        assertEquals(WeeklyPlanning.RatingSummary("4.0", 1, 29), WeeklyPlanning.ratingSummary(data, "2024-02-01", "2024-02-29"))
        assertEquals(WeeklyPlanning.RatingSummary(null, 0, 28), WeeklyPlanning.ratingSummary(data, "2025-02-01", "2025-02-28"))
    }

    @Test fun reopensDurableQueueAndKeepsTargetsApart() = runBlocking {
        val original = File(folder.root, "todo_data.json").apply { writeText("原清单") }
        val first = RecordSandbox(folder.root, target(1))
        var state = first.change(action("add") { put("content", "合成任务") }, first.open().revision)
        val id = state.todo().getValue("id").jsonPrimitive.content
        val addedRevision = state.revision
        state = first.change(action("rename") { put("todoId", id); put("content", "已改名") }, state.revision)
        assertEquals("已改名", state.todo()["content"]?.jsonPrimitive?.content)
        assertEquals("RECORD_WRITE_STALE", runCatching { first.change(action("remove") { put("todoId", id) }, addedRevision) }
            .exceptionOrNull()?.message)
        state = first.change(action("remove") { put("todoId", id) }, state.revision)
        assertEquals(true, state.todo()["deleted"]?.jsonPrimitive?.boolean)
        assertEquals(3, state.preview.journal.pending.size)
        first.close()
        assertEquals("RECORD_SESSION_CLOSED", runCatching { first.sync() }.exceptionOrNull()?.message)
        val other = RecordSandbox(folder.root, target(2))
        assertTrue(other.sync().view().getValue("todos").jsonArray.isEmpty())
        val otherRecords = File(folder.root, "record-sandbox/record-sync/${target(2).datasetId}/records")
        assertTrue(otherRecords.listFiles()!!.isEmpty())
        other.close()
        val reopened = RecordSandbox(folder.root, target(1))
        assertEquals(state.preview.journal.pending, reopened.open().preview.journal.pending)
        assertTrue(reopened.sync().preview.journal.pending.isEmpty())
        assertEquals("原清单", original.readText())
        assertTrue(otherRecords.listFiles()!!.isEmpty())
    }

    @Test fun savesPlanAndClearsRatingThroughJournal() = runBlocking {
        val session = RecordSandbox(folder.root, target(1))
        var state = session.open()
        state = session.change(action("save") {
            put("week", week); put("versionId", id(9)); put("tips", JsonArray(emptyList())); put("reason", "测试")
            put("days", JsonArray(listOf("合成计划", "", "", "", "", "", "").map(::JsonPrimitive)))
        }, state.revision)
        assertEquals(id(9), WeeklyPlanning.state(state.view(), week).current?.get("id")?.jsonPrimitive?.content)
        state = session.change(action("rate") { put("date", week); put("score", 5) }, state.revision)
        assertEquals("5.0", WeeklyPlanning.average(state.view(), week, week))
        state = session.change(action("rate") { put("date", week); put("score", JsonNull) }, state.revision)
        assertNull(WeeklyPlanning.average(state.view(), week, week))
        assertEquals(JsonNull, state.view().getValue("daily_ratings").jsonArray.single().jsonObject["score"])
        assertEquals(3, state.preview.journal.records.size)
    }

    @Test fun historyCanExportByItselfAndDoesNotTurnPlanTextIntoMarkup() {
        val date = LocalDate.parse(week)
        val baseline = buildJsonObject {
            put("version", 1)
            put("last_updated", at)
            put("todos", JsonArray(emptyList()))
        }
        val operation = WeeklyPlanning.change(baseline, action("save") {
            put("week", week); put("versionId", id(8)); put("tips", JsonArray(emptyList())); put("reason", "")
            put("days", JsonArray(listOf("<b>计划</b>", "", "", "", "", "", "").map(::JsonPrimitive)))
        }, id(9), at)!!
        val data = WeeklyPlanning.apply(baseline, listOf(operation))
        val history = WeeklyPlanning.export(data, date, date.plusDays(1), WeeklyPlanning.ExportOptions(includePlanHistory = true))
        val (_, markdown) = Learning.export(TodoData(1, at, emptyList()), "day", date, includeLearning = false, planning = history)
        assertTrue(markdown.contains("## 周计划历史"))
        assertFalse(markdown.lineSequence().any { it == "## $week" })
        assertTrue(markdown.contains("\\<b\\>计划\\<\\/b\\>"))
        assertTrue(markdown.contains("2026-11-15"))
        assertEquals(WeeklyPlanning.TextDifference("😀第", "1", "2", "天🙂"), WeeklyPlanning.compare("😀第1天🙂", "😀第2天🙂"))
    }

    @Test fun clearedLegacyRatingDoesNotBlockCloudButSavedPlansAndValidRatingsDo() = runBlocking {
        val session = RecordSandbox(folder.root, target(1), localOnly = true)
        var state = session.open()
        assertFalse(state.preview.retainsLocalPlanning())
        state = session.change(action("rate") { put("date", week); put("score", 4) }, state.revision)
        assertTrue(state.preview.retainsLocalPlanning())
        state = session.change(action("rate") { put("date", week); put("score", JsonNull) }, state.revision)
        assertEquals(2, state.preview.journal.records.size)
        assertFalse(state.preview.retainsLocalPlanning())
        assertTrue(state.preview.copy(view = null).retainsLocalPlanning())
        state = session.change(action("save") {
            put("week", week); put("versionId", id(8)); put("tips", JsonArray(emptyList())); put("reason", "")
            put("days", JsonArray(listOf("旧计划", "", "", "", "", "", "").map(::JsonPrimitive)))
        }, state.revision)
        assertTrue(state.preview.retainsLocalPlanning())
    }
}
