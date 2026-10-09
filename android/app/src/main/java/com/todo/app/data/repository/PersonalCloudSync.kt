package com.todo.app.data.repository

import com.todo.app.data.model.MergeUtils
import com.todo.app.data.model.TodoData
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.coroutines.CancellationException
import java.io.IOException

internal class PartialSyncException(val failure: Exception) :
    IOException("个人待办已同步，协作配置同步失败：${failure.message}")

/** 完整手动同步的成功必须覆盖两个步骤；第二步失败要说明已完成的部分。 */
internal suspend fun syncPersonalAndConfiguration(personal: suspend () -> Unit, configuration: (suspend () -> Unit)?) {
    personal()
    if (configuration != null) {
        try { configuration() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { throw PartialSyncException(e) }
    }
}

/** 仓库持锁调用；沿用现有合并规则，上传失败也保留已落盘的完整数据。 */
internal class PersonalCloudSync(private val store: PersonalDataStore) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; prettyPrint = true }

    suspend fun synchronize(
        download: suspend () -> String?,
        upload: suspend (String) -> Unit,
        backup: () -> Unit,
        localChanged: (TodoData) -> Unit
    ) {
        val local = store.loadLocked()
        val cloudJson = download()
        if (cloudJson == null) {
            upload(json.encodeToString(local))
            return
        }
        val cloud = json.decodeFromString<TodoData>(cloudJson)
        val merged = MergeUtils.mergeTodoData(local, cloud)
        if (MergeUtils.hasContentChanges(merged, local)) {
            backup()
            store.commitLocked(merged)
            localChanged(merged)
        }
        if (MergeUtils.hasContentChanges(merged, cloud)) upload(json.encodeToString(merged))
    }

    suspend fun upload(upload: suspend (String) -> Unit) {
        upload(json.encodeToString(store.loadLocked()))
    }
}
