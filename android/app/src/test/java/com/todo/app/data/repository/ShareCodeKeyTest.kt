package com.todo.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

class ShareCodeKeyTest {
    @Test
    fun generatedKeysKeepTheExistingTwelveCharacterFormat() {
        val key = generateShareCodeKey()

        assertEquals(12, key.length)
        assertTrue(key.all { it in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" })
    }

    @Test
    fun generatedCharactersUseSecureRandomIndexes() {
        val random = object : SecureRandom() {
            override fun nextInt(bound: Int): Int = bound - 1
        }

        assertEquals("9".repeat(12), generateShareCodeKey(random))
    }
}
