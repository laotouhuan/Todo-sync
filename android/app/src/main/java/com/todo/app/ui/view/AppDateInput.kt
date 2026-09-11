package com.todo.app.ui.view

import android.app.DatePickerDialog
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import java.time.LocalDate

/**
 * 通用双模日期输入组件：
 * 1. 支持直接通过单行文本框输入、编辑与粘贴 YYYY-MM-DD 格式日期；
 * 2. 输入框内右侧提供 📅 图标按钮，点击后唤起系统 DatePickerDialog 图形日历，选定后自动格式化回填；
 * 3. 支持通过 trailingAction 传入外部快捷操作（如 [明天] 按钮）。
 */
@Composable
fun AppDateInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "YYYY-MM-DD",
    trailingAction: (@Composable () -> Unit)? = null
) {
    val context = LocalContext.current

    fun showSystemDatePicker() {
        val initialDate = try {
            val trimmed = value.trim()
            if (trimmed.isNotEmpty() && trimmed.length >= 10) {
                LocalDate.parse(trimmed.take(10))
            } else {
                LocalDate.now()
            }
        } catch (_: Exception) {
            LocalDate.now()
        }

        DatePickerDialog(
            context,
            { _, year, month, dayOfMonth ->
                val formatted = String.format("%04d-%02d-%02d", year, month + 1, dayOfMonth)
                onValueChange(formatted)
            },
            initialDate.year,
            initialDate.monthValue - 1,
            initialDate.dayOfMonth
        ).show()
    }

    if (trailingAction != null) {
        Row(
            modifier = modifier,
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                label = label?.let { { Text(it) } },
                placeholder = { Text(placeholder) },
                singleLine = true,
                modifier = Modifier.weight(1f),
                trailingIcon = {
                    IconButton(onClick = { showSystemDatePicker() }) {
                        Icon(Icons.Filled.DateRange, contentDescription = "选择${label ?: "日期"}", modifier = Modifier.size(22.dp))
                    }
                }
            )
            trailingAction()
        }
    } else {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            label = label?.let { { Text(it) } },
            placeholder = { Text(placeholder) },
            singleLine = true,
            modifier = modifier,
            trailingIcon = {
                IconButton(onClick = { showSystemDatePicker() }) {
                    Icon(Icons.Filled.DateRange, contentDescription = "选择${label ?: "日期"}", modifier = Modifier.size(22.dp))
                }
            }
        )
    }
}
