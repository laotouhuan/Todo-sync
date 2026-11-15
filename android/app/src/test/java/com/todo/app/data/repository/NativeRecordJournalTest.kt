package com.todo.app.data.repository

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64

class NativeRecordJournalTest {
    @get:Rule val folder = TemporaryFolder()

    private fun fixture(): JournalState {
        val relative = "tests/fixtures/native-record-journal/business.json"
        val fixtureFile = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, relative) }.first { it.isFile }
        return Json.decodeFromString(fixtureFile.readText())
    }

    @Test fun recordsPendingAndBackupUnionSurviveNativeAtomicWrite() {
        val fixture = fixture()
        fixture.dependencies(fixture)
        val path = folder.newFile("journal.json")
        val backup = folder.newFile("backup.json")
        val writer = AtomicJsonFile(path)
        val original = fixture.copy(records = fixture.records.take(1))
        save(AtomicJsonFile(backup), original, fixture)
        save(writer, original, fixture)
        val updated = fixture.copy(pending = fixture.records.drop(1).map { it.name })

        val broken = AtomicJsonFile(path, writeTemporary = { temporary, _ ->
            temporary.writeText("半截内容")
            throw IOException("模拟刷盘失败")
        })
        assertTrue(runCatching { save(broken, updated, fixture) }.isFailure)
        assertEquals(original, load(path, fixture))
        save(writer, updated, fixture)

        val reopened = load(path, fixture).union(load(backup, fixture))
        assertEquals(updated, reopened)
        val name = reopened.pending.first()
        assertTrue(runCatching { reopened.acknowledge(name, "不同字节".encodeToByteArray()) }.isFailure)
        assertEquals(updated, load(path, fixture))
        save(writer, reopened.acknowledge(name, bytes(fixture.records[1].content)), fixture)
        assertEquals(updated.pending.drop(1), load(path, fixture).pending)
        assertEquals(fixture.records, load(path, fixture).records)
        assertTrue(runCatching { load(path, fixture.copy(descriptor_sha256 = "0".repeat(64))) }.isFailure)
        val corrupt = Json.decodeFromString<Envelope>(path.readText()).copy(sha256 = "0".repeat(64))
        path.writeText(Json.encodeToString(corrupt))
        assertTrue(runCatching { load(path, fixture) }.isFailure)
    }

    @Test fun childWaitsForExactParentAndOrdersBusinessRecordsDeterministically() {
        val fixture = fixture()
        val partial = fixture.copy(records = fixture.records.drop(1))
        assertEquals(JournalDependencies(listOf(fixture.records[1].name), listOf(fixture.records[0].name)),
            partial.dependencies(fixture))
        assertEquals(JournalDependencies(listOf(1, 0, 2).map { fixture.records[it].name }, emptyList()),
            partial.union(fixture).dependencies(fixture))

        val original = Json.parseToJsonElement(bytes(fixture.records[0].content).decodeToString()).jsonObject
        val changed = JsonObject(original + ("created_at" to JsonPrimitive("2026-11-07T05:00:00Z")))
        val raw = Json.encodeToString(changed).encodeToByteArray()
        val hash = MessageDigest.getInstance("SHA-256").digest(raw).joinToString("") { "%02x".format(it) }
        val changedArtifact = Artifact("records/${changed.getValue("id").jsonPrimitive.content}.$hash.json",
            Base64.getEncoder().encodeToString(raw))
        val wrong = fixture.copy(records = listOf(changedArtifact) + fixture.records.drop(1))
        assertEquals("RECORD_PARENT_HASH_CONFLICT", runCatching { wrong.dependencies(fixture) }.exceptionOrNull()?.message)
    }

    @Test fun matchingFilenameHashCannotBypassCanonicalEncoding() {
        val fixture = fixture()
        val original = fixture.records.first()
        val raw = " ".encodeToByteArray() + bytes(original.content)
        val hash = MessageDigest.getInstance("SHA-256").digest(raw).joinToString("") { "%02x".format(it) }
        val wrong = fixture.copy(records = listOf(Artifact(
            original.name.substringBefore('.') + ".$hash.json", Base64.getEncoder().encodeToString(raw)
        )))
        assertEquals("NON_CANONICAL_JSON", runCatching { wrong.dependencies(fixture) }.exceptionOrNull()?.message)
    }
}
