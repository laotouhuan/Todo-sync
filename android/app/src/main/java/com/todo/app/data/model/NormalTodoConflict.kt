package com.todo.app.data.model

import kotlinx.serialization.json.*
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.security.MessageDigest
import java.text.Normalizer
import java.time.LocalDate

/** 待办基础字段整条选择：实际毫秒时间、业务内容 UTF-16 序、完整规范 JSON 摘要。 */
internal object NormalTodoConflict {
    private val json = Json { encodeDefaults = true }

    fun normalize(todo: Todo): Todo {
        require(todo.taskType == TaskType.NORMAL) { "仅普通待办适用此归并规则" }
        return comparisonValue(todo, strictTimestamps = true)
    }

    private fun comparisonValue(todo: Todo, strictTimestamps: Boolean): Todo {
        val updated = if (strictTimestamps) todo.updatedAt.ifEmpty { todo.createdAt } else todo.updatedAt
        if (strictTimestamps) {
            timestampMillis(todo.createdAt)
            timestampMillis(updated)
            todo.completedAt?.let(::timestampMillis)
            todo.subtasks.forEach { it.completedAt?.let(::timestampMillis) }
        }
        require(todo.order.isFinite()) { "普通待办包含无效排序权重" }
        val normalized = todo.copy(updatedAt = updated, label = normalizeLabel(todo.label), targetCount = todo.targetCount?.takeIf { it > 0 })
        // 单端记录也要检查扩展里的数字与 Unicode，不能等到冲突才发现损坏数据。
        render(json.encodeToJsonElement(Todo.serializer(), normalized))
        return normalized
    }

    fun choose(first: Todo, second: Todo): Todo {
        val left = normalize(first)
        val right = normalize(second)
        return if (compare(left, right, left, right) >= 0) left else right
    }

    /** 周/月比较键可以归一，但必须返回既有候选，不能改掉零目标等周期业务值。 */
    fun choosePeriodBase(first: Todo, second: Todo): Todo {
        require(isPeriod(first) && isPeriod(second)) { "仅周/月待办适用周期基础字段选择" }
        val left = comparisonValue(first, strictTimestamps = false)
        val right = comparisonValue(second, strictTimestamps = false)
        return if (compare(left, right, first, second) >= 0) first else second
    }

    /** 单侧周期候选也检查有限 JSON 与 Unicode；检查副本不替换原时钟或目标。 */
    fun validatePeriodCandidate(todo: Todo): Todo {
        require(isPeriod(todo)) { "仅周/月待办适用周期候选校验" }
        comparisonValue(todo, strictTimestamps = false)
        return todo
    }

    fun isPeriod(todo: Todo): Boolean = todo.taskType == TaskType.WEEKLY_CHECKIN || todo.taskType == TaskType.MONTHLY_CHECKIN

    // 其他整条数据域共享相同编码，不另写数字格式、Unicode 或对象排序规则。
    fun businessKey(value: JsonElement): String = learning(value)
    fun canonicalDigest(value: JsonElement): String = sha(render(value))
    fun validateJson(value: JsonElement) { render(value) }

    private fun compare(left: Todo, right: Todo, leftFull: Todo, rightFull: Todo): Int {
        val lTime = runCatching { timestampMillis(left.updatedAt) }.getOrDefault(Long.MIN_VALUE)
        val rTime = runCatching { timestampMillis(right.updatedAt) }.getOrDefault(Long.MIN_VALUE)
        val time = lTime.compareTo(rTime)
        if (time != 0) return time
        val l = json.encodeToJsonElement(Todo.serializer(), left).jsonObject
        val r = json.encodeToJsonElement(Todo.serializer(), right).jsonObject
        val metadata = setOf("id", "created_at", "updated_at")
        val business = learning(JsonObject(l.filterKeys { it !in metadata }))
            .compareTo(learning(JsonObject(r.filterKeys { it !in metadata })))
        if (business != 0) return business
        // 周期业务键相等后仍须区分原候选表示，避免 0 与 null 等值重新依赖合并方向。
        val lFull = json.encodeToJsonElement(Todo.serializer(), leftFull)
        val rFull = json.encodeToJsonElement(Todo.serializer(), rightFull)
        return sha(render(lFull)).compareTo(sha(render(rFull)))
    }

    fun normalizeLabel(value: String?): String? {
        if (value == null) return null
        val normalized = Normalizer.normalize(value.trim { whitespace(it.code) }, Normalizer.Form.NFC)
        return normalized.takeUnless { it.isEmpty() || it == "未分类" }
    }

    private fun whitespace(code: Int): Boolean = code in 9..13 || code == 32 || code == 160 || code == 5760 ||
        code in 8192..8202 || code == 8232 || code == 8233 || code == 8239 || code == 8287 || code == 12288 || code == 65279

