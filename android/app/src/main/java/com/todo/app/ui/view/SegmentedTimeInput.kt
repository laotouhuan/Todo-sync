package com.todo.app.ui.view

import android.app.TimePickerDialog
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.LocalTime

@Composable
fun SegmentedTimeInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    allowEmpty: Boolean = false
) {
    val context = LocalContext.current
    val hourFocusRequester = remember { FocusRequester() }
    val minuteFocusRequester = remember { FocusRequester() }

    // 解析初始时和分
    var hourText by remember(value) {
        mutableStateOf(
            if (value.contains(':')) {
                val h = value.split(':')[0].trim()
                if (h == "--") "" else h
            } else ""
        )
    }

    var minuteText by remember(value) {
        mutableStateOf(
            if (value.contains(':')) {
                val m = value.split(':')[1].trim()
                if (m == "--") "" else m
            } else ""
        )
    }

    fun emitTime(hStr: String, mStr: String) {
        if (hStr.isEmpty() && mStr.isEmpty()) {
            if (allowEmpty) {
                onValueChange("--:--")
            } else {
                onValueChange("09:00")
            }
            return
        }
        val finalH = when {
            hStr.isEmpty() -> "00"
            hStr.length == 1 -> "0$hStr"
            else -> hStr
        }
        val finalM = when {
            mStr.isEmpty() -> "00"
            mStr.length == 1 -> "0$mStr"
            else -> mStr
        }
        onValueChange("$finalH:$finalM")
    }

    fun showSystemTimePicker() {
        val now = LocalTime.now()
        val curH = hourText.toIntOrNull() ?: if (value.contains(':')) value.split(':')[0].toIntOrNull() ?: now.hour else now.hour
        val curM = minuteText.toIntOrNull() ?: if (value.contains(':')) value.split(':')[1].toIntOrNull() ?: now.minute else now.minute

        TimePickerDialog(
            context,
            { _, hourOfDay, minute ->
                val hFmt = String.format("%02d", hourOfDay)
                val mFmt = String.format("%02d", minute)
                hourText = hFmt
                minuteText = mFmt
                onValueChange("$hFmt:$mFmt")
            },
            curH,
            curM,
            true
        ).show()
    }

    Column(modifier = modifier) {
        if (label != null) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 4.dp)
            )
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            OutlinedTextField(
                value = hourText,
                onValueChange = { input ->
                    val digits = input.filter { it.isDigit() }.take(2)
                    if (digits.isEmpty()) {
                        hourText = ""
                        emitTime("", minuteText)
                    } else {
                        val num = digits.toInt()
                        if (digits.length == 1) {
                            if (num in 3..9) {
                                val formattedH = "0$num"
                                hourText = formattedH
                                emitTime(formattedH, minuteText)
                                minuteFocusRequester.requestFocus()
                            } else {
                                hourText = digits
                                emitTime(digits, minuteText)
                            }
                        } else {
                            val clampedH = if (num > 23) "23" else digits
                            hourText = clampedH
                            emitTime(clampedH, minuteText)
                            minuteFocusRequester.requestFocus()
                        }
                    }
                },
                modifier = Modifier
                    .width(62.dp)
                    .focusRequester(hourFocusRequester)
                    .onFocusChanged { focusState ->
                        if (!focusState.isFocused && hourText.isNotEmpty()) {
                            val padded = hourText.padStart(2, '0')
                            if (padded != hourText) {
                                hourText = padded
                                emitTime(padded, minuteText)
                            }
                        }
                    },
                textStyle = LocalTextStyle.current.copy(
                    textAlign = TextAlign.Center,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                ),
                placeholder = {
                    Text(
                        if (allowEmpty) "--" else "00",
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                        fontSize = 15.sp
                    )
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Next
                ),
                keyboardActions = KeyboardActions(
                    onNext = { minuteFocusRequester.requestFocus() }
                )
            )

            Text(
                ":",
                fontWeight = FontWeight.Bold,
                fontSize = 18.sp,
                color = MaterialTheme.colorScheme.onSurface
            )

            OutlinedTextField(
                value = minuteText,
                onValueChange = { input ->
                    val digits = input.filter { it.isDigit() }.take(2)
                    if (digits.isEmpty()) {
                        minuteText = ""
                        emitTime(hourText, "")
                    } else {
                        val num = digits.toInt()
                        if (digits.length == 1) {
                            if (num in 6..9) {
                                val formattedM = "0$num"
                                minuteText = formattedM
                                emitTime(hourText, formattedM)
                            } else {
                                minuteText = digits
                                emitTime(hourText, digits)
                            }
                        } else {
                            val clampedM = if (num > 59) "59" else digits
                            minuteText = clampedM
                            emitTime(hourText, clampedM)
                        }
                    }
                },
                modifier = Modifier
                    .width(62.dp)
                    .focusRequester(minuteFocusRequester)
                    .onFocusChanged { focusState ->
                        if (!focusState.isFocused && minuteText.isNotEmpty()) {
                            val padded = minuteText.padStart(2, '0')
                            if (padded != minuteText) {
                                minuteText = padded
                                emitTime(hourText, padded)
                            }
                        }
                    },
                textStyle = LocalTextStyle.current.copy(
                    textAlign = TextAlign.Center,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                ),
                placeholder = {
                    Text(
                        if (allowEmpty) "--" else "00",
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                        fontSize = 15.sp
                    )
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Number,
                    imeAction = ImeAction.Done
                )
            )

            IconButton(
                onClick = { showSystemTimePicker() },
                modifier = Modifier.size(42.dp)
            ) {
                Text("🕒", fontSize = 20.sp)
            }
        }
    }
}
