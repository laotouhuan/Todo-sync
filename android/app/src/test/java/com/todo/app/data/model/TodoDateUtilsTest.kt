package com.todo.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class TodoDateUtilsTest {

    @Test
    fun testIsWeekDate() {
        assertTrue(isWeekDate("2026-W03"))
        assertFalse(isWeekDate("2026-03-01"))
        assertFalse(isWeekDate("2026-03"))
        assertFalse(isWeekDate(null))
    }

    @Test
    fun testIsMonthDate() {
        assertTrue(isMonthDate("2026-06"))
        assertFalse(isMonthDate("2026-W06"))
        assertFalse(isMonthDate("2026-06-01"))
        assertFalse(isMonthDate(null))
    }

    @Test
    fun testWeekStringOf() {
        val date = LocalDate.of(2026, 1, 15)
        assertEquals("2026-W03", weekStringOf(date))
        
        // Test year boundary (Dec 31, 2024 is in week 1 of 2025)
        val boundaryDate = LocalDate.of(2024, 12, 31)
        assertEquals("2025-W01", weekStringOf(boundaryDate))
    }

    @Test
    fun testMonthStringOf() {
        val date = LocalDate.of(2026, 1, 15)
        assertEquals("2026-01", monthStringOf(date))
    }

    @Test
    fun testCategorizeTimeSlot() {
        // morning: 6-11
        assertEquals("morning", categorizeTimeSlot("2026-06-15T08:00:00+08:00"))
        // afternoon: 12-17
        assertEquals("afternoon", categorizeTimeSlot("2026-06-15T14:30:00+08:00"))
        // evening: 18-23
        assertEquals("evening", categorizeTimeSlot("2026-06-15T20:15:00+08:00"))
        // night: 0-5
        assertEquals("night", categorizeTimeSlot("2026-06-15T02:00:00+08:00"))
        // unknown
        assertEquals("unknown", categorizeTimeSlot(null))
        assertEquals("unknown", categorizeTimeSlot("invalid-date"))
    }

    @Test
    fun testIsOverdue() {
        val todo = Todo.create("Test", date = "2026-06-10")
        
        // Not completed, date is past
        assertTrue(todo.isOverdue("2026-06-15"))
        
        // Not completed, date is future/today
        assertFalse(todo.isOverdue("2026-06-10"))
        assertFalse(todo.isOverdue("2026-06-05"))
        
        // Completed -> not overdue
        todo.completed = true
        assertFalse(todo.isOverdue("2026-06-15"))
        
        // Weekly tasks -> not overdue
        val weeklyTodo = Todo.create("Test", date = "2026-W03")
        assertFalse(weeklyTodo.isOverdue("2026-06-15"))
    }

    @Test
    fun testGetDateLabel() {
        val todo1 = Todo.create("Test", date = "2026-06-15")
        assertEquals("今天", todo1.getDateLabel("2026-06-15", "2026-06-16"))
        assertEquals("明天", todo1.getDateLabel("2026-06-14", "2026-06-15"))
        assertEquals("06-15", todo1.getDateLabel("2026-06-01", "2026-06-02"))

        val weeklyTodo = Todo.create("Test", date = "2026-W03")
        assertEquals("周任务", weeklyTodo.getDateLabel("2026-06-15", "2026-06-16"))

        val monthlyTodo = Todo.create("Test", date = "2026-06")
        assertEquals("月任务", monthlyTodo.getDateLabel("2026-06-15", "2026-06-16"))
    }
}
