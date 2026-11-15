package com.todo.app.data.recordsync

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

internal const val MAX_BYTES = 1024 * 1024
private const val MAX_DEPTH = 128
internal fun bad(code: String): Nothing = throw IllegalArgumentException(code)

// 内层JSON使用自己的AST，重复键不能在普通Map解析后才检查。
internal sealed interface Value
internal data object Nil : Value
internal data class Bool(val value: Boolean) : Value
internal data class Num(val value: Double) : Value
internal data class Str(val value: String) : Value
internal data class Arr(val values: List<Value>) : Value
internal data class Obj(val values: Map<String, Value>) : Value

internal fun validString(text: String): String {
    var index = 0
    while (index < text.length) {
        val first = text[index].code
        val point = when {
            first in 0xd800..0xdbff -> {
                if (index + 1 >= text.length || text[index + 1].code !in 0xdc00..0xdfff) bad("INVALID_UNICODE")
                Character.toCodePoint(text[index++], text[index])
            }
            first in 0xdc00..0xdfff -> bad("INVALID_UNICODE")
            else -> first
        }
        if (point in 0xfdd0..0xfdef || point and 0xffff >= 0xfffe) bad("INVALID_UNICODE")
        index++
    }
    return text
}

internal class Parser(private val text: String) {
    private var at = 0
    private fun space() { while (at < text.length && text[at] in " \t\r\n") at++ }
    private fun string(): String {
        if (at >= text.length || text[at++] != '"') bad("INVALID_JSON")
        val result = StringBuilder()
        while (at < text.length) {
            val char = text[at++]
            when {
                char == '"' -> return validString(result.toString())
                char == '\\' -> {
                    if (at >= text.length) bad("INVALID_JSON")
                    when (val escaped = text[at++]) {
                        '"', '\\', '/' -> result.append(escaped)
                        'b' -> result.append('\b')
                        'f' -> result.append('\u000c')
                        'n' -> result.append('\n')
                        'r' -> result.append('\r')
                        't' -> result.append('\t')
                        'u' -> {
                            if (at + 4 > text.length) bad("INVALID_JSON")
                            val digits = text.substring(at, at + 4)
                            if (!digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) bad("INVALID_JSON")
                            result.append(digits.toInt(16).toChar()); at += 4
                        }
                        else -> bad("INVALID_JSON")
                    }
                }
                char.code < 0x20 -> bad("INVALID_JSON")
                else -> result.append(char)
            }
        }
        bad("INVALID_JSON")
    }
    private fun value(depth: Int): Value {
        if (depth > MAX_DEPTH) bad("JSON_DEPTH_LIMIT")
        space()
        if (at >= text.length) bad("INVALID_JSON")
        when (text[at]) {
            '"' -> return Str(string())
            '{' -> {
                at++; space()
                val result = linkedMapOf<String, Value>()
                if (at < text.length && text[at] == '}') { at++; return Obj(result) }
                while (at < text.length) {
                    val key = string()
                    if (result.containsKey(key)) bad("DUPLICATE_JSON_KEY")
                    space(); if (at >= text.length || text[at++] != ':') bad("INVALID_JSON")
                    result[key] = value(depth + 1); space()
                    if (at < text.length && text[at] == '}') { at++; return Obj(result) }
                    if (at >= text.length || text[at++] != ',') bad("INVALID_JSON")
                    space()
                }
                bad("INVALID_JSON")
            }
            '[' -> {
                at++; space()
                val result = mutableListOf<Value>()
                if (at < text.length && text[at] == ']') { at++; return Arr(result) }
                while (at < text.length) {
                    result.add(value(depth + 1)); space()
                    if (at < text.length && text[at] == ']') { at++; return Arr(result) }
                    if (at >= text.length || text[at++] != ',') bad("INVALID_JSON")
                    space()
                }
                bad("INVALID_JSON")
            }
            else -> {
                for ((literal, parsed) in listOf("true" to Bool(true), "false" to Bool(false), "null" to Nil)) {
                    if (text.startsWith(literal, at)) { at += literal.length; return parsed }
                }
                val matcher = NUMBER.matcher(text).region(at, text.length)
                if (!matcher.lookingAt()) bad("INVALID_JSON")
                val number = matcher.group().toDoubleOrNull() ?: bad("INVALID_JSON_NUMBER")
                if (!number.isFinite()) bad("INVALID_JSON_NUMBER")
                at = matcher.end()
                return Num(number)
            }
        }
    }
    fun parse(): Value {
        val result = value(0); space()
        if (at != text.length) bad("INVALID_JSON")
        return result
    }
    companion object { private val NUMBER = java.util.regex.Pattern.compile("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?") }
}

// 直接从binary64精确值寻找最短往返十进制，不能用Java Double.toString代替ECMAScript。
internal fun number(value: Double): String {
    if (!value.isFinite()) bad("INVALID_JSON_NUMBER")
    if (value == 0.0) return "0"
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
    val decimal = selected ?: bad("DECIMAL_ROUNDTRIP_FAILED")
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
    validString(text)
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

internal fun render(value: Value): String = when (value) {
    Nil -> "null"
    is Bool -> if (value.value) "true" else "false"
    is Num -> number(value.value)
    is Str -> quoted(value.value)
    is Arr -> value.values.joinToString(",", "[", "]") { render(it) }
    is Obj -> value.values.keys.sorted().joinToString(",", "{", "}") { quoted(it) + ":" + render(value.values.getValue(it)) }
}

internal fun utf8(bytes: ByteArray): String = try {
    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()
} catch (_: Exception) { bad("INVALID_UTF8") }
internal fun canonical(value: Value): ByteArray = render(value).toByteArray(Charsets.UTF_8).also { if (it.size > MAX_BYTES) bad("JSON_SIZE_LIMIT") }
internal fun parse(bytes: ByteArray, strict: Boolean): Value {
    if (bytes.size > MAX_BYTES) bad("JSON_SIZE_LIMIT")
    val result = Parser(utf8(bytes)).parse()
    val encoded = canonical(result)
    if (strict && !encoded.contentEquals(bytes)) bad("NON_CANONICAL_JSON")
    return result
}
internal fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
