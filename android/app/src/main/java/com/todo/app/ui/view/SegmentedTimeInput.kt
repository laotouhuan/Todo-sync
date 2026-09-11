package com.todo.app.ui.view

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.LocalTime
import java.util.Locale

/** 统一时间输入：表单内显示完整时间，弹窗内用数字键盘编辑时、分。 */
@Composable
fun SegmentedTimeInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    allowEmpty: Boolean = false
) {
    var showPicker by rememberSaveable { mutableStateOf(false) }
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val focusManager = LocalFocusManager.current
    val openPicker = {
        focusManager.clearFocus()
        showPicker = true
    }

    LaunchedEffect(pressed) {
        if (pressed) openPicker()
    }

    OutlinedTextField(
        value = if (value.isBlank() || value == "--:--") "" else value,
        onValueChange = {},
        readOnly = true,
        singleLine = true,
        label = label?.let { { Text(it) } },
        placeholder = { Text(if (allowEmpty) "未设置" else "选择时间") },
        modifier = modifier,
        interactionSource = interactionSource,
        trailingIcon = {
            IconButton(
                onClick = openPicker,
                modifier = Modifier.semantics { contentDescription = "设置${label ?: "时间"}" }
            ) {
                val color = LocalContentColor.current
                Canvas(Modifier.size(22.dp)) {
                    val stroke = 1.8.dp.toPx()
                    drawCircle(color, radius = size.minDimension / 2 - stroke, style = Stroke(stroke))
                    drawLine(color, center, Offset(center.x, size.height * 0.27f), stroke, StrokeCap.Round)
                    drawLine(color, center, Offset(size.width * 0.68f, size.height * 0.61f), stroke, StrokeCap.Round)
                }
            }
        }
    )

    if (showPicker) {
        SimpleTimeInputDialog(
            value = value,
            title = label ?: "设置时间",
            allowEmpty = allowEmpty,
            onDismiss = { showPicker = false },
            onConfirm = {
                onValueChange(it)
                showPicker = false
            }
        )
    }
}

@Composable
private fun SimpleTimeInputDialog(
    value: String,
    title: String,
    allowEmpty: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    val initialTime = remember {
        runCatching { LocalTime.parse(value) }.getOrElse { LocalTime.now() }
    }
    // 编辑草稿只在确认时写回；取消和返回均保留原值。
    var hour by rememberSaveable { mutableStateOf(String.format(Locale.ROOT, "%02d", initialTime.hour)) }
    var minute by rememberSaveable { mutableStateOf(String.format(Locale.ROOT, "%02d", initialTime.minute)) }
    val hourNumber = hour.toIntOrNull()
    val minuteNumber = minute.toIntOrNull()
    val valid = hourNumber != null && hourNumber in 0..23 && minuteNumber != null && minuteNumber in 0..59
    val focusManager = LocalFocusManager.current
    val confirm = {
        if (valid) {
            focusManager.clearFocus()
            onConfirm(String.format(Locale.ROOT, "%02d:%02d", hourNumber, minuteNumber))
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedTextField(
                        value = hour,
                        onValueChange = { input -> hour = input.filter { it in '0'..'9' }.take(2) },
                        modifier = Modifier.weight(1f),
                        label = { Text("小时") },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.headlineSmall.copy(textAlign = TextAlign.Center),
                        isError = hour.isNotEmpty() && (hourNumber == null || hourNumber !in 0..23),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(onNext = {
                            focusManager.moveFocus(androidx.compose.ui.focus.FocusDirection.Next)
                        })
                    )
                    Text(":", style = MaterialTheme.typography.headlineSmall)
                    OutlinedTextField(
                        value = minute,
                        onValueChange = { input -> minute = input.filter { it in '0'..'9' }.take(2) },
                        modifier = Modifier.weight(1f),
                        label = { Text("分钟") },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.headlineSmall.copy(textAlign = TextAlign.Center),
                        isError = minute.isNotEmpty() && (minuteNumber == null || minuteNumber !in 0..59),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { confirm() })
                    )
                }
                Text("24 小时制 · 小时 00–23，分钟 00–59", style = MaterialTheme.typography.bodySmall)
                if (allowEmpty) {
                    TextButton(onClick = { onConfirm("--:--") }) { Text("清除时间") }
                }
            }
        },
        confirmButton = { TextButton(onClick = confirm, enabled = valid) { Text("确定") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
