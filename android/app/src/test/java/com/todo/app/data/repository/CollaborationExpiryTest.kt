package com.todo.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class CollaborationExpiryTest {
    private val serverTime = "Tue, 15 Nov 1994 08:12:31 GMT"
    private val serverEpoch = Instant.parse("1994-11-15T08:12:31Z").epochSecond

    @Test
    fun permanentAuthorizationDoesNotRequireServerTime() {
        assertNull(collaborationExpiryFailure(null, ""))
        assertNull(collaborationExpiryFailure(null, "invalid"))
    }

    @Test
    fun finiteAuthorizationRequiresParseableServerTime() {
        val locked = "无法校验网络安全时间，授权已锁定"
        assertEquals(locked, collaborationExpiryFailure(serverEpoch, ""))
        assertEquals(locked, collaborationExpiryFailure(serverEpoch, "invalid"))
    }

    @Test
    fun expirationUsesStrictlyGreaterThanComparison() {
        assertNull(collaborationExpiryFailure(serverEpoch, serverTime))
        assertNull(collaborationExpiryFailure(serverEpoch + 1, serverTime))
        assertEquals("EXPIRED", collaborationExpiryFailure(serverEpoch - 1, serverTime))
    }
}
