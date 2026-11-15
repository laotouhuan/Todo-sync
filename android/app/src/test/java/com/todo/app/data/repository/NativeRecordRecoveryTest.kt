package com.todo.app.data.repository

import com.todo.app.data.model.NormalTodoConflict
import com.todo.app.data.recordsync.canonical
import com.todo.app.data.recordsync.parse
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Base64
import java.util.UUID
import okhttp3.ResponseBody.Companion.toResponseBody

class NativeRecordRecoveryTest {
    @Test fun backgroundRecordSyncStopsAfterIntegrityFailure() = runBlocking {
        var runs = 0
        var reported: String? = null
        val job = startRecordSync(1, sync = {
            runs++
            throw RecordTransportIntegrityException("blocked")
        }, onResult = { error("失败不发布视图") }, onError = { reported = it.message })
        kotlinx.coroutines.withTimeout(2000) { job.join() }
        assertEquals("blocked", reported)
        assertEquals(1, runs)
    }

    @get:Rule val folder = TemporaryFolder()

    private val fixture by lazy {
        val relative = "tests/fixtures/native-record-journal/series-causal-replay.json"
        val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, relative) }.first { it.isFile }
        Json.parseToJsonElement(file.readText()).jsonObject
    }
    private val pin by lazy { Json.decodeFromJsonElement<RecordDatasetPin>(fixture.getValue("pin")) }
    private val descriptor by lazy { fixture.getValue("descriptor").jsonObject.getValue("content").jsonPrimitive.content }
    private val baseline by lazy {
        val fields = fixture.getValue("pin").jsonObject.filterKeys { it in setOf("protocol", "dataset_id") }
        val raw = JsonObject(fields + ("data" to fixture.getValue("baseline"))).toString().encodeToByteArray()
        Base64.getEncoder().encodeToString(canonical(parse(raw, strict = false)))
    }
    private val sample by lazy { fixture.getValue("cases").jsonArray.first().jsonObject }
    private val complete by lazy { Json.decodeFromJsonElement<JournalState>(sample.getValue("journal")) }

    @Test fun resumesFromJournalAndBackupOnlyAfterExactParentArrives() {
        val child = complete.records[0]
        val parent = complete.records[1]
        val partial = previewRecordRecovery(pin, descriptor, baseline, received = listOf(child))
        assertEquals(listOf(parent.name), partial.missing)
        assertNull(partial.view)
        val current = folder.newFile("current.json")
        save(AtomicJsonFile(current), partial.journal, complete)
        val backup = folder.newFile("backup.json")
        save(AtomicJsonFile(backup), complete.copy(records = listOf(parent), pending = listOf(parent.name)), complete)

        val recovered = previewRecordRecovery(pin, descriptor, baseline, current.readText(), backup.readText(), listOf(child))
        assertEquals(emptyList<String>(), recovered.missing)
        assertEquals(complete.records, recovered.journal.records)
        assertEquals(listOf(parent.name), recovered.journal.pending)
        assertEquals(NormalTodoConflict.canonicalDigest(sample.getValue("expected")),
            NormalTodoConflict.canonicalDigest(requireNotNull(recovered.view)))
    }

    @Test fun rejectsChangedSnapshotAndUnrelatedBackup() {
        val changed = Base64.getEncoder().encodeToString("{}".encodeToByteArray())
        assertEquals("DATASET_HASH_MISMATCH", runCatching {
            previewRecordRecovery(pin, descriptor, changed)
        }.exceptionOrNull()?.message)
        val other = complete.copy(dataset_id = UUID.randomUUID().toString(), records = emptyList())
        val backup = folder.newFile("other.json")
        save(AtomicJsonFile(backup), other, other)
        assertEquals("RECORD_TARGET_MISMATCH", runCatching {
            previewRecordRecovery(pin, descriptor, baseline, backup = backup.readText())
        }.exceptionOrNull()?.message)
    }

    @Test fun durableStoreReopensPartialLogAndRejectsStaleOrChangedCandidate() {
        val child = RecordRecoveryInput(pin, descriptor, baseline, received = listOf(complete.records[0]))
        val parent = child.copy(received = listOf(complete.records[1]))
        val store = RecordRecoveryStore(folder.root)
        val stagedChild = store.prepare(child)
        val staleParent = store.prepare(parent)
        assertNull(stagedChild.preview.view)
        assertEquals("RECORD_RECOVERY_PREVIEW_STALE", runCatching {
            store.commit(parent, stagedChild.receipt)
        }.exceptionOrNull()?.message)
        store.commit(child, stagedChild.receipt)

        val reopened = RecordRecoveryStore(folder.root)
        assertEquals("RECORD_RECOVERY_PREVIEW_STALE", runCatching {
            reopened.commit(parent, staleParent.receipt)
        }.exceptionOrNull()?.message)
        val resumed = reopened.prepare(parent)
        val view = reopened.commit(parent, resumed.receipt).view
        assertEquals(NormalTodoConflict.canonicalDigest(sample.getValue("expected")),
            NormalTodoConflict.canonicalDigest(requireNotNull(view)))
        val duplicate = reopened.prepare(child)
        assertEquals(duplicate.receipt.previousSha256, duplicate.receipt.candidateSha256)
        assertEquals(complete, reopened.commit(child, duplicate.receipt).journal)
    }

    @Test fun localIntentKeepsExactRecordBytesAndPendingQueueAcrossRestart() {
        val input = RecordRecoveryInput(pin, descriptor, baseline)
        val (child, parent) = complete.records
        val store = RecordRecoveryStore(folder.root)
        val first = intentFor(parent, store.prepare(input).receipt.previousSha256)
        val saved = store.submitLocal(input, first)
        assertEquals(parent, saved.preview.submitted)
        val reopened = RecordRecoveryStore(folder.root)
        assertEquals(saved.revision, reopened.prepare(input).receipt.previousSha256)
        assertEquals("RECORD_WRITE_STALE", runCatching {
            reopened.submitLocal(input, intentFor(child, null))
        }.exceptionOrNull()?.message)
        assertEquals(child, reopened.submitLocal(input, intentFor(child, saved.revision)).preview.submitted)
        val retried = reopened.submitLocal(input, first).preview
        assertEquals(parent, retried.submitted)
        assertEquals(listOf(parent, child), retried.journal.records)
        assertEquals(listOf(parent.name, child.name), retried.journal.pending)
        assertEquals("RECORD_ID_CONTENT_CONFLICT", runCatching {
            reopened.submitLocal(input, first.copy(createdAt = "2026-11-12T03:00:00Z"))
        }.exceptionOrNull()?.message)
    }

    @Test fun invalidOperationAndMissingDependencyCannotQueueLocalWrites() {
        val input = RecordRecoveryInput(pin, descriptor, baseline)
        val (child, parent) = complete.records
        val store = RecordRecoveryStore(folder.root)
        val first = intentFor(parent, null)
        val invalid = first.copy(operations = listOf(JsonObject(mapOf("type" to JsonPrimitive("unsupported.op")))))
        assertEquals("UNSUPPORTED_RECORD_OPERATION", runCatching {
            store.submitLocal(input, invalid)
        }.exceptionOrNull()?.message)
        assertEquals(emptyList<Artifact>(), store.prepare(input).preview.journal.records)
        val partial = input.copy(received = listOf(child))
        store.commit(partial, store.prepare(partial).receipt)
        val incomplete = store.prepare(input)
        assertEquals("RECORD_DEPENDENCIES_MISSING", runCatching {
            store.submitLocal(input, first.copy(observedSha256 = incomplete.receipt.previousSha256))
        }.exceptionOrNull()?.message)
        assertEquals(emptyList<String>(), store.prepare(input).preview.journal.pending)
    }

    private fun intentFor(artifact: Artifact, observedSha256: String?): RecordCommitIntent {
        val record = Json.decodeFromString<Record>(bytes(artifact.content).decodeToString())
        return RecordCommitIntent(observedSha256, record.id, record.actor_id, record.created_at, record.operations)
    }

    @Test fun syncRetainsUnreadAcrossRestartAndConfirmsLostUploadResponseWithoutSecondWrite() = runBlocking {
        val input = RecordRecoveryInput(pin, descriptor, baseline)
        val (child, parent) = complete.records
        val store = RecordRecoveryStore(folder.root)
        store.submitLocal(input, intentFor(parent, null))
        val remote = mutableMapOf<String, String>()
        var listed = listOf(child.name, child.name)
        var writes = 0
        val transport = object : RecordTransport {
            override val namespace = pin.namespace
            override suspend fun list() = listed
            override suspend fun read(name: String) = remote[name]
            override suspend fun write(name: String, content: String) {
                writes++
                remote[name] = content
                error("响应丢失")
            }
        }
        val first = syncRecordJournal(store, input, transport)
        assertEquals(listOf(child.name), first.readFailures)
        assertEquals(listOf(parent.name), first.uploadFailures)
        assertEquals(listOf(parent.name), first.state.journal.pending)

        listed = emptyList()
        remote[child.name] = child.content
        val resumed = syncRecordJournal(RecordRecoveryStore(folder.root), input, transport)
        assertEquals(1, writes)
        assertEquals(emptyList<String>(), resumed.state.journal.unread)
        assertEquals(emptyList<String>(), resumed.state.journal.pending)
        assertEquals(NormalTodoConflict.canonicalDigest(sample.getValue("expected")),
            NormalTodoConflict.canonicalDigest(requireNotNull(resumed.state.view)))
    }

    @Test fun syncReadsExactParentOutsideListingAndRejectsMismatchedUploadBytes() = runBlocking {
        val input = RecordRecoveryInput(pin, descriptor, baseline)
        val (child, parent) = complete.records
        val store = RecordRecoveryStore(folder.root)
        val requests = mutableListOf<String>()
        val reader = object : RecordTransport {
            override val namespace = pin.namespace
            override suspend fun list() = listOf(child.name)
            override suspend fun read(name: String): String {
                requests.add(name)
                return if (name == child.name) child.content else parent.content
            }
            override suspend fun write(name: String, content: String) = error("没有待发送记录")
        }
        val restored = syncRecordJournal(store, input, reader)
        assertEquals(listOf(child.name, parent.name), requests)
        assertEquals(emptyList<String>(), restored.state.missing)

        val separate = RecordRecoveryStore(folder.newFolder())
        separate.submitLocal(input, intentFor(parent, null))
        val wrong = object : RecordTransport {
            override val namespace = pin.namespace
            override suspend fun list() = emptyList<String>()
            override suspend fun read(name: String) = child.content
            override suspend fun write(name: String, content: String) = error("已有对象不可写")
        }
        val failure = try {
            syncRecordJournal(separate, input, wrong)
            null
        } catch (error: RecordTransportIntegrityException) {
            error.message
        }
        assertEquals("RECORD_REMOTE_BYTES_CHANGED", failure)
        assertEquals(listOf(parent.name), separate.prepare(input).preview.journal.pending)
    }

    @Test fun changedKnownObjectPersistsEvidenceAndBlocksRestartBeforeNetwork() = runBlocking {
        val input = RecordRecoveryInput(pin, descriptor, baseline)
        val (child, parent) = complete.records
        val store = RecordRecoveryStore(folder.root)
        val received = input.copy(received = listOf(parent))
        store.commit(received, store.prepare(received).receipt)
        store.submitLocal(input, intentFor(child, store.prepare(input).receipt.previousSha256))
        var requests = 0
        var remote: String? = child.content
        val transport = object : RecordTransport {
            override val namespace = pin.namespace
            override suspend fun list(): List<String> { requests++; return emptyList() }
            override suspend fun read(name: String): String? {
                requests++
                assertEquals(parent.name, name)
                return remote
            }
            override suspend fun write(name: String, content: String) = error("冻结前不得上传")
        }
        val error = runCatching { syncRecordJournal(store, input, transport) }.exceptionOrNull()
        assertEquals("RECORD_REMOTE_BYTES_CHANGED", error?.message)
        val reopened = RecordRecoveryStore(folder.root)
        val state = reopened.prepare(input).preview
        assertEquals(RecordFault("RECORD_REMOTE_BYTES_CHANGED", Artifact(parent.name, child.content)), state.journal.fault)
        assertEquals(listOf(parent, child), state.journal.records)
        assertEquals(listOf(child.name), state.journal.pending)
        assertNull(state.view)
        assertEquals("RECORD_REMOTE_BYTES_CHANGED", runCatching {
            syncRecordJournal(reopened, input, transport)
        }.exceptionOrNull()?.message)
        assertEquals(2, requests)
        assertEquals("RECORD_DATASET_FROZEN", runCatching {
            reopened.submitLocal(input, intentFor(child, null))
        }.exceptionOrNull()?.message)
        fun export() = java.io.ByteArrayOutputStream().also { reopened.exportFaultEvidence(pin, it) }
            .toString(Charsets.UTF_8.name())
        val frozen = export()
        assertEquals(state.journal, decodeJournalEnvelope(frozen, pin.emptyJournal()))
        assertEquals("RECORD_REPAIR_BYTES_MISMATCH", runCatching { reopened.recheckFault(input, transport) }.exceptionOrNull()?.message)
        remote = null
        assertEquals("RECORD_REPAIR_OBJECT_MISSING", runCatching { reopened.recheckFault(input, transport) }.exceptionOrNull()?.message)
        assertEquals(frozen, export())
        remote = parent.content
        val repaired = reopened.recheckFault(input, transport)
        assertEquals(NormalTodoConflict.canonicalDigest(sample.getValue("expected")),
            NormalTodoConflict.canonicalDigest(requireNotNull(repaired.view)))
        assertNull(repaired.journal.fault)
        assertEquals(state.journal.pending, repaired.journal.pending)
        assertEquals(listOf(state.journal.fault), decodeJournalEnvelope(export(), pin.emptyJournal()).resolved_faults)
    }

    @Test fun folderTransportSyncsTwoStoresAndPreservesExistingObjects() = runBlocking {
        val root = folder.newFolder("shared")
        val dataset = File(root, pin.namespace)
        val directory = File(dataset, "records")
        check(directory.mkdirs())
        val descriptorFile = File(dataset, "dataset.${pin.descriptor_sha256}.json")
        descriptorFile.writeBytes(bytes(descriptor))
        File(dataset, "baseline.${pin.baseline_sha256}.json").writeBytes(bytes(baseline))
        val (child, parent) = complete.records
        val input = RecordRecoveryInput(pin, descriptor, baseline)
        val first = RecordRecoveryStore(folder.newFolder("client-a"))
        val second = RecordRecoveryStore(folder.newFolder("client-b"))
        first.submitLocal(input, intentFor(parent, null))
        assertEquals(emptyList<String>(), syncRecordJournal(first, input, RecordFolderTransport(root, pin)).state.journal.pending)

        val canonical = File(dataset, parent.name)
        val alias = File(directory, "记录（同步冲突）.json")
        check(canonical.renameTo(alias))
        val recovered = syncRecordJournal(second, input, RecordFolderTransport(root, pin))
        assertEquals(listOf(parent), recovered.state.journal.records)
        second.submitLocal(input, intentFor(child, second.prepare(input).receipt.previousSha256))
        syncRecordJournal(second, input, RecordFolderTransport(root, pin))
        val synced = syncRecordJournal(first, input, RecordFolderTransport(root, pin))
        assertEquals(NormalTodoConflict.canonicalDigest(sample.getValue("expected")),
            NormalTodoConflict.canonicalDigest(requireNotNull(synced.state.view)))

        canonical.writeText("已有不同正文")
        val transport = RecordFolderTransport(root, pin)
        val conflict = try {
            transport.write(parent.name, parent.content)
            null
        } catch (error: RecordTransportIntegrityException) {
            error.message
        }
        assertEquals("RECORD_FOLDER_CONTENT_CONFLICT", conflict)
        assertEquals("已有不同正文", canonical.readText())
        assertEquals(parent.content, Base64.getEncoder().encodeToString(alias.readBytes()))
        descriptorFile.writeText("changed")
        val changed = try {
            transport.list()
            null
        } catch (error: RecordTransportIntegrityException) {
            error.message
        }
        assertEquals("RECORD_FOLDER_TARGET_MISMATCH", changed)
    }
    @Test fun webDavBindsBytesAndSendsConditionalCreate() = runBlocking {
        val parent = complete.records[1]
        val paths = mutableListOf<String>()
        var badListing = false
        var writeStatus = 412
        val client = okhttp3.OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val path = request.url.encodedPath
            paths.add(path)
            val collection = "/dav/%E5%90%88%E6%88%90/${pin.namespace}records/"
            val (status, raw) = when {
                path.endsWith("dataset.${pin.descriptor_sha256}.json") -> 200 to bytes(descriptor)
                path.endsWith("baseline.${pin.baseline_sha256}.json") -> 200 to bytes(baseline)
                request.method == "PROPFIND" -> {
                    assertEquals(collection, path)
                    assertEquals("1", request.header("Depth"))
                    val href = if (badListing) "https://other.test/$collection" else collection + parent.name.substringAfter('/')
                    val xml = """<d:multistatus xmlns:d="DAV:"><d:response><d:href>$collection</d:href></d:response><d:response><d:href>$href</d:href></d:response></d:multistatus>"""
                    207 to xml.encodeToByteArray()
                }
                request.method == "PUT" -> {
                    assertEquals("*", request.header("If-None-Match"))
                    val buffer = okio.Buffer()
                    request.body!!.writeTo(buffer)
                    org.junit.Assert.assertArrayEquals(bytes(parent.content), buffer.readByteArray())
                    writeStatus to byteArrayOf()
                }
                else -> 404 to byteArrayOf()
            }
            okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1)
                .code(status).message("Test").body(raw.toResponseBody()).build()
        }.build()
        val transport = RecordWebDavTransport("https://example.test/dav/", listOf("合成"), "fake", "fake", pin, client)
        assertEquals(listOf(parent.name), transport.list())
        assertNull(transport.read(parent.name))
        transport.write(parent.name, parent.content)
        assertEquals(9, paths.size)
        badListing = true
        assertEquals("RECORD_DAV_INVALID_LIST", runCatching { transport.list() }.exceptionOrNull()?.message)
        writeStatus = 204
        assertEquals("RECORD_DAV_CREATE_UNVERIFIED", runCatching {
            transport.write(parent.name, parent.content)
        }.exceptionOrNull()?.message)
    }

    @Test fun planningCloudCreatesFixedFilesAndKeepsPendingUntilExactReadBack() = runBlocking {
        val cloud = PlanningCloudConnection("https://example.test/dav/", "example", "fake", "合成/todo_data.json")
        val actor = "10000000-0000-4000-8000-000000000001"
        val fixed = cloud.target(actor).binding(CLOUD_PLANNING_OPERATION_SET)
        assertEquals("8fcc09ae-784e-404d-8399-23d03ab6ed35", fixed.pin.dataset_id)
        assertEquals("05c39b9ba36feaa51ea14ac456644995b3c5bb176c828b74a934771ef8338797", fixed.pin.baseline_sha256)
        assertEquals("b68d2751a82db79b3b387e54daee6fb080ba674dad2b23ef0665b347fbd59641", fixed.pin.descriptor_sha256)
        assertEquals(fixed.pin.dataset_id, cloud.copy(password = "other").target(actor).datasetId)
        val out = RecordSandbox(folder.root, cloud.target(actor), localOnly = true, cloud = cloud)
        val intent = Json.parseToJsonElement("""{"kind":"rate","date":"2026-11-14","score":4}""").jsonObject
        out.change(intent, out.open().revision)
        val store = RecordRecoveryStore(folder.root)
        val pending = store.prepare(fixed).preview.journal.pending.single()
        val files = mutableMapOf<String, ByteArray>()
        val directories = mutableSetOf<String>()
        val collection = "/dav/%E5%90%88%E6%88%90/${fixed.pin.namespace}records/"
        var recordWrites = 0
        var loseResponse = true
        val client = okhttp3.OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val path = request.url.encodedPath
            assertTrue(path.startsWith("/dav/%E5%90%88%E6%88%90/record-sync/"))
            val (status, raw) = when (request.method) {
                "GET" -> files[path]?.let { 200 to it } ?: (404 to byteArrayOf())
                "MKCOL" -> (if (directories.add(path)) 201 else 405) to byteArrayOf()
                "PUT" -> {
                    assertEquals("*", request.header("If-None-Match"))
                    val buffer = okio.Buffer()
                    request.body!!.writeTo(buffer)
                    files[path] = buffer.readByteArray()
                    if (path.endsWith(pending)) {
                        recordWrites++
                        if (loseResponse) throw java.io.IOException("response lost")
                    }
                    204 to byteArrayOf()
                }
                "PROPFIND" -> {
                    assertEquals(collection, path)
                    val hrefs = listOf(collection) + files.keys.filter { it.startsWith(collection) }
                    val body = hrefs.joinToString("", """<d:multistatus xmlns:d="DAV:">""", "</d:multistatus>") {
                        "<d:response><d:href>$it</d:href></d:response>"
                    }
                    207 to body.encodeToByteArray()
                }
                else -> error("Unexpected method")
            }
            okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1)
                .code(status).message("Test").body(raw.toResponseBody()).build()
        }.build()
        fun transport() = RecordWebDavTransport("https://example.test/dav/", listOf("合成"), "example", "fake",
            fixed.pin, client, initialization = fixed)
        val first = syncRecordJournal(store, fixed, transport())
        assertEquals(listOf(pending), first.uploadFailures)
        assertEquals(listOf(pending), first.state.journal.pending)
        loseResponse = false
        val reopened = syncRecordJournal(RecordRecoveryStore(folder.root), fixed, transport())
        assertEquals(emptyList<String>(), reopened.state.journal.pending)
        assertEquals(1, recordWrites)
        val other = syncRecordJournal(RecordRecoveryStore(folder.newFolder("second-device")), fixed, transport())
        assertEquals(reopened.state.view, other.state.view)
    }
}
