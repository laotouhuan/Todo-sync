package com.todo.app.data.repository

import com.todo.app.data.WebDavClient
import com.todo.app.data.WebDavHttpException
import com.todo.app.data.WebDavNetworkException
import com.todo.app.data.model.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch

class WebDavSyncTest {
    @get:Rule val folder = TemporaryFolder()
    private val stamp = "2026-10-08T08:00:00Z"
    private val todo = Todo.create("学习").copy(updatedAt = stamp, createdAt = stamp)
    private val data = TodoData(1, stamp, listOf(todo),
        reminderSettings = ReminderSettings(privacyMode = true),
        timeEntries = listOf(TimeEntry("entry", TaskReference(todo.id), stamp, stamp, stamp)),
        dailyReviews = listOf(DailyReview("review", "2026-10-08", stamp, stamp, fact = "复盘")))
    private fun store(): Pair<java.io.File, PersonalDataStore> {
        val file = folder.newFile().apply { writeText(Json.encodeToString(data)) }
        return file to PersonalDataStore(file)
    }

    private fun server(responses: List<Int>, body: String = "{}", action: (WebDavClient, MutableList<String>) -> Unit) {
        ServerSocket(0).use { server ->
            val requests = mutableListOf<String>()
            val executor = Executors.newSingleThreadExecutor()
            val worker = executor.submit {
                responses.forEach { status ->
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        val input = socket.getInputStream()
                        val headers = StringBuilder()
                        while (!headers.endsWith("\r\n\r\n")) {
                            val byte = input.read()
                            if (byte == -1) break
                            headers.append(byte.toChar())
                        }
                        requests.add(headers.toString().substringBefore("\r\n"))
                        val length = headers.lines().find { it.startsWith("Content-Length:", true) }
                            ?.substringAfter(':')?.trim()?.toInt() ?: 0
                        repeat(length) { input.read() }
                        socket.getOutputStream().write(("HTTP/1.1 $status Test\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n" + body).toByteArray())
                    }
                }
            }
            try {
                action(WebDavClient("http://127.0.0.1:${server.localPort}/", "fake", "fake-password"), requests)
                worker.get(5, TimeUnit.SECONDS)
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun personalReadKeepsHttpFailureInsteadOfTreatingItAsMissing() {
        server(listOf(401)) { client, requests -> runBlocking {
            val failure = runCatching { client.downloadFile("todo_data.json") }.exceptionOrNull()
            assertTrue("HTTP 失败必须保留为可识别的请求异常", failure is IOException)
            assertTrue(failure!!.message!!.contains("401"))
            assertFalse(failure.message!!.contains("对方"))
            assertEquals(listOf("GET /todo_data.json HTTP/1.1"), requests)
        } }
    }

    @Test fun failedGetNeverUploadsOrChangesLocalData() {
        for (status in listOf(401, 403, 500)) server(listOf(status)) { client, requests -> runBlocking {
            val (file, store) = store()
            val before = file.readBytes()
            val outcome = CloudSyncState().run(true) {
                PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                    { client.uploadFile("todo_data.json", it) }, {}, {})
            }
            assertTrue(outcome.isFailure)
            val error = outcome.error as WebDavHttpException
            assertEquals(status, error.status)
            assertEquals("GET", error.operation)
            assertEquals(1, requests.size)
            assertArrayEquals(before, file.readBytes())
        } }
    }

    @Test fun firstAndBackgroundUploadsCannotIgnoreHttpFailure() {
        for (status in listOf(401, 403, 500)) {
            server(listOf(404, status)) { client, requests -> runBlocking {
                val (file, store) = store()
                val before = file.readBytes()
                val outcome = CloudSyncState().run(true) {
                    PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                        { client.uploadFile("todo_data.json", it) }, {}, {})
                }
                assertTrue(outcome.isFailure)
                assertEquals("PUT", (outcome.error as WebDavHttpException).operation)
                assertEquals(2, requests.size)
                assertArrayEquals(before, file.readBytes())
            } }
            server(listOf(status)) { client, _ -> runBlocking {
                val (file, store) = store()
                val before = file.readBytes()
                val outcome = CloudSyncState().run(true) {
                    PersonalCloudSync(store).upload { client.uploadFile("todo_data.json", it) }
                }
                assertTrue(outcome.isFailure)
                assertArrayEquals(before, file.readBytes())
            } }
        }
    }

