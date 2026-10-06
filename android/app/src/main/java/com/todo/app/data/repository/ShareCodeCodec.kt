package com.todo.app.data.repository

import com.todo.app.data.model.ShareCodePayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 保留已发布的 SHA-256 / AES-GCM / IV+密文+标签格式。 */
internal object ShareCodeCodec {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }

    fun encrypt(payload: ShareCodePayload, key: String = generateShareCodeKey(),
        iv: ByteArray = ByteArray(12).also { SecureRandom().nextBytes(it) }): Pair<String, String> {
        val cipher = cipher(Cipher.ENCRYPT_MODE, key, iv)
        val encrypted = cipher.doFinal(json.encodeToString(payload).toByteArray(Charsets.UTF_8))
        return "tdsync://${Base64.getEncoder().encodeToString(iv + encrypted)}" to key
    }

    fun decrypt(code: String, key: String): String {
        require(code.startsWith("tdsync://")) { "授权码须以 tdsync:// 开头" }
        val packed = Base64.getDecoder().decode(code.removePrefix("tdsync://"))
        require(packed.size >= 28) { "授权码数据损坏" }
        return String(cipher(Cipher.DECRYPT_MODE, key, packed.copyOfRange(0, 12))
            .doFinal(packed.copyOfRange(12, packed.size)), Charsets.UTF_8)
    }

    private fun cipher(mode: Int, key: String, iv: ByteArray): Cipher {
        val keyBytes = MessageDigest.getInstance("SHA-256").digest(key.trim().toByteArray(Charsets.UTF_8))
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        }
    }
}
