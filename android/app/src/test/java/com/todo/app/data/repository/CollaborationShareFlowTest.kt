package com.todo.app.data.repository

import com.todo.app.data.WebDavClient
import com.todo.app.data.model.ShareCodePayload
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CollaborationShareFlowTest {
    private val payload = ShareCodePayload("https://example.test/dav/", "fake", " fake-password ", "清单/todo_data.json")

    // 实际 HTTP 响应穿过生产客户端，再到生成/导入编排；只使用虚构凭据。
    private fun withServer(status: Int, body: String = "{\"version\":1,\"last_updated\":\"2026-10-06T00:00:00Z\",\"todos\":[]}", date: String? = null,
        action: (CollaborationShareFlow, MutableList<String>) -> Unit) {
        ServerSocket(0).use { server ->
            val requests = mutableListOf<String>()
            val executor = Executors.newSingleThreadExecutor()
            val worker = executor.submit {
                repeat(2) {
                    server.accept().use { socket ->
                        val reader = socket.getInputStream().bufferedReader()
                        val lines = mutableListOf<String>()
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            lines.add(line)
                        }
                        synchronized(requests) { requests.add(lines.joinToString("\n")) }
                        val headers = "HTTP/1.1 $status Test\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n" +
                            (date?.let { "Date: $it\r\n" } ?: "") +
                            (if (status in 300..399) "Location: https://other.test/leak\r\n" else "")
                        socket.getOutputStream().write((headers + "\r\n" + body).toByteArray())
                    }
                }
            }
            val client = OkHttpClient.Builder().addInterceptor { chain ->
                chain.proceed(chain.request().newBuilder().url("http://127.0.0.1:${server.localPort}/todo_data.json").build())
            }.build()
            val flow = CollaborationShareFlow { p -> WebDavClient(p.url, p.user, p.pass, client).downloadCollaborationFile(p.path) }
            try { action(flow, requests) } finally {
                server.close()
                executor.shutdownNow()
                executor.awaitTermination(2, TimeUnit.SECONDS)
                worker.cancel(true)
            }
        }
    }

    @Test fun rejectedHttpNeverGeneratesOrCommitsAndPreservesExistingPassword() {
        for (status in listOf(401, 403, 404, 302)) withServer(status) { flow, requests -> runBlocking {
            var encrypted = false
            var password = "existing"
            val generation = runCatching { flow.generate(payload, { true }) { encrypted = true } }
            val imported = runCatching { flow.importValidated(payload) { password = payload.pass } }
            assertTrue(generation.isFailure)
            assertTrue(imported.isFailure)
            assertFalse(encrypted)
            assertEquals("existing", password)
            if (status == 401) assertTrue(imported.exceptionOrNull()!!.message!!.contains("401"))
            assertEquals(2, requests.size)
        } }
    }

    @Test fun generatingOwnCodeAndImportingUseDifferentErrorContexts() {
        for (status in listOf(401, 403, 404)) withServer(status) { flow, requests -> runBlocking {
            val generated = runCatching { flow.generate(payload, { true }) { it } }.exceptionOrNull()!!
            val imported = runCatching { flow.importValidated(payload) { payload } }.exceptionOrNull()!!
            assertTrue(generated.message!!.contains("你的"))
            assertFalse(generated.message!!.contains("分享者"))
            assertTrue(imported.message!!.contains("分享者"))
            assertTrue(generated.message!!.contains(status.toString()))
            assertTrue(imported.message!!.contains(status.toString()))
            assertFalse(generated.message!!.contains(payload.pass))
            val auth = requests.map { request -> request.lines().first { it.startsWith("Authorization:", true) } }
            assertEquals(auth[0], auth[1])
        } }
    }

    @Test fun malformedFileUsesCorrectOwner() {
        withServer(200, "{broken") { flow, _ -> runBlocking {
            val own = runCatching { flow.generate(payload, { true }) { it } }.exceptionOrNull()!!
            val shared = runCatching { flow.importValidated(payload) { payload } }.exceptionOrNull()!!
            assertTrue(own.message!!.contains("你的待办文件格式无效"))
            assertTrue(shared.message!!.contains("分享者待办文件格式无效"))
        } }
    }

    @Test fun validDataGeneratesSameSnapshotAndReimportsWithoutDuplicate() {
        withServer(200) { flow, requests -> runBlocking {
            assertEquals(payload, flow.generate(payload, { true }) { it })
            val file = kotlin.io.path.createTempDirectory("collab-flow").toFile().resolve("collaborations.json")
            try {
                val store = CollaborationDataFile(file)
                val original = store.importSource(payload.copy(pass = "old"), "old", {}).getOrThrow()
                val updated = flow.importValidated(payload) { store.importSource(payload, "new", {}).getOrThrow() }
                assertEquals(original.id, updated.id)
                assertEquals(payload.pass, updated.webdavPassword)
                assertEquals(1, store.collaborations.value.size)
                assertTrue(requests.all { it.contains(okhttp3.Credentials.basic(payload.user, payload.pass)) })
            } finally { file.parentFile!!.deleteRecursively() }
        } }
    }

    @Test fun invalidDataAndMissingServerTimeNeverCommit() {
        for (body in listOf("broken", "{}", "{\"todos\":[{}]}")) withServer(200, body) { flow, _ -> runBlocking {
            var committed = false
            assertTrue(runCatching { flow.importValidated(payload) { committed = true } }.isFailure)
            assertFalse(committed)
        } }
        withServer(200) { flow, _ -> runBlocking {
            assertTrue(runCatching { flow.importValidated(payload.copy(exp = 1)) { fail("must not commit") } }.isFailure)
        } }
    }

    @Test fun configurationChangeDiscardsVerifiedGeneration() {
        withServer(200) { flow, _ -> runBlocking {
            var encrypted = false
            assertTrue(runCatching { flow.generate(payload, { false }) { encrypted = true } }.isFailure)
            assertFalse(encrypted)
        } }
    }

    @Test fun malformedPayloadFailsBeforeHttp() = runBlocking {
        var requested = false
        val flow = CollaborationShareFlow { requested = true; error("must not request") }
        for (p in listOf(payload.copy(url = "http://example.test/"), payload.copy(user = " "),
            payload.copy(pass = " "), payload.copy(path = "../todo_data.json"), payload.copy(exp = -1))) {
            assertTrue(runCatching { flow.importValidated(p) { fail("must not commit") } }.isFailure)
        }
        assertFalse(requested)
    }
}
