package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.recordsync.sha
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.util.Base64

class NativeRecordReplayTest {
    @Test fun replayMatchesSharedBusinessVectors() {
        replayFixture(readFixture("replay.json"), LEGACY_SERIES_OPERATION_SET)
    }

    @Test fun replayMatchesCausalSeriesVectors() {
        val fixture = readFixture("series-causal-replay.json")
        val descriptor = fixture.getValue("descriptor").jsonObject
        val bytes = Base64.getDecoder().decode(descriptor.getValue("content").jsonPrimitive.content)
        val pin = fixture.getValue("pin").jsonObject
        assertEquals(pin.getValue("descriptor_sha256").jsonPrimitive.content, sha(bytes))
        val set = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.getValue("operation_set").jsonPrimitive.content
        assertEquals(CAUSAL_SERIES_OPERATION_SET, set)
        replayFixture(fixture, set)
    }

    private fun readFixture(name: String): JsonObject {
        val path = "tests/fixtures/native-record-journal/$name"
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, path) }.first { it.isFile }
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun replayFixture(fixture: JsonObject, operationSet: String) {
        val baseline = fixture.getValue("baseline").jsonObject
        for (item in fixture.getValue("cases").jsonArray) {
            val row = item.jsonObject
            val name = row.getValue("name").jsonPrimitive.content
            val state = Json.decodeFromJsonElement<JournalState>(row.getValue("journal"))
            val fixed = state.copy(records = emptyList())
            val error = row["error"]?.jsonPrimitive?.content
            if (error != null) {
                val failure = runCatching { replayPersonalRecords(baseline, state, fixed, operationSet) }.exceptionOrNull()
                assertEquals(name, error, failure?.message)
            } else {
                val actual = replayPersonalRecords(baseline, state, fixed, operationSet)
                assertEquals(name, NormalTodoConflict.canonicalDigest(row.getValue("expected")), NormalTodoConflict.canonicalDigest(actual))
            }
        }
    }
}
