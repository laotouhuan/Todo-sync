package com.todo.app.ui.view

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember

// 任务、子步骤与计时轨道共用一秒钟面扫描；重组本身不会重启动画。
@Composable
internal fun rememberClockSweep(vararg keys: Any?): Animatable<Float, AnimationVector1D> {
    val progress = remember(*keys) { Animatable(0f) }
    LaunchedEffect(progress) { progress.animateTo(1f, tween(1000, easing = LinearEasing)) }
    return progress
}

internal fun clockEntryAlpha(progress: Float, minute: Double): Float =
    if (progress >= 1f) 1f else ((progress * 1440 - minute) / 60).toFloat().coerceIn(0f, 1f)

internal fun clockArcSweep(progress: Float, startMinute: Float, endMinute: Float): Float =
    (minOf(endMinute, progress * 1440) - startMinute).coerceAtLeast(0f) / 4
