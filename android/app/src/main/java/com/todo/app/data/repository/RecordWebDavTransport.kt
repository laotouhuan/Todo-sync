package com.todo.app.data.repository

import com.todo.app.data.recordsync.MAX_BYTES
import com.todo.app.data.recordsync.sha
import okhttp3.Credentials
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import org.w3c.dom.Element
import org.xml.sax.InputSource
import java.io.IOException
import java.io.StringReader
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.xml.parsers.DocumentBuilderFactory

internal class RecordWebDavTransport(
    endpoint: String,
    directory: List<String>,
    username: String,
    password: String,
    private val pin: RecordDatasetPin,
    client: OkHttpClient = defaultClient,
    private val initialization: RecordRecoveryInput? = null
) : RecordTransport {
    override val namespace = pin.namespace
    private val dataset: HttpUrl
    private val client = client.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    private val authorization = Credentials.basic(username, password, StandardCharsets.UTF_8)
    private var joined = false

    init {
        pin.validate()
        val base = endpoint.toHttpUrlOrNull()
        require(base != null && base.isHttps && base.username.isEmpty() && base.password.isEmpty() &&
            base.query == null && base.fragment == null && username.isNotEmpty() && ':' !in username && password.isNotEmpty() &&
            directory.none { it.isEmpty() || it == "." || it == ".." || it.any { ch -> ch == '/' || ch == '\\' || ch == '%' || ch.isISOControl() } }) {
            "RECORD_DAV_INVALID_TARGET"
        }
        val builder = base.newBuilder()
        if (base.pathSegments.lastOrNull() == "") builder.removePathSegment(base.pathSegments.lastIndex)
        directory.forEach { builder.addPathSegment(it) }
        dataset = builder.addPathSegment("record-sync").addPathSegment(pin.dataset_id).addPathSegment("").build()
    }

    override suspend fun list(): List<String> {
        if (initialization != null && !joined) {
            initialize(initialization)
            joined = true
        }
        verifyTarget()
        val collection = dataset.resolve("records/")!!
        val body = """<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"""
        return execute(collection, "PROPFIND", body.toRequestBody("application/xml".toMediaType()), "Depth" to "1") {
            expect(it, 207)
            directoryNames(bounded(it).decodeToString(throwOnInvalidSequence = true), collection)
        }
    }

    override suspend fun read(name: String): String? {
        val url = target(name)
        verifyTarget()
        return execute(url, "GET") {
            if (it.code == 404) null else {
                expect(it, 200)
                Base64.getEncoder().encodeToString(bounded(it))
            }
        }
    }

    override suspend fun write(name: String, content: String) {
        val url = target(name)
        val raw = bytes(content)
        if (initialization != null) {
            val operations = Json.parseToJsonElement(raw.decodeToString()).jsonObject.getValue("operations").jsonArray
            if (operations.size != 1 || operations.single().jsonObject["type"]?.jsonPrimitive?.content !in setOf(
                    "planning.version.save", "planning.version.delete", "planning.selection.resolve", "planning.rating.put")) {
                integrity("RECORD_DAV_INVALID_RECORD")
            }
        }
        val journal = pin.emptyJournal().copy(records = listOf(Artifact(name, content)))
        runCatching { journal.dependencies(journal) }.getOrElse { integrity("RECORD_DAV_INVALID_RECORD") }
        verifyTarget()
        execute(url, "PUT", raw.toRequestBody("application/json".toMediaType()), "If-None-Match" to "*") {
            if (it.code == 204 && initialization == null) integrity("RECORD_DAV_CREATE_UNVERIFIED")
            expect(it, 201, 204, 412)
        }
    }

    private fun initialize(binding: RecordRecoveryInput) {
        val fixed = listOf(
            Triple("baseline", pin.baseline_sha256, bytes(binding.baseline)),
            Triple("dataset", pin.descriptor_sha256, bytes(binding.descriptor))
        )
        if (fixed.any { (_, hash, raw) -> raw.size > MAX_BYTES || sha(raw) != hash }) integrity("RECORD_DAV_TARGET_MISMATCH")
        val hasDescriptor = execute(dataset.resolve("dataset.${pin.descriptor_sha256}.json")!!, "GET") {
            if (it.code == 404) false else {
                expect(it, 200)
                if (sha(bounded(it)) != pin.descriptor_sha256) integrity("RECORD_DAV_TARGET_MISMATCH")
                true
            }
        }
        if (!hasDescriptor) {
            for (url in listOf(dataset.resolve("../")!!, dataset, dataset.resolve("records/")!!)) {
                execute(url, "MKCOL") { expect(it, 201, 405) }
            }
        }
        for ((kind, hash, raw) in fixed) {
            val url = dataset.resolve("$kind.$hash.json")!!
            val found = execute(url, "GET") {
                if (it.code == 404) false else {
                    expect(it, 200)
                    if (!bounded(it).contentEquals(raw)) integrity("RECORD_DAV_TARGET_MISMATCH")
                    true
                }
            }
            if (!found) {
                execute(url, "PUT", raw.toRequestBody("application/json".toMediaType()), "If-None-Match" to "*") {
                    expect(it, 201, 204, 412)
                }
                execute(url, "GET") {
                    expect(it, 200)
                    if (!bounded(it).contentEquals(raw)) integrity("RECORD_DAV_TARGET_MISMATCH")
                }
            }
        }
    }

    private fun target(name: String): HttpUrl {
        if (!recordFileName.matches(name)) integrity("RECORD_DAV_INVALID_REQUEST")
        return dataset.resolve(name)!!
    }

    private fun verifyTarget() {
        for ((kind, expected) in listOf("dataset" to pin.descriptor_sha256, "baseline" to pin.baseline_sha256)) {
            execute(dataset.resolve("$kind.$expected.json")!!, "GET") {
                if (it.code != 200 || sha(bounded(it)) != expected) integrity("RECORD_DAV_TARGET_MISMATCH")
            }
        }
    }

    private fun <T> execute(url: HttpUrl, method: String, body: RequestBody? = null,
        extra: Pair<String, String>? = null, action: (Response) -> T): T {
        val builder = Request.Builder().url(url).header("Authorization", authorization)
            .header("Cache-Control", "no-cache").method(method, body)
        extra?.let { builder.header(it.first, it.second) }
        return client.newCall(builder.build()).execute().use(action)
    }

    private companion object {
        val defaultClient = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
    }
}

