package com.todo.app.data.repository

import com.todo.app.data.model.SyncOutcome
import com.todo.app.data.model.TaskReference
import com.todo.app.data.model.Todo
import com.todo.app.data.model.SyncPhase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** 网络失败只影响同步状态，本地加载、校验及保存仍必须成功；取消阻止开始计时。 */
internal suspend fun startLearningAfterSync(
    store: PersonalDataStore, todo: Todo, ref: TaskReference, enabled: () -> Boolean,
    sync: suspend () -> SyncOutcome
) {
    store.ensureLoaded()
    val outcome = sync()
    if (outcome.phase == SyncPhase.CANCELLED) throw CancellationException("同步已取消")
    currentCoroutineContext().ensureActive()
    store.start(todo, ref, enabled)
}
