package com.todo.app.ui.view

import com.todo.app.ui.theme.SupportingText

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import com.todo.app.data.model.Learning
import com.todo.app.data.model.PeriodComparisonDay
import kotlin.math.ceil

data class PeriodSelectOption(val id: String, val label: String, val enabled: Boolean = true)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeriodPicker(label: String, value: String?, options: List<PeriodSelectOption>, enabled: Boolean = true, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded && enabled, onExpandedChange = { if (enabled) expanded = it }) {
        OutlinedTextField(
            value = options.find { it.id == value }?.label ?: "请选择",
            onValueChange = {}, readOnly = true, enabled = enabled,
            label = { Text(label) }, singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded && enabled) },
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.menuAnchor().fillMaxWidth()
        )
        ExposedDropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            options.forEach { option ->
                DropdownMenuItem(text = { Text(option.label) }, enabled = option.enabled,
                    onClick = { onSelect(option.id); expanded = false })
            }
        }
    }
}

@Composable
fun PeriodDailyBars(first: List<PeriodComparisonDay>, second: List<PeriodComparisonDay>, type: String, firstLabel: String, secondLabel: String) {
    val count = maxOf(first.size, second.size)
    var selectedDay by remember(firstLabel, secondLabel) { mutableIntStateOf(0) }
    val maximum = (first + second).maxOfOrNull { it.duration ?: 0 } ?: 0
    val step = if (maximum <= 3600000) 900000L else 3600000L
    val ceiling = maxOf(step, ceil(maximum.toDouble() / step).toLong() * step)
    fun axisLabel(value: Long): String {
        val unit = if (ceiling >= 3600000) 3600000.0 else 60000.0
        val number = (value / unit).toString().removeSuffix(".0")
        return number + if (ceiling >= 3600000) "时" else "分"
    }
    val colors = listOf(MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.secondary)
    fun dayValue(day: PeriodComparisonDay?) = day?.duration?.let { Learning.duration(it) } ?: day?.status ?: "无此日期"
    Text("每日总时长", style = MaterialTheme.typography.titleMedium)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf("查看：$firstLabel", "对比：$secondLabel").forEachIndexed { index, label ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(9.dp).clip(RoundedCornerShape(2.dp)).background(colors[index]))
                Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columnWidth = if (type == "week") ((maxWidth - 40.dp) / 7).coerceAtLeast(30.dp) else 40.dp
        Row {
            Column(Modifier.width(40.dp).height(160.dp), verticalArrangement = Arrangement.SpaceBetween) {
                Text(axisLabel(ceiling), style = MaterialTheme.typography.labelSmall)
                Text(axisLabel(ceiling / 2), style = MaterialTheme.typography.labelSmall)
                Text("0", style = MaterialTheme.typography.labelSmall)
            }
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                repeat(count) { index ->
                    val label = if (type == "week") listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")[index] else "${index + 1}日"
                    Column(
                        Modifier.width(columnWidth).clip(RoundedCornerShape(5.dp))
                            .background(if (selectedDay == index) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                            .clickable(role = Role.Button) { selectedDay = index }
                            .semantics(mergeDescendants = true) {
                                selected = selectedDay == index
                                contentDescription = "$label，查看周期 ${dayValue(first.getOrNull(index))}，对比周期 ${dayValue(second.getOrNull(index))}"
                            }, horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Row(Modifier.height(160.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            listOf(first.getOrNull(index), second.getOrNull(index)).forEachIndexed { series, day ->
                                if (day?.duration == null) Text("—", style = MaterialTheme.typography.labelSmall)
                                else {
                                    val height = (160f * day.duration / ceiling).dp.coerceAtLeast(2.dp)
                                    Box(Modifier.width(9.dp).height(height).clip(RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
                                        .background(colors[series].copy(alpha = if (day.duration == 0L) .5f else 1f)))
                                }
                            }
                        }
                        Text(label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(vertical = 8.dp))
                    }
                }
            }
        }
    }
    HorizontalDivider()
    val a = first.getOrNull(selectedDay); val b = second.getOrNull(selectedDay)
    Column {
        Text("查看 · ${a?.date ?: "无此日期"}：${dayValue(a)}", style = MaterialTheme.typography.bodySmall)
        Text("对比 · ${b?.date ?: "无此日期"}：${dayValue(b)}", style = MaterialTheme.typography.bodySmall)
        if (a?.duration != null && b?.duration != null) {
            val delta = a.duration - b.duration
            Text(if (delta == 0L) "当天时长相同" else "当天${if (delta < 0) "少" else "多"} ${Learning.duration(kotlin.math.abs(delta))}", style = MaterialTheme.typography.bodySmall)
        }
    }
    SupportingText("点击日期查看当天差异；左右滑动查看更多。— 表示未到、未纳入或无数据。")
}
