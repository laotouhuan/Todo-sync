package com.todo.app.data.model

enum class SyncPhase { IDLE, RUNNING, SUCCEEDED, FAILED, SKIPPED, CANCELLED }

/** 仅用于本机展示，不进入共享数据文件。 */
data class SyncOutcome(
    val phase: SyncPhase = SyncPhase.IDLE,
    val target: String = "personal",
    val operationId: Long = 0,
    val completedAt: Long = 0,
    val error: Exception? = null
) {
    val isSuccess get() = phase == SyncPhase.SUCCEEDED
    val isFailure get() = phase == SyncPhase.FAILED
    fun exceptionOrNull(): Exception? = error
    fun showsSuccess(target: String, now: Long = System.currentTimeMillis()): Boolean =
        this.target == target && isSuccess && now - completedAt in 0 until 1500
}
