package com.todo.app.data.repository

import com.todo.app.data.model.CollaborationData
import com.todo.app.data.model.CollaborationSource
import com.todo.app.data.model.ShareCodePayload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class CollaborationDataFileTest {
    @get:Rule val folder = TemporaryFolder()
    private val timestamp = "2026-09-26T08:00:00Z"
    private val previousTimestamp = "2026-09-25T08:00:00Z"

    private fun source(id: String, deleted: Boolean = false) = CollaborationSource(
        id = id, name = "清单 $id", webdavUrl = "https://example.invalid/dav/",
        webdavUsername = "test-user", webdavPassword = "test-password",
        webdavFilepath = "$id/todos.json", updatedAt = previousTimestamp, deleted = deleted
    )

    private fun payload(source: CollaborationSource) = ShareCodePayload(
        url = source.webdavUrl, user = source.webdavUsername, pass = "updated-password",
        path = source.webdavFilepath, exp = 1800000000L
    )

    private enum class FailureStage { TEMPORARY_WRITE, REPLACEMENT }

    private inner class Scenario(initial: CollaborationData, val stage: FailureStage) {
        val file = File(folder.newFolder(), "collaborations.json").apply {
            writeText(Json.encodeToString(initial))
        }
        var failure: Exception? = null
        var writeAttempts = 0
        var legacyPreferences = emptyList<CollaborationSource>()
        var legacyClears = 0
        var queuedSyncs = 0
        var downloads = 0
        val uploaded = mutableListOf<String>()
        val readErrors = mutableListOf<Exception>()
        val store = CollaborationDataFile(file, AtomicJsonFile(
            file,
            writeTemporary = { temporary, content ->
                writeAttempts++
                temporary.writeText(content)
                if (stage == FailureStage.TEMPORARY_WRITE) failure?.let { throw it }
            },
            replace = { temporary, destination ->
                if (stage == FailureStage.REPLACEMENT) failure?.let { throw it }
                Files.move(temporary.toPath(), destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            }
        ), now = { timestamp })

        init { load() }

        fun load() = store.load(
            legacySources = legacyPreferences,
            clearLegacySources = { legacyPreferences = emptyList(); legacyClears++ },
            onReadFailure = { readErrors.add(it) }
        )

        fun enqueueSync() {
            // 队列边界只记录请求；业务代码负责写盘和发布真实 StateFlow。
            assertEquals(read().collaborations.filterNot { it.deleted }, store.collaborations.value)
            queuedSyncs++
        }

        suspend fun sync(cloud: CollaborationData?) = store.sync(
            download = { downloads++; cloud },
            upload = { content ->
                val shared = Json.decodeFromString<CollaborationData>(content)
                assertTrue(shared.collaborations.all { it.webdavPassword.isEmpty() })
                uploaded.add(content)
            }
        )

        fun read(): CollaborationData = Json.decodeFromString(file.readText())

        fun assertUnchanged(bytes: ByteArray, visible: List<CollaborationSource>) {
            assertArrayEquals(bytes, file.readBytes())
            assertEquals(visible, store.collaborations.value)
            assertEquals(0, queuedSyncs)
            assertTrue(uploaded.isEmpty())
            assertFalse(file.parentFile!!.listFiles()!!.any { it.extension == "tmp" })
        }
    }

    @Test fun migrationFailureRetainsPreferencesAndRetryDoesNotDuplicateSources() {
        for (stage in FailureStage.values()) {
            val existing = source("existing", deleted = true)
            val legacy = source("legacy", deleted = true)
            val scenario = Scenario(CollaborationData(collaborations = listOf(existing)), stage)
            val original = scenario.file.readBytes()
            val visible = scenario.store.collaborations.value
            // 同 ID 的旧偏好不能覆盖文件中的删除标记；重复旧记录只能迁移一次。
            val oldPreferences = listOf(existing.copy(deleted = false), legacy, legacy)
            scenario.legacyPreferences = oldPreferences
            val failure = IOException("模拟 $stage 失败")
            scenario.failure = failure

            assertSame(failure, runCatching { scenario.load() }.exceptionOrNull())
            scenario.assertUnchanged(original, visible)
            assertEquals(oldPreferences, scenario.legacyPreferences)
            assertEquals(0, scenario.legacyClears)

            scenario.failure = null
            scenario.load()
            val expected = listOf(existing, legacy.copy(updatedAt = timestamp, deleted = false))
            assertEquals(expected, scenario.read().collaborations)
            assertEquals(listOf(expected.last()), scenario.store.collaborations.value)
            assertTrue(scenario.legacyPreferences.isEmpty())
            assertEquals(1, scenario.legacyClears)
            val attempts = scenario.writeAttempts
            scenario.load()
            assertEquals(attempts, scenario.writeAttempts)
            assertEquals(expected, scenario.read().collaborations)

            // 模拟文件已提交、旧偏好清理尚未持久化时重启，重放迁移仍不得重复。
            scenario.legacyPreferences = oldPreferences
            scenario.load()
            assertEquals(expected, scenario.read().collaborations)
            assertTrue(scenario.legacyPreferences.isEmpty())
            assertTrue(scenario.readErrors.isEmpty())
        }
    }

    @Test fun importFailureReturnsFailureWithoutPublishingOrQueueingAndCanRetry() {
        for (stage in FailureStage.values()) {
            for (alreadyImported in listOf(false, true)) {
                val existing = source("existing")
                val imported = source("imported", deleted = true)
                val sources = if (alreadyImported) listOf(existing, imported) else listOf(existing)
                val scenario = Scenario(CollaborationData(collaborations = sources), stage)
                val original = scenario.file.readBytes()
                val visible = scenario.store.collaborations.value
                val failure = IOException("模拟 $stage 失败")
                scenario.failure = failure

                val result = scenario.store.importSource(payload(imported), "新名称", scenario::enqueueSync)
                assertSame(failure, result.exceptionOrNull())
                scenario.assertUnchanged(original, visible)

                scenario.failure = null
                val saved = scenario.store.importSource(payload(imported), "新名称", scenario::enqueueSync).getOrThrow()
                if (alreadyImported) assertEquals(imported.id, saved.id)
                assertEquals("新名称", saved.name)
                assertEquals("updated-password", saved.webdavPassword)
                assertEquals(1800000000L, saved.expireAt)
                assertEquals(timestamp, saved.updatedAt)
                assertFalse(saved.deleted)
                assertEquals(listOf(existing, saved), scenario.read().collaborations)
                assertEquals(listOf(existing, saved), scenario.store.collaborations.value)
                assertEquals(1, scenario.queuedSyncs)
            }
        }
    }

    @Test fun deleteFailureReturnsFailureWithoutPublishingOrQueueingAndCanRetry() {
        for (stage in FailureStage.values()) {
            val removed = source("removed")
            val retained = source("retained")
            val scenario = Scenario(CollaborationData(collaborations = listOf(removed, retained)), stage)
            val original = scenario.file.readBytes()
            val visible = scenario.store.collaborations.value
            val failure = IOException("模拟 $stage 失败")
            scenario.failure = failure

            val result = scenario.store.deleteSource(removed.id, scenario::enqueueSync)
            assertSame(failure, result.exceptionOrNull())
            scenario.assertUnchanged(original, visible)

            scenario.failure = null
            scenario.store.deleteSource(removed.id, scenario::enqueueSync).getOrThrow()
            assertEquals(listOf(removed.copy(deleted = true, updatedAt = timestamp), retained), scenario.read().collaborations)
            assertEquals(listOf(retained), scenario.store.collaborations.value)
            assertEquals(1, scenario.queuedSyncs)
        }
    }

    @Test fun mergedSyncFailureDoesNotPublishOrUploadAndCanRetry() = runBlocking {
        for (stage in FailureStage.values()) {
            val local = source("local")
            val cloudOnly = source("cloud")
            val cloudDeleted = local.copy(deleted = true, updatedAt = timestamp)
            val cloud = CollaborationData(collaborations = listOf(cloudDeleted, cloudOnly))
            val scenario = Scenario(CollaborationData(collaborations = listOf(local)), stage)
            val original = scenario.file.readBytes()
            val visible = scenario.store.collaborations.value
            val failure = IOException("模拟 $stage 失败")
            scenario.failure = failure

            assertSame(failure, runCatching { scenario.sync(cloud) }.exceptionOrNull())
            scenario.assertUnchanged(original, visible)
            assertEquals(1, scenario.downloads)

            scenario.failure = null
            scenario.sync(cloud)
            val expected = CollaborationData(lastUpdated = timestamp, collaborations = listOf(cloudDeleted, cloudOnly.copy(webdavPassword = "")))
            assertEquals(expected, scenario.read())
            assertEquals(listOf(cloudOnly.copy(webdavPassword = "")), scenario.store.collaborations.value)
            assertEquals(1, scenario.uploaded.size)
            assertEquals(expected.copy(collaborations = expected.collaborations.map { it.copy(webdavPassword = "") }),
                Json.decodeFromString<CollaborationData>(scenario.uploaded.single()))
        }
    }

    @Test fun unchangedSyncKeepsLocalTieAndDoesNotWriteOrUpload() = runBlocking {
        val local = source("same")
        val data = CollaborationData(lastUpdated = previousTimestamp, collaborations = listOf(local))
        val scenario = Scenario(data, FailureStage.TEMPORARY_WRITE)
        val original = scenario.file.readBytes()
        scenario.failure = IOException("不应写入")

        scenario.sync(data.copy(collaborations = listOf(local.copy(name = "云端同时间戳", webdavPassword = ""))))

        scenario.assertUnchanged(original, listOf(local))
        assertEquals(0, scenario.writeAttempts)
    }

    @Test fun initialUploadAndUnchangedLegacyCloudNeverExportPasswords() = runBlocking {
        val active = source("active")
        val deleted = source("deleted", deleted = true)
        val data = CollaborationData(lastUpdated = previousTimestamp, collaborations = listOf(active, deleted))
        val scenario = Scenario(data, FailureStage.TEMPORARY_WRITE)
        scenario.sync(null)
        scenario.sync(data)
        assertEquals(2, scenario.uploaded.size)
        assertTrue(scenario.uploaded.none { it.contains("test-password") })
        assertEquals(data, scenario.read())
        assertEquals(listOf(active), scenario.store.collaborations.value)
    }

    @Test fun newerCloudMetadataPreservesOnlyCredentialsForTheSameTarget() = runBlocking {
        val local = source("same")
        for (cloud in listOf(
            local.copy(name = "新名称", updatedAt = timestamp, webdavPassword = "untrusted-password"),
            local.copy(webdavUrl = "https://other.invalid/", updatedAt = timestamp),
            local.copy(webdavUsername = "other-user", updatedAt = timestamp),
            local.copy(webdavFilepath = "other.json", updatedAt = timestamp)
        )) {
            val scenario = Scenario(CollaborationData(collaborations = listOf(local)), FailureStage.TEMPORARY_WRITE)
            scenario.sync(CollaborationData(collaborations = listOf(cloud)))
            val expected = if (cloud.name == "新名称") local.webdavPassword else ""
            assertEquals(expected, scenario.read().collaborations.single().webdavPassword)
            assertFalse(scenario.uploaded.single().contains("test-password"))
            assertFalse(scenario.uploaded.single().contains("untrusted-password"))
        }
    }

    @Test fun newDeviceNeedsImportAndUploadFailureCanRetryWithoutLosingLocalPassword() = runBlocking {
        val cloudOnly = source("cloud")
        val scenario = Scenario(CollaborationData(), FailureStage.TEMPORARY_WRITE)
        scenario.sync(CollaborationData(collaborations = listOf(cloudOnly)))
        assertEquals("", scenario.read().collaborations.single().webdavPassword)
        val imported = scenario.store.importSource(payload(cloudOnly), "已授权", scenario::enqueueSync).getOrThrow()
        assertEquals(cloudOnly.id, imported.id)
        val failure = IOException("模拟上传失败")
        assertSame(failure, runCatching {
            scenario.store.sync(download = { null }, upload = { throw failure })
        }.exceptionOrNull())
        assertEquals("updated-password", scenario.read().collaborations.single().webdavPassword)
        scenario.sync(null)
        assertFalse(scenario.uploaded.last().contains("updated-password"))
    }

    @Test fun unreadableFileStopsMutationAndSyncBeforeSideEffects() = runBlocking {
        val target = folder.newFolder("collaborations.json")
        val store = CollaborationDataFile(target)
        val errors = mutableListOf<Exception>()
        var queued = 0
        var downloads = 0
        var uploads = 0

        store.load(emptyList(), { fail("无旧偏好时不能清空") }, { errors.add(it) })
        assertEquals(1, errors.size)
        assertTrue(store.collaborations.value.isEmpty())
        assertTrue(store.importSource(payload(source("new")), "新清单") { queued++ }.isFailure)
        assertTrue(store.deleteSource("new") { queued++ }.isFailure)
        assertTrue(runCatching {
            store.sync(download = { downloads++; null }, upload = { uploads++ })
        }.isFailure)
        assertEquals(0, queued)
        assertEquals(0, downloads)
        assertEquals(0, uploads)
        assertTrue(target.isDirectory)
    }

    @Test fun commitCancellationPropagatesFromEveryBusinessEntry() = runBlocking {
        for (operation in listOf("migration", "import", "delete", "sync")) {
            val existing = source("existing")
            val scenario = Scenario(CollaborationData(collaborations = listOf(existing)), FailureStage.REPLACEMENT)
            val original = scenario.file.readBytes()
            val visible = scenario.store.collaborations.value
            val legacy = listOf(source("legacy"))
            scenario.legacyPreferences = legacy
            val cancellation = CancellationException("取消 $operation")
            scenario.failure = cancellation

            val thrown = runCatching {
                when (operation) {
                    "migration" -> scenario.load()
                    "import" -> scenario.store.importSource(payload(source("new")), "新清单", scenario::enqueueSync)
                    "delete" -> scenario.store.deleteSource(existing.id, scenario::enqueueSync)
                    else -> scenario.sync(CollaborationData(collaborations = listOf(source("cloud"))))
                }
            }.exceptionOrNull()

            assertSame(cancellation, thrown)
            scenario.assertUnchanged(original, visible)
            assertEquals(legacy, scenario.legacyPreferences)
            assertEquals(0, scenario.legacyClears)
        }
    }

    @Test fun cancelledDownloadDoesNotCommitOrPublish() = runBlocking {
        val existing = source("existing")
        val scenario = Scenario(CollaborationData(collaborations = listOf(existing)), FailureStage.REPLACEMENT)
        val original = scenario.file.readBytes()
        val cancellation = CancellationException("下载取消")

        assertSame(cancellation, runCatching {
            scenario.store.sync(download = { throw cancellation }, upload = { fail("取消后不能上传") })
        }.exceptionOrNull())

        scenario.assertUnchanged(original, listOf(existing))
        assertEquals(0, scenario.writeAttempts)
    }
}
