package com.todo.app.data.model

import java.time.LocalDate

// ====== Input Parsing ======

private val DATE_REGEX = Regex("""(?:\s+|^)@(today|tomorrow|none|week|month|day|daily|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:[*/:](\d*))?$""", RegexOption.IGNORE_CASE)
private val FULL_DATE_REGEX = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val SHORT_DATE_REGEX = Regex("""^\d{2}-\d{2}$""")
private val FULL_WIDTH_DIGIT_REGEX = Regex("""[０-９]""")

data class ParsedSyntax(
    val content: String,
    val date: String?,
    val taskType: String = TaskType.NORMAL,
    val targetCount: Int? = null,
    val subtasks: List<String> = emptyList(),
    val hasExplicitDateSyntax: Boolean = false
)

/**
 * Parse @date syntax from raw input text.
 * Supports: @today, @tomorrow, @week, @month, @YYYY-MM-DD, @MM-DD
 * Returns a ParsedSyntax object.
 */
fun parseDateSyntax(rawContent: String): ParsedSyntax {
    var content = rawContent.trim()
    
    // 提取 #子任务（要求紧跟非空白字符，并且非 @ 和 #）
    val subtaskRegex = Regex("""#([^\s#@][^#@]*)""")
    val subtasks = subtaskRegex.findAll(content)
        .map { it.groupValues[1].trim() }
        .filter { it.isNotEmpty() }
        .toList()
    content = subtaskRegex.replace(content, "").trim()

    var taskDate: String? = null
    var taskType = TaskType.NORMAL
    var targetCount: Int? = null
    var hasExplicitDateSyntax = false

    val dateMatch = DATE_REGEX.find(content)
    if (dateMatch != null) {
        hasExplicitDateSyntax = true
        val dateVal = dateMatch.groupValues[1].lowercase()
        taskDate = when (dateVal) {
            "none" -> null
            "today" -> LocalDate.now().toString()
            "tomorrow" -> LocalDate.now().plusDays(1).toString()
            "day", "daily" -> {
                taskType = TaskType.DAILY_REPEAT
                LocalDate.now().toString()
            }
            "week" -> {
                taskType = TaskType.WEEKLY_CHECKIN
                targetCount = dateMatch.groupValues.getOrNull(2)?.toIntOrNull()
                weekStringOf(LocalDate.now())
            }
            "month" -> {
                taskType = TaskType.MONTHLY_CHECKIN
                targetCount = dateMatch.groupValues.getOrNull(2)?.toIntOrNull()
                monthStringOf(LocalDate.now())
            }
            else -> parseFlexibleDate(dateVal)
        }
        content = content.removeRange(dateMatch.range).trim()
    }

    return ParsedSyntax(content, taskDate, taskType, targetCount, subtasks, hasExplicitDateSyntax)
}

/**
 * Parse a flexible date string: either full (YYYY-MM-DD) or short (MM-DD).
 * Returns the normalized date string or null if parsing fails.
 */
fun parseFlexibleDate(dateVal: String): String? {
    return when {
        FULL_DATE_REGEX.matches(dateVal) -> dateVal
        SHORT_DATE_REGEX.matches(dateVal) -> "${LocalDate.now().year}-$dateVal"
        else -> null
    }
}

/**
 * Normalize date input by trimming whitespace, removing extra separators,
 * and converting common aliases to standard format.
 */
fun normalizeDateInput(input: String): String {
    var result = input.trim()
    // Normalize full-width digits to half-width
    result = FULL_WIDTH_DIGIT_REGEX.replace(result) { match ->
        (match.value[0].code - 0xFF10 + '0'.code).toChar().toString()
    }
    // Normalize dashes
    result = result.replace('–', '-').replace('—', '-')
    return result
}
