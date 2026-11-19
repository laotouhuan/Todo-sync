package com.todo.app.data.repository

import android.content.Context
import com.todo.app.data.ConfigManager
import com.todo.app.data.model.SyncPhase
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

internal typealias PlanningSettings = Pair<String, PlanningCloudConnection?>

internal data class PersonalPlanningSnapshot(
    val settings: PlanningSettings? = null,
    val data: RecordSandboxView? = null,
    val phase: SyncPhase = SyncPhase.IDLE,
    val loading: Boolean = false,
    val loadError: String? = null,
    val syncError: String? = null
)

internal interface PersonalPlanningSession {
    val connectedCloud: Boolean
    val retainedLocal: Boolean
    suspend fun open(): RecordSandboxView
    suspend fun sync(): RecordSandboxView
    suspend fun change(action: JsonObject, revision: String?): RecordSandboxView
    suspend fun retry(): Pair<RecordSandboxView, Boolean>
    suspend fun enableFocus(): RecordSandboxView = error("本周重点暂不可用")
    suspend fun hasPendingRating(date: String): Boolean = false
    suspend fun close()
}

/** 同步按钮和统计页共享会话；页面是否存在不影响同步，配置切换后不发布旧目标结果。 */
internal class PersonalPlanningRepository(
    private val settings: () -> PlanningSettings,
    private val createSession: suspend (PlanningSettings) -> PersonalPlanningSession
) {
    private val mutex = Mutex()
    private val mutableState = MutableStateFlow(PersonalPlanningSnapshot())
    val state = mutableState.asStateFlow()
    private var session: PersonalPlanningSession? = null
    private var sessionSettings: PlanningSettings? = null

    private fun publish(value: PersonalPlanningSnapshot) {
        if (settings() == value.settings) mutableState.value = value
    }

    private suspend fun ensureSession(target: PlanningSettings): PersonalPlanningSession {
        check(settings() == target) { "同步目标已变化，请重试" }
        if (sessionSettings == target) session?.let { return it }
        session?.close()
        session = null
        sessionSettings = null
        publish(PersonalPlanningSnapshot(target, phase = SyncPhase.RUNNING, loading = true))
        var opened: PersonalPlanningSession? = null
        try {
            opened = createSession(target)
            val initial = opened.open()
            checkNotNull(initial.preview.view) { "无法读取本机计划与评分" }
            check(settings() == target) { "同步目标已变化，请重试" }
            session = opened
            sessionSettings = target
            publish(PersonalPlanningSnapshot(target, initial, phase = SyncPhase.RUNNING))
            return opened
        } catch (error: Exception) {
            opened?.close()
            if (error is CancellationException) throw error
            publish(PersonalPlanningSnapshot(target, phase = SyncPhase.FAILED,
                loadError = "计划与评分加载失败：${error.message}"))
            throw error
        }
    }

    suspend fun sync(): Boolean = mutex.withLock {
        val target = settings()
        val previous = mutableState.value.takeIf { it.settings == target } ?: PersonalPlanningSnapshot(target)
        publish(previous.copy(phase = SyncPhase.RUNNING, syncError = null))
        try {
            val opened = ensureSession(target)
            val next = if (opened.connectedCloud) opened.sync() else opened.open()
            if (settings() != target) return@withLock false
            val error = when {
                opened.retainedLocal -> "本机已有独立的计划与评分，已保留在本机，尚未接入云端计划同步"
                next.preview.view == null -> "计划与评分暂不可用，请重试读取"
                next.syncIncomplete -> "计划与评分同步未完成，请检查网络后重试" + (next.transportError?.let { "（$it）" } ?: "")
                opened.connectedCloud && next.preview.journal.pending.isNotEmpty() -> "部分计划与评分尚未上传，请重试"
                else -> null
            }
            val retainedData = mutableState.value.takeIf { it.settings == target }?.data
            publish(PersonalPlanningSnapshot(target, next.takeIf { it.preview.view != null } ?: retainedData,
                phase = if (error == null) SyncPhase.IDLE else SyncPhase.FAILED, syncError = error))
            error == null
        } catch (error: CancellationException) {
            publish(previous)
            throw error
        } catch (error: Exception) {
            val current = mutableState.value.takeIf { it.settings == target } ?: previous
            publish(current.copy(phase = SyncPhase.FAILED, loading = false,
                syncError = "计划与评分同步失败：${error.message}"))
            false
        }
    }

    suspend fun change(target: PlanningSettings, action: JsonObject, revision: String?) = write(target) {
        it.change(action, revision) to true
    }

    suspend fun retry(target: PlanningSettings) = write(target) { it.retry() }

    suspend fun enableFocus(target: PlanningSettings) = write(target) { it.enableFocus() to true }

    suspend fun readLocal(target: PlanningSettings) = write(target) { it.open() to false }

    suspend fun hasPendingRating(target: PlanningSettings, date: String) = mutex.withLock {
        settings() == target && ensureSession(target).hasPendingRating(date)
    }

    private suspend fun write(target: PlanningSettings,
        operation: suspend (PersonalPlanningSession) -> Pair<RecordSandboxView, Boolean>
    ): Pair<RecordSandboxView, Boolean> = mutex.withLock {
        check(settings() == target) { "个人清单已切换，请重新打开编辑窗口" }
        val opened = ensureSession(target)
        val result = operation(opened)
        val current = mutableState.value
        val phase = if (opened.connectedCloud && result.first.preview.journal.pending.isNotEmpty()) SyncPhase.RUNNING else current.phase
        publish(current.copy(settings = target, data = result.first, phase = phase))
        result
    }
}

private val planningPreferencesLock = Any()

internal fun createPersonalPlanningRepository(context: Context, config: ConfigManager) =
    PersonalPlanningRepository(config::planningSettings) { (target, cloud) ->
        withContext(Dispatchers.IO) {
            val preferences = context.getSharedPreferences("personal-planning", Context.MODE_PRIVATE)
            val key = "target-$target"
            val fixed = synchronized(planningPreferencesLock) {
                preferences.getString(key, null)?.let { Json.decodeFromString<RecordSandboxTarget>(it) }
                    ?: RecordSandboxTarget(UUID.randomUUID().toString(), UUID.randomUUID().toString(), Instant.now().toString())
                        .also { check(preferences.edit().putString(key, Json.encodeToString(RecordSandboxTarget.serializer(), it)).commit()) }
            }
            val legacy = RecordSandbox(context.filesDir, fixed, localOnly = true, focusPreferences = preferences)
            val retained = cloud != null && legacy.open().preview.retainsLocalPlanning()
            val connected = cloud != null && !retained
            val selected = if (connected) RecordSandbox(context.filesDir, cloud!!.target(fixed.actorId), localOnly = true,
                cloud = cloud, focusPreferences = preferences) else legacy
            object : PersonalPlanningSession {
                override val connectedCloud = connected
                override val retainedLocal = retained
                override suspend fun open() = selected.open()
                override suspend fun sync() = selected.sync()
                override suspend fun change(action: JsonObject, revision: String?) = selected.change(action, revision)
                override suspend fun retry() = selected.retryWithResult()
                override suspend fun enableFocus() = selected.enableFocus { config.planningSettings() == (target to cloud) }
                override suspend fun hasPendingRating(date: String) = selected.hasPendingRating(date)
                override suspend fun close() = selected.close()
            }
        }
    }
