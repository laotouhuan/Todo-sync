package com.todo.app.data.repository

import com.todo.app.data.model.ShareCodePayload
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ShareCodeCodecTest {
    private val payload = ShareCodePayload("https://example.test/dav/", "fake", " fake-password ", "清单/todo_data.json")

    @Test fun androidAndWindowsUseIdenticalFixedVector() {
        val expected = "tdsync://AAECAwQFBgcICQoLxSI6rslQ52PCxcr4pKP+HmFNFGGj850ZGLoMUfakTjFHV71GJL1W//6Mki8L21FBGaxixdWRDoZzBdXCPhvPmo9K4l0GPPv+6v/eCqWOr+GGSr+yuGWCefcQ6h8bjv4U8Y3H+ystspXaRgdDGHKjxcOAzdiAO427EjGROwBxkxfW"
        val key = "AbCdEf012345"
        val result = ShareCodeCodec.encrypt(payload, key, ByteArray(12) { it.toByte() })
        assertEquals(expected, result.first)
        assertEquals(payload, Json.decodeFromString<ShareCodePayload>(ShareCodeCodec.decrypt(expected, key)))
    }

    @Test fun wrongKeyOrTruncatedCodeNeverReachesHttp() {
        val (code, _) = ShareCodeCodec.encrypt(payload)
        assertTrue(runCatching { ShareCodeCodec.decrypt(code, "wrong-key") }.isFailure)
        assertTrue(runCatching { ShareCodeCodec.decrypt("tdsync://broken", "key") }.isFailure)
    }
}
