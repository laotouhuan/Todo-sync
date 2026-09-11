package com.todo.app.ui.view

import org.junit.Assert.*
import org.junit.Test

class ClockEntryAnimationTest {
    @Test fun pointsAppearInTimeOrderAndMidnightBoundaryFinishesVisible() {
        assertEquals(0f, clockEntryAlpha(.5f, 721.0), 0f)
        assertTrue(clockEntryAlpha(.5f, 700.0) > clockEntryAlpha(.5f, 710.0))
        assertEquals(0f, clockEntryAlpha(0f, 0.0), 0f)
        assertEquals(1f, clockEntryAlpha(1f, 1439.999), 0f)
    }

    @Test fun arcRevealsOnlyItsOwnIntervalAndFullDayCanFinish() {
        assertEquals(0f, clockArcSweep(.25f, 540f, 720f), 0f)
        assertEquals(15f, clockArcSweep(600f / 1440, 540f, 720f), .001f)
        assertEquals(45f, clockArcSweep(1f, 540f, 720f), 0f)
        assertEquals(360f, clockArcSweep(1f, 0f, 1440f), 0f)
    }
}