    @Test fun mergedLocalDataSurvivesFailedUploadWithAllExtensions() {
        val remoteTodo = Todo.create("远端任务").copy(updatedAt = stamp, createdAt = stamp)
        val cloud = data.copy(todos = listOf(remoteTodo))
        for (status in listOf(401, 403, 500)) server(listOf(200, status), Json.encodeToString(cloud)) { client, _ -> runBlocking {
            val (file, store) = store()
            var backups = 0
            val outcome = CloudSyncState().run(true) {
                PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                    { client.uploadFile("todo_data.json", it) }, { backups++ }, {})
            }
            assertTrue(outcome.isFailure)
            val saved = Json.decodeFromString<TodoData>(file.readText())
            assertEquals(setOf(todo.id, remoteTodo.id), saved.todos.map { it.id }.toSet())
            assertEquals(data.reminderSettings, saved.reminderSettings)
            assertEquals(data.timeEntries, saved.timeEntries)
            assertEquals(data.dailyReviews, saved.dailyReviews)
            assertEquals(1, backups)
        } }
    }

    @Test fun missingFileRequiresAccessibleParentAndOnlyReal404AllowsCreation() {
        for (parent in listOf(207, 404, 401, 500)) {
            server(if (parent == 207) listOf(404, parent, 201) else listOf(404, parent)) { client, requests -> runBlocking {
                val (_, store) = store()
                val outcome = CloudSyncState().run(true) {
                    PersonalCloudSync(store).synchronize({ client.downloadFile("folder/todo_data.json") },
                        { client.uploadFile("folder/todo_data.json", it) }, {}, {})
                }
                assertEquals(parent == 207, outcome.isSuccess)
                assertEquals(if (parent == 207) 3 else 2, requests.size)
                assertTrue(requests[1].startsWith("PROPFIND"))
                if (parent == 401 || parent == 500) {
                    val error = outcome.error as WebDavHttpException
                    assertEquals(parent, error.status)
                    assertEquals("PROPFIND", error.operation)
                }
                if (parent == 404) {
                    assertEquals(404, (outcome.error as WebDavHttpException).status)
                    assertTrue(outcome.error!!.message!!.contains("目录"))
                }
            } }
        }
    }

    @Test fun unchangedReadAndFirstUploadAreRealSuccess() {
        server(listOf(200), Json.encodeToString(data)) { client, requests -> runBlocking {
            val (_, store) = store()
            val outcome = CloudSyncState().run(true) {
                PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                    { client.uploadFile("todo_data.json", it) }, {}, {})
            }
            assertTrue(outcome.isSuccess)
            assertEquals(1, requests.size)
        } }
        server(listOf(404, 201)) { client, requests -> runBlocking {
            val (_, store) = store()
            assertTrue(CloudSyncState().run(true) {
                PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                    { client.uploadFile("todo_data.json", it) }, {}, {})
            }.isSuccess)
            assertEquals(2, requests.size)
        } }
    }

    @Test fun configurationFailureMakesWholeOperationFailAfterPersonalSuccess() {
        for (uploadFailure in listOf(false, true)) {
            server(if (uploadFailure) listOf(200, 404, 403) else listOf(200, 403), Json.encodeToString(data)) { client, requests -> runBlocking {
                val (_, store) = store()
                val configuration = CollaborationDataFile(folder.newFile())
                val result = CloudSyncState().run(true) {
                    syncPersonalAndConfiguration(
                        personal = { PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") }, { fail("无需上传") }, {}, {}) },
                        configuration = {
                            configuration.sync(
                                download = { client.downloadFile("collaborations.json")?.let { Json.decodeFromString<CollaborationData>(it) } },
                                upload = { client.uploadFile("collaborations.json", it) })
                        })
                }
                assertTrue(result.isFailure)
                assertFalse(result.showsSuccess("personal"))
                assertTrue(result.error!!.message!!.contains("个人待办已同步，协作配置同步失败"))
                val error = (result.error as PartialSyncException).failure as WebDavHttpException
                assertEquals(403, error.status)
                assertEquals(if (uploadFailure) "PUT" else "GET", error.operation)
                assertEquals(if (uploadFailure) 3 else 2, requests.size)
                assertEquals(data.timeEntries, store.data.value.timeEntries)
            } }
        }
        runBlocking {
            assertTrue(runCatching {
                syncPersonalAndConfiguration({}, { throw CancellationException() })
            }.exceptionOrNull() is CancellationException)
        }
    }

    @Test fun invalidServerAddressNeverAppearsWithCredentialsInError() = runBlocking {
        val failure = runCatching {
            WebDavClient("https://fake:fake-password@bad host/", "fake", "fake-password").downloadFile("todo_data.json")
        }.exceptionOrNull()!!
        assertTrue(failure is IOException)
        assertFalse(failure.message!!.contains("fake-password"))
        assertFalse(failure.message!!.contains("bad host"))
    }

    // 故意不响应请求，验证真实超时和取消；服务器等客户端断开后才结束。
    private fun stalledServer(firstResponse: Pair<Int, String>? = null, timeout: Long = 300,
        action: (WebDavClient, CountDownLatch, MutableList<String>) -> Unit) {
        ServerSocket(0).use { server ->
            val requests = mutableListOf<String>()
            val arrived = CountDownLatch(1)
            val executor = Executors.newSingleThreadExecutor()
            val worker = executor.submit {
                repeat(if (firstResponse != null) 2 else 1) { index ->
                    server.accept().use { socket ->
                        socket.soTimeout = 3000
                        val input = socket.getInputStream()
                        val headers = StringBuilder()
                        while (!headers.endsWith("\r\n\r\n")) {
                            val byte = input.read()
                            if (byte == -1) break
                            headers.append(byte.toChar())
                        }
                        requests.add(headers.toString().substringBefore("\r\n"))
                        val length = headers.lines().find { it.startsWith("Content-Length:", true) }
                            ?.substringAfter(':')?.trim()?.toInt() ?: 0
                        repeat(length) { input.read() }
                        if (firstResponse != null && index == 0) {
                            val (status, body) = firstResponse
                            socket.getOutputStream().write(("HTTP/1.1 $status Test\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n" + body).toByteArray())
                        } else {
                            arrived.countDown()
                            assertEquals("取消或超时应断开 HTTP 请求", -1, input.read())
                        }
                    }
                }
            }
            val http = OkHttpClient.Builder().callTimeout(timeout, TimeUnit.MILLISECONDS).retryOnConnectionFailure(false).build()
            try {
                action(WebDavClient("http://127.0.0.1:${server.localPort}/", "fake", "fake-password", http), arrived, requests)
                worker.get(5, TimeUnit.SECONDS)
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun timedOutGetAndParentCheckNeverBecomeFirstUpload() {
        for (parent in listOf(false, true)) stalledServer(firstResponse = if (parent) 404 to "" else null) { client, _, requests -> runBlocking {
            val (file, store) = store()
            val before = file.readBytes()
            val state = CloudSyncState()
            val result = state.run(true) {
                PersonalCloudSync(store).synchronize({ client.downloadFile(if (parent) "folder/todo_data.json" else "todo_data.json") },
                    { client.uploadFile("todo_data.json", it) }, {}, {})
            }
            assertTrue(result.isFailure)
            assertTrue(result.error is WebDavNetworkException)
            assertEquals(if (parent) "PROPFIND" else "GET", (result.error as WebDavNetworkException).operation)
            assertFalse(requests.any { it.startsWith("PUT") })
            assertArrayEquals(before, file.readBytes())
        } }
    }

    @Test fun timedOutBackgroundUploadKeepsLocalDataAndFailureState() {
        stalledServer { client, _, _ -> runBlocking {
            val (file, store) = store()
            val before = file.readBytes()
            val state = CloudSyncState()
            val result = state.run(true) { PersonalCloudSync(store).upload { client.uploadFile("todo_data.json", it) } }
            assertTrue(result.isFailure)
            assertEquals("PUT", (result.error as WebDavNetworkException).operation)
            assertArrayEquals(before, file.readBytes())
            assertFalse(state.syncing.value)
        } }
    }

    @Test fun timedOutFirstAndMergedUploadsCannotBecomeSuccess() {
        val remote = Todo.create("远端任务").copy(createdAt = stamp, updatedAt = stamp)
        val cloud = data.copy(todos = listOf(remote))
        for (missing in listOf(true, false)) {
            stalledServer(firstResponse = if (missing) 404 to "" else 200 to Json.encodeToString(cloud)) { client, _, requests -> runBlocking {
                val (file, store) = store()
                val result = CloudSyncState().run(true) {
                    PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                        { client.uploadFile("todo_data.json", it) }, {}, {})
                }
                assertTrue(result.isFailure)
                assertEquals("PUT", (result.error as WebDavNetworkException).operation)
                assertEquals(listOf("GET", "PUT"), requests.map { it.substringBefore(' ') })
                val saved = Json.decodeFromString<TodoData>(file.readText())
                assertEquals(data.timeEntries, saved.timeEntries)
                assertEquals(data.dailyReviews, saved.dailyReviews)
                assertEquals(data.reminderSettings, saved.reminderSettings)
                assertEquals(if (missing) setOf(todo.id) else setOf(todo.id, remote.id), saved.todos.map { it.id }.toSet())
            } }
        }
    }

    @Test fun mergedUploadSuccessPublishesFullLocalDataAfterBackup() {
        val remote = Todo.create("远端任务").copy(createdAt = stamp, updatedAt = stamp)
        server(listOf(200, 201), Json.encodeToString(data.copy(todos = listOf(remote)))) { client, requests -> runBlocking {
            val (file, store) = store()
            var backedUp = false
            assertTrue(CloudSyncState().run(true) {
                PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                    { client.uploadFile("todo_data.json", it) }, { backedUp = true }, { assertTrue(backedUp) })
            }.isSuccess)
            assertEquals(setOf(todo.id, remote.id), Json.decodeFromString<TodoData>(file.readText()).todos.map { it.id }.toSet())
            assertEquals(2, requests.size)
        } }
    }

    @Test fun cancellingPersonalReadCancelsHttpAndPropagatesWithoutSuccess() {
        stalledServer(timeout = 3000) { client, arrived, requests -> runBlocking {
            val (_, store) = store()
            val state = CloudSyncState()
            val job = async {
                state.run(true) {
                    PersonalCloudSync(store).synchronize({ client.downloadFile("todo_data.json") },
                        { client.uploadFile("todo_data.json", it) }, {}, {})
                }
            }
            withContext(Dispatchers.IO) { assertTrue(arrived.await(2, TimeUnit.SECONDS)) }
            job.cancel()
            assertTrue(runCatching { job.await() }.exceptionOrNull() is CancellationException)
            assertEquals(SyncPhase.CANCELLED, state.outcome.value.phase)
            assertFalse(state.syncing.value)
            assertEquals(1, requests.size)
        } }
    }
}
