package com.todo.app.data.repository

import com.todo.app.data.model.CollaborationData
import com.todo.app.data.model.CollaborationSource
import com.todo.app.data.model.ShareCodePayload
import com.todo.app.data.model.nowIso
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.time.OffsetDateTime
import java.util.UUID

/** 协作配置的文件提交步骤；调用方继续使用仓库原有的 mutex 串行执行。 */
internal class CollaborationDataFile(
    private val file: File,
    private val atomicFile: AtomicJsonFile = AtomicJsonFile(file),
    private val now: () -> String = ::nowIso
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; prettyPrint = true }
    private val mutableCollaborations = MutableStateFlow<List<CollaborationSource>>(emptyList())
    val collaborations = mutableCollaborations.asStateFlow()

    private fun read(): CollaborationData {
        val content = if (file.exists()) file.readText(Charsets.UTF_8) else ""
        return try {
            json.decodeFromString<CollaborationData>(content)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            CollaborationData()
        }
    }

    private fun commit(data: CollaborationData): String {
        val content = json.encodeToString(data)
        atomicFile.write(content)
        return content
    }

    private fun publish(data: CollaborationData) {
        mutableCollaborations.value = data.collaborations.filter { !it.deleted }
    }

    fun load(
        legacySources: List<CollaborationSource>,
        clearLegacySources: () -> Unit,
        onReadFailure: (Exception) -> Unit
    ) {
        if (legacySources.isNotEmpty()) {
            val currentData = try {
                read()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                CollaborationData()
            }
            val timestamp = now()
            val merged = currentData.collaborations.toMutableList()
            for (source in legacySources) {
                if (merged.none { it.id == source.id }) {
                    merged.add(source.copy(updatedAt = timestamp, deleted = false))
                }
            }
            commit(CollaborationData(version = 1, lastUpdated = timestamp, collaborations = merged))
            clearLegacySources()
        }

        if (file.exists()) {
            try {
                // 加载阶段仍报告损坏文件；导入和同步保留原有的兼容回退。
                publish(json.decodeFromString<CollaborationData>(file.readText(Charsets.UTF_8)))
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                onReadFailure(e)
                mutableCollaborations.value = emptyList()
            }
        } else {
            mutableCollaborations.value = emptyList()
        }
    }

    fun importSource(payload: ShareCodePayload, name: String, enqueueSync: () -> Unit): Result<CollaborationSource> = result {
        val current = read()
        val sources = current.collaborations.toMutableList()
        val timestamp = now()
        val index = sources.indexOfFirst {
            it.webdavUrl == payload.url && it.webdavUsername == payload.user && it.webdavFilepath == payload.path
        }
        val source = if (index != -1) {
            sources[index].copy(
                webdavPassword = payload.pass,
                expireAt = payload.exp.takeUnless { it == 0L },
                updatedAt = timestamp,
                deleted = false,
                name = name
            ).also { sources[index] = it }
        } else {
            CollaborationSource(
                id = UUID.randomUUID().toString(), name = name,
                webdavUrl = payload.url, webdavUsername = payload.user,
                webdavPassword = payload.pass, webdavFilepath = payload.path,
                expireAt = payload.exp.takeUnless { it == 0L }, updatedAt = timestamp, deleted = false
            ).also { sources.add(it) }
        }
        val updated = current.copy(lastUpdated = timestamp, collaborations = sources)
        commit(updated)
        publish(updated)
        enqueueSync()
        source
    }

    fun deleteSource(id: String, enqueueSync: () -> Unit): Result<Unit> = result {
        if (file.exists()) {
            val current = read()
            val sources = current.collaborations.toMutableList()
            val index = sources.indexOfFirst { it.id == id }
            if (index != -1) {
                val timestamp = now()
                sources[index] = sources[index].copy(deleted = true, updatedAt = timestamp)
                val updated = current.copy(lastUpdated = timestamp, collaborations = sources)
                commit(updated)
                publish(updated)
                enqueueSync()
            }
        }
    }

    fun merge(local: CollaborationData, cloud: CollaborationData): Pair<CollaborationData, Boolean> {
        val merged = mutableListOf<CollaborationSource>()
        val localList = local.collaborations
        val cloudList = cloud.collaborations
        val ids = (localList.map { it.id } + cloudList.map { it.id }).toSet()
        var changed = false
        for (id in ids) {
            val localItem = localList.find { it.id == id }
            val cloudItem = cloudList.find { it.id == id }
            if (localItem != null && cloudItem != null) {
                val localTime = try { OffsetDateTime.parse(localItem.updatedAt).toInstant().toEpochMilli() } catch (_: Exception) { 0L }
                val cloudTime = try { OffsetDateTime.parse(cloudItem.updatedAt).toInstant().toEpochMilli() } catch (_: Exception) { 0L }
                if (cloudTime > localTime) {
                    merged.add(cloudItem.withLocalPassword(localItem))
                    changed = true
                } else {
                    merged.add(localItem)
                    if (localTime > cloudTime) changed = true
                }
            } else if (localItem != null) {
                merged.add(localItem)
                changed = true
            } else if (cloudItem != null) {
                merged.add(cloudItem.copy(webdavPassword = ""))
                changed = true
            }
        }
        val timestamp = now()
        return CollaborationData(
            version = 1,
            lastUpdated = if (changed) timestamp else
                (local.lastUpdated.takeIf { it.isNotEmpty() } ?: cloud.lastUpdated.takeIf { it.isNotEmpty() } ?: timestamp),
            collaborations = merged
        ) to changed
    }

    suspend fun sync(download: suspend () -> CollaborationData?, upload: suspend (String) -> Unit) {
        val local = read()
        val cloud = download()
        if (cloud != null) {
            val (merged, changed) = merge(local, cloud)
            if (changed) commit(merged)
            // 即使时间戳相同，也要清理旧客户端留下的云端密码；本机凭据不参与上传。
            if (changed || cloud.collaborations.any { it.webdavPassword.isNotEmpty() }) {
                upload(sharedJson(merged))
            }
            publish(merged)
        } else {
            upload(sharedJson(local))
            publish(local)
        }
    }

    private fun sharedJson(data: CollaborationData): String = json.encodeToString(
        data.copy(collaborations = data.collaborations.map { it.copy(webdavPassword = "") })
    )

    // 云端可修改地址和账号；不能把本机密码发送到同 ID 下的新目标。
    private fun CollaborationSource.withLocalPassword(local: CollaborationSource): CollaborationSource = copy(
        webdavPassword = if (webdavUrl == local.webdavUrl &&
            webdavUsername == local.webdavUsername && webdavFilepath == local.webdavFilepath
        ) local.webdavPassword else ""
    )

    private inline fun <T> result(action: () -> T): Result<T> = try {
        Result.success(action())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }
}