private fun expect(response: Response, vararg codes: Int) {
    if (response.code !in codes) throw IOException("RECORD_DAV_HTTP_${response.code}")
}

private fun bounded(response: Response): ByteArray {
    val source = response.body?.byteStream() ?: return byteArrayOf()
    val buffer = ByteArray(MAX_BYTES + 1)
    var offset = 0
    while (offset < buffer.size) {
        val count = source.read(buffer, offset, buffer.size - offset)
        if (count < 0) return buffer.copyOf(offset)
        offset += count
    }
    integrity("RECORD_DAV_SIZE_LIMIT")
}

private fun directoryNames(xml: String, collection: HttpUrl): List<String> = try {
    // 限制为 WebDAV 列表需要的 XML 子集，拒绝 DTD、实体声明和处理指令。
    val input = xml.replaceFirst(Regex("^<\\?xml\\s+[^?]*\\?>"), "")
    if ("<!" in input || "<?" in input) integrity("RECORD_DAV_INVALID_LIST")
    val builder = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
    builder.setEntityResolver { _, _ -> throw IOException("RECORD_DAV_INVALID_LIST") }
    val root = builder.parse(InputSource(StringReader(input))).documentElement
    if (!root.isDav("multistatus")) integrity("RECORD_DAV_INVALID_LIST")
    val names = sortedSetOf<String>()
    var self = 0
    for (row in root.elements()) {
        if (!row.isDav("response")) integrity("RECORD_DAV_INVALID_LIST")
        val href = row.elements().filter { it.isDav("href") }.singleOrNull()
            ?: integrity("RECORD_DAV_INVALID_LIST")
        if (href.elements().isNotEmpty()) integrity("RECORD_DAV_INVALID_LIST")
        val url = collection.resolve(href.textContent.trim()) ?: integrity("RECORD_DAV_INVALID_LIST")
        if (url.scheme != collection.scheme || url.host != collection.host || url.port != collection.port ||
            url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null) {
            integrity("RECORD_DAV_INVALID_LIST")
        }
        val prefix = collection.pathSegments.dropLast(1)
        val path = url.pathSegments
        if (path == prefix || path == collection.pathSegments) self++
        else {
            if (path.size != prefix.size + 1 || path.dropLast(1) != prefix) integrity("RECORD_DAV_INVALID_LIST")
            val name = "records/${path.last()}"
            if (!recordFileName.matches(name)) integrity("RECORD_DAV_INVALID_LIST")
            names.add(name)
        }
    }
    if (self != 1) integrity("RECORD_DAV_INVALID_LIST")
    names.toList()
} catch (_: Exception) {
    integrity("RECORD_DAV_INVALID_LIST")
}

private fun Element.isDav(name: String) = namespaceURI == "DAV:" && localName == name
private fun Element.elements() = (0 until childNodes.length).mapNotNull { childNodes.item(it) as? Element }
private fun integrity(code: String): Nothing = throw RecordTransportIntegrityException(code)
