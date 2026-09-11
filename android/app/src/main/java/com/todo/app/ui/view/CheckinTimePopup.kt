package com.todo.app.ui.view

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.todo.app.data.model.formatCheckinDateTime
import com.todo.app.data.model.parseIsoToLocalDateTime
import java.time.LocalDate

/**
 * 打卡时间编辑弹窗 — 统一组件。
 *
 * 用于周打卡和月打卡网格中，点击某一天后弹出的浮层，
 * 支持补打卡、修改打卡时间、销卡操作。
 *
 * @param isChecked     该日期是否已打卡
 * @param matchedDate   已匹配的打卡记录字符串（可能含时间 ISO，如 "2026-06-15T14:30:00+08:00"）
 * @param dateStr       当前格子对应的日期字符串（如 "2026-06-15"）
 * @param completedDates 当前全部打卡记录列表
 * @param onUpdateCompletedDates 更新打卡记录列表的回调
 * @param onDismiss     关闭弹窗的回调
 */
@Composable
fun CheckinTimePopup(
    isChecked: Boolean,
    matchedDate: String?,
    dateStr: String,
    completedDates: List<String>,
    onUpdateCompletedDates: (List<String>) -> Unit,
    onDismiss: () -> Unit
) {
    Popup(
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true)
    ) {
        Card(
            modifier = Modifier
                .width(220.dp)
                .padding(8.dp),
            elevation = CardDefaults.cardElevation(defaultElevation = 8.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = if (isChecked) "修改打卡时间" else "补打卡",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary
                )

                val initialTime = remember(matchedDate) {
                    if (isChecked && matchedDate != null && matchedDate.contains('T')) {
                        try {
                            val ldt = parseIsoToLocalDateTime(matchedDate)
                            val hh = String.format("%02d", ldt.hour)
                            val min = String.format("%02d", ldt.minute)
                            "$hh:$min"
                        } catch (_: Exception) {
                            ""
                        }
                    } else if (!isChecked) {
                        val now = java.time.LocalDateTime.now()
                        val hh = String.format("%02d", now.hour)
                        val min = String.format("%02d", now.minute)
                        "$hh:$min"
                    } else {
                        ""
                    }
                }

                var inputDate by remember(matchedDate) {
                    if (isChecked && matchedDate != null) {
                        mutableStateOf(matchedDate.take(10))
                    } else {
                        val now = LocalDate.now()
                        val mm = String.format("%02d", now.monthValue)
                        val dd = String.format("%02d", now.dayOfMonth)
                        mutableStateOf("${now.year}-$mm-$dd")
                    }
                }

                var inputTime by remember(matchedDate) {
                    mutableStateOf(if (initialTime.isEmpty()) "--:--" else initialTime)
                }

                AppDateInput(
                    value = inputDate,
                    onValueChange = { inputDate = it },
                    label = "完成日期",
                    modifier = Modifier.fillMaxWidth()
                )

                SegmentedTimeInput(
                    value = inputTime,
                    onValueChange = { inputTime = it },
                    label = "完成时间",
                    modifier = Modifier.fillMaxWidth(),
                    allowEmpty = true
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    if (isChecked) {
                        Button(
                            onClick = {
                                val checkinStr = formatCheckinDateTime(inputDate, inputTime)
                                onUpdateCompletedDates(completedDates.filter { !it.startsWith(dateStr) } + checkinStr)
                                onDismiss()
                            },
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp)
                        ) {
                            Text("保存", fontSize = 11.sp)
                        }
                        Button(
                            onClick = {
                                onUpdateCompletedDates(completedDates.filter { !it.startsWith(dateStr) })
                                onDismiss()
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp)
                        ) {
                            Text("销卡", fontSize = 11.sp)
                        }
                    } else {
                        Button(
                            onClick = {
                                val checkinStr = formatCheckinDateTime(inputDate, inputTime)
                                onUpdateCompletedDates(completedDates + checkinStr)
                                onDismiss()
                            },
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp)
                        ) {
                            Text("打卡", fontSize = 11.sp)
                        }
                        OutlinedButton(
                            onClick = onDismiss,
                            modifier = Modifier.weight(1f),
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp)
                        ) {
                            Text("取消", fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
}
