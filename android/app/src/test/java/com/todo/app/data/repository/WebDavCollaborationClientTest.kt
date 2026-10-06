package com.todo.app.data.repository

import com.todo.app.data.WebDavClient
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class WebDavCollaborationClientTest {
    @Test fun putFailureReportsPermissionStatusSeparately() = runBlocking {
        ServerSocket(0).use { server ->
            val executor = Executors.newSingleThreadExecutor()
            val received = executor.submit<String> {
                server.accept().use { socket ->
                    socket.soTimeout = 3000
                    val reader = socket.getInputStream().bufferedReader()
                    val method = reader.readLine()
                    while (!reader.readLine().isNullOrEmpty()) { }
                    socket.getOutputStream().write("HTTP/1.1 403 Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    method
                }
            }
            try {
                val client = WebDavClient("http://127.0.0.1:${server.localPort}/", "fake", "fake-password")
                val failure = runCatching { client.uploadCollaborationFile("todo_data.json", "{}") }.exceptionOrNull()
                assertTrue(failure is WebDavClient.CollaborationHttpException)
                assertEquals(403, (failure as WebDavClient.CollaborationHttpException).status)
                assertTrue(received.get(3, TimeUnit.SECONDS).startsWith("PUT /todo_data.json"))
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun coroutineCancellationClosesPendingHttpAndNeverCommits() = runBlocking {
        ServerSocket(0).use { server ->
            val accepted = CountDownLatch(1)
            val executor = Executors.newSingleThreadExecutor()
            val closed = executor.submit<Boolean> {
                server.accept().use { socket ->
                    socket.soTimeout = 3000
                    val reader = socket.getInputStream().bufferedReader()
                    while (!reader.readLine().isNullOrEmpty()) { }
                    accepted.countDown()
                    reader.read() == -1
                }
            }
            val client = WebDavClient("http://127.0.0.1:${server.localPort}/", "fake", "fake-password")
            val payload = com.todo.app.data.model.ShareCodePayload("https://example.test/", "fake", "fake-password", "todo_data.json")
            var committed = false
            val flow = CollaborationShareFlow { client.downloadCollaborationFile(it.path) }
            val job = launch(start = CoroutineStart.UNDISPATCHED) { flow.importValidated(payload) { committed = true } }
            try {
                assertTrue(accepted.await(3, TimeUnit.SECONDS))
                job.cancelAndJoin()
                assertFalse(committed)
                assertTrue(closed.get(3, TimeUnit.SECONDS))
            } finally {
                job.cancelAndJoin()
                executor.shutdownNow()
            }
        }
    }
}
