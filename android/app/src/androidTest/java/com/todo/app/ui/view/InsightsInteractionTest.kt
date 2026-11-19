package com.todo.app.ui.view

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.todo.app.data.model.WeeklyPlanning
import java.time.LocalDate
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class InsightsInteractionTest {
    @get:Rule val compose = createComposeRule()

    @Test fun planRefreshKeepsTheAdjacentInputAndOpensTheSelectedWeek() {
        val date = LocalDate.parse("2027-01-01")
        val snapshot = mutableStateOf(planForNewYear("周五原安排"))
        var openedWeek: String? = null
        compose.setContent {
            MaterialTheme {
                var draft by remember { mutableStateOf("") }
                val state = planningState(snapshot.value)
                Column {
                    DailyPlanReference(state, date) { openedWeek = WeeklyPlanning.monday(date.toString()) }
                    OutlinedTextField(draft, { draft = it }, placeholder = { androidx.compose.material3.Text("复盘草稿") })
                }
            }
        }
        compose.onNodeWithText("周五原安排").assertIsDisplayed()
        compose.onNodeWithText("复盘草稿").performTextInput("我的草稿")
        compose.runOnIdle { snapshot.value = planForNewYear("周五新安排") }
        compose.onNodeWithText("周五新安排").assertIsDisplayed()
        compose.onNodeWithText("我的草稿").assertTextEquals("我的草稿")
        compose.onNodeWithText("查看周计划").performClick()
        compose.runOnIdle { assertEquals("2026-12-28", openedWeek) }
    }

    @Test fun savedDailyRatingShowsOneReadOnlyNumber() {
        val date = LocalDate.parse("2027-01-01")
        val ratings = mutableStateOf(JsonArray(emptyList()))
        compose.setContent {
            MaterialTheme {
                Column {
                    DailyRating(planningState(buildJsonObject { put("daily_ratings", ratings.value) }), date)
                }
            }
        }
        compose.onNodeWithContentDescription("3 分").assertHasClickAction()
        compose.runOnIdle {
            ratings.value = buildJsonArray {
                add(buildJsonObject { put("date", date.toString()); put("score", 3) })
            }
        }
        compose.onNodeWithContentDescription("3 分").assertIsDisplayed().assertHasNoClickAction()
        compose.onNodeWithContentDescription("4 分").assertDoesNotExist()
        compose.onNodeWithText("3 / 5").assertDoesNotExist()
    }

    private fun planningState(data: JsonObject) = PersonalPlanningState("fixture" to null, data, false, false, false, "", null,
        change = { _, _, _ -> }, retry = {}, reload = {}, focusStatus = "enabled", canEnableFocus = false,
        cloudBacked = false, enableFocus = {}, pendingRating = false, saveRating = { _, _, _, _ -> RatingSaveResult() })

    private fun planForNewYear(text: String): JsonObject {
        val data = buildJsonObject { put("version", 1) }
        val action = buildJsonObject {
            put("kind", "save")
            put("week", "2026-12-28")
            put("versionId", "10000000-0000-4000-8000-000000000002")
            put("tips", JsonArray(emptyList()))
            put("days", JsonArray(List(7) { JsonPrimitive(if (it == 4) text else "") }))
            put("reason", "")
        }
        val operation = requireNotNull(WeeklyPlanning.change(data, action,
            "10000000-0000-4000-8000-000000000001", "2026-12-28T09:00:00Z"))
        return WeeklyPlanning.apply(data, listOf(operation))
    }
}