    private fun sha(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

    private fun validateString(text: String) {
        var at = 0
        while (at < text.length) {
            val char = text[at++]
            val code = if (char.isHighSurrogate()) {
                require(at < text.length && text[at].isLowSurrogate()) { "普通待办包含孤立代理字符" }
                Character.toCodePoint(char, text[at++])
            } else {
                require(!char.isLowSurrogate()) { "普通待办包含孤立代理字符" }
                char.code
            }
            require(code !in 0xfdd0..0xfdef && (code and 0xffff) !in 0xfffe..0xffff) { "普通待办包含 Unicode 非字符" }
        }
    }

    private fun learning(value: JsonElement): String = when (value) {
        JsonNull -> "n"
        is JsonPrimitive -> when {
            value.isString -> { validateString(value.content); "s${value.content.length}:${value.content}" }
            value.booleanOrNull != null -> if (value.boolean) "b1" else "b0"
            else -> "d" + number(value.double)
        }
        is JsonArray -> "a" + value.joinToString("") { learning(it) } + "e"
        is JsonObject -> "o" + value.keys.sorted().joinToString("") { learning(JsonPrimitive(it)) + learning(value.getValue(it)) } + "e"
    }

    private fun render(value: JsonElement): String = when (value) {
        JsonNull -> "null"
        is JsonPrimitive -> when {
            value.isString -> quoted(value.content)
            value.booleanOrNull != null -> value.boolean.toString()
            else -> number(value.double)
        }
        is JsonArray -> value.joinToString(",", "[", "]") { render(it) }
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { quoted(it) + ":" + render(value.getValue(it)) }
    }

    // 从 binary64 精确值寻找最短往返十进制，避免 Java 与 ECMAScript 的格式差异。
    private fun number(value: Double): String {
        require(value.isFinite()) { "普通待办包含无效数字" }
        if (value == 0.0) return "0"
        if (kotlin.math.abs(value) <= 9007199254740991.0 && value % 1.0 == 0.0) return value.toLong().toString()
        val absolute = kotlin.math.abs(value)
        val exact = BigDecimal(absolute)
        val exponent = exact.precision() - exact.scale() - 1
        var selected: BigDecimal? = null
        for (precision in 1..17) {
            val unit = BigDecimal.ONE.scaleByPowerOfTen(exponent - precision + 1)
            val rounded = exact.round(MathContext(precision, RoundingMode.HALF_EVEN))
            var best: BigDecimal? = null
            for (offset in -2..2) {
                val candidate = rounded.add(unit.multiply(BigDecimal.valueOf(offset.toLong()))).stripTrailingZeros()
                if (candidate.signum() <= 0 || candidate.precision() > precision || candidate.toDouble().toRawBits() != absolute.toRawBits()) continue
                val previous = best
                if (previous == null) best = candidate
                else {
                    val comparison = candidate.subtract(exact).abs().compareTo(previous.subtract(exact).abs())
                    val even = !candidate.divide(unit).toBigIntegerExact().testBit(0)
                    val oldEven = !previous.divide(unit).toBigIntegerExact().testBit(0)
                    if (comparison < 0 || comparison == 0 && even && !oldEven) best = candidate
                }
            }
            if (best != null) { selected = best; break }
        }
        val decimal = checkNotNull(selected) { "普通待办数字规范化失败" }
        val digits = decimal.unscaledValue().abs().toString()
        val point = digits.length - decimal.scale()
        val rendered = when {
            point in 1..21 -> if (point >= digits.length) digits + "0".repeat(point - digits.length)
                else digits.substring(0, point) + "." + digits.substring(point)
            point <= 0 && point > -6 -> "0." + "0".repeat(-point) + digits
            else -> digits.take(1) + (if (digits.length > 1) "." + digits.substring(1) else "") +
                "e" + (if (point - 1 >= 0) "+" else "-") + kotlin.math.abs(point - 1)
        }
        return (if (value < 0) "-" else "") + rendered
    }

    private fun quoted(text: String): String {
        validateString(text)
        val result = StringBuilder("\"")
        for (char in text) when (char) {
            '"' -> result.append("\\\"")
            '\\' -> result.append("\\\\")
            '\b' -> result.append("\\b")
            '\u000c' -> result.append("\\f")
            '\n' -> result.append("\\n")
            '\r' -> result.append("\\r")
            '\t' -> result.append("\\t")
            else -> if (char.code < 0x20) result.append("\\u" + char.code.toString(16).padStart(4, '0')) else result.append(char)
        }
        return result.append('"').toString()
    }

    /** 比较共享时间点：保留原文本，截去小于毫秒的小数，支持完整四位年份与显式时区。 */
    fun timestampMillis(text: String): Long {
        val match = Regex("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})")
            .matchEntire(text) ?: error("普通待办包含无效时间戳：$text")
        val groups = match.groupValues
        val day = try { LocalDate.of(groups[1].toInt(), groups[2].toInt(), groups[3].toInt()) }
            catch (_: Exception) { error("普通待办包含无效时间戳：$text") }
        val hour = groups[4].toInt(); val minute = groups[5].toInt(); val second = groups[6].toInt()
        require(hour <= 23 && minute <= 59 && second <= 59) { "普通待办包含无效时间戳：$text" }
        val zone = groups[8]
        val offset = if (zone == "Z") 0 else {
            val hours = zone.substring(1, 3).toInt(); val minutes = zone.substring(4, 6).toInt()
            require(hours <= 23 && minutes <= 59) { "普通待办包含无效时间戳：$text" }
            (hours * 3600 + minutes * 60) * if (zone[0] == '+') 1 else -1
        }
        val milliseconds = (groups[7] + "000").take(3).toInt()
        return (day.toEpochDay() * 86400 + hour * 3600 + minute * 60 + second - offset) * 1000 + milliseconds
    }
}
