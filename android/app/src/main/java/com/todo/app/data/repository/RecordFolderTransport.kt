package com.todo.app.data.repository

import com.todo.app.data.recordsync.MAX_BYTES
import com.todo.app.data.recordsync.sha
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.Base64

internal class RecordFolderTransport(root: File, private val pin: RecordDatasetPin) : RecordTransport {
    private val root = root.toPath().also { require(it.isAbsolute) { "RECORD_FOLDER_INVALID_ROOT" } }
    private var aliases = emptyMap<String, String>()
    override val namespace = pin.namespace

    override suspend fun list(): List<String> {
        val records = datasetDirectory().resolve("records")
        val names = sortedSetOf<String>()
        val foundAliases = mutableMapOf<String, String>()
        Files.newDirectoryStream(records).use { entries ->
            for (entry in entries) {
                if (!Files.isRegularFile(entry, NOFOLLOW_LINKS)) integrity("RECORD_FOLDER_UNSAFE_ENTRY")
                val name = "records/${entry.fileName}"
                if (recordFileName.matches(name)) {
                    names.add(name)
                    continue
                }
                val raw = readFile(entry) ?: throw NoSuchFileException(entry.toString())
                val id = runCatching {
                    Json.parseToJsonElement(raw.decodeToString(throwOnInvalidSequence = true)).jsonObject.getValue("id").jsonPrimitive.content
                }.getOrElse { integrity("RECORD_FOLDER_UNRESOLVED_ENTRY") }
                val canonicalName = "records/$id.${sha(raw)}.json"
                names.add(canonicalName)
                foundAliases[canonicalName] = checkedArtifact(canonicalName, raw)
            }
        }
        aliases = foundAliases
        return names.toList()
    }

    override suspend fun read(name: String): String? {
        if (!recordFileName.matches(name)) integrity("RECORD_INVALID_REMOTE_NAME")
        val raw = readFile(datasetDirectory().resolve(name))
        return raw?.let { Base64.getEncoder().encodeToString(it) } ?: aliases[name]
    }

    override suspend fun write(name: String, content: String) {
        if (!recordFileName.matches(name)) integrity("RECORD_INVALID_REMOTE_NAME")
        val raw = bytes(content)
        checkedArtifact(name, raw)
        val dataset = datasetDirectory()
        publish(dataset, dataset.resolve(name), raw)
    }

    private fun publish(dataset: Path, destination: Path, raw: ByteArray) {
        val staging = dataset.resolve(".staging")
        try {
            Files.createDirectory(staging)
        } catch (_: FileAlreadyExistsException) {
            // 已有暂存目录仍需检查类型。
        }
        checkDirectory(staging)
        val temp = Files.createTempFile(staging, "record-", ".tmp")
        try {
            FileChannel.open(temp, StandardOpenOption.WRITE, NOFOLLOW_LINKS).use { channel ->
                val buffer = ByteBuffer.wrap(raw)
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            try {
                Files.createLink(destination, temp)
            } catch (_: FileAlreadyExistsException) {
                if (readFile(destination)?.contentEquals(raw) != true) integrity("RECORD_FOLDER_CONTENT_CONFLICT")
            }
        } finally {
            runCatching { Files.deleteIfExists(temp) }
        }
    }

    private fun datasetDirectory(): Path {
        pin.validate()
        val collection = root.toRealPath().resolve("record-sync")
        checkDirectory(collection)
        val dataset = collection.resolve(pin.dataset_id)
        checkDirectory(dataset)
        for ((kind, expected) in listOf("dataset" to pin.descriptor_sha256, "baseline" to pin.baseline_sha256)) {
            val raw = readFile(dataset.resolve("$kind.$expected.json")) ?: integrity("RECORD_FOLDER_TARGET_MISMATCH")
            if (sha(raw) != expected) integrity("RECORD_FOLDER_TARGET_MISMATCH")
        }
        checkDirectory(dataset.resolve("records"))
        return dataset
    }

    private fun checkDirectory(path: Path) {
        if (Files.notExists(path, NOFOLLOW_LINKS)) throw NoSuchFileException(path.toString())
        if (!Files.isDirectory(path, NOFOLLOW_LINKS) || path.toRealPath() != path) integrity("RECORD_FOLDER_UNSAFE_ENTRY")
    }

    private fun checkedArtifact(name: String, raw: ByteArray): String {
        val content = Base64.getEncoder().encodeToString(raw)
        val journal = pin.emptyJournal().copy(records = listOf(Artifact(name, content)))
        runCatching { journal.dependencies(journal) }.getOrElse { integrity("RECORD_FOLDER_INVALID_RECORD") }
        return content
    }

    companion object {
        fun sandbox(files: File, binding: RecordRecoveryInput): RecordFolderTransport {
            val pin = binding.pin
            pin.validate()
            val root = File(files.canonicalFile, "record-sandbox")
            val transport = RecordFolderTransport(root, pin)
            val fixed = listOf("baseline" to (pin.baseline_sha256 to bytes(binding.baseline)),
                "dataset" to (pin.descriptor_sha256 to bytes(binding.descriptor)))
            require(fixed.all { (_, artifact) -> artifact.second.size <= MAX_BYTES && sha(artifact.second) == artifact.first })
            val namespace = root.toPath().resolve("record-sync")
            val dataset = namespace.resolve(pin.dataset_id)
            for (directory in listOf(root.toPath(), namespace, dataset, dataset.resolve("records"))) {
                try { Files.createDirectory(directory) } catch (_: FileAlreadyExistsException) { }
                transport.checkDirectory(directory)
            }
            for ((kind, artifact) in fixed) {
                val destination = dataset.resolve("$kind.${artifact.first}.json")
                val previous = readFile(destination)
                if (previous == null) transport.publish(dataset, destination, artifact.second)
                else if (!previous.contentEquals(artifact.second)) integrity("RECORD_FOLDER_CONTENT_CONFLICT")
            }
            return transport
        }
    }
}

private fun readFile(path: Path): ByteArray? {
    if (Files.notExists(path, NOFOLLOW_LINKS)) return null
    if (!Files.isRegularFile(path, NOFOLLOW_LINKS)) integrity("RECORD_FOLDER_UNSAFE_ENTRY")
    return Files.newInputStream(path, StandardOpenOption.READ, NOFOLLOW_LINKS).use {
        val buffer = ByteArray(MAX_BYTES + 1)
        var offset = 0
        while (offset < buffer.size) {
            val count = it.read(buffer, offset, buffer.size - offset)
            if (count < 0) return@use buffer.copyOf(offset)
            offset += count
        }
        integrity("RECORD_FOLDER_SIZE_LIMIT")
    }
}

private fun integrity(code: String): Nothing = throw RecordTransportIntegrityException(code)
