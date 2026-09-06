package com.todo.app.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class TodoDateUtilsTest {

    @Test
    fun testValidateAndNormalizeTime() {
        assertEquals(Pair(true, "14:30"), validateAndNormalizeTime("14:30", "12:00"))
        assertEquals(Pair(true, "09:05"), validateAndNormalizeTime("9:5", "12:00"))
        assertEquals(Pair(true, "--:--"), validateAndNormalizeTime("--:--", "12:00"))
        assertEquals(Pair(true, "--:--"), validateAndNormalizeTime("", "12:00"))

        assertEquals(Pair(false, "14:30"), validateAndNormalizeTime("-1:00", "14:30"))
        assertEquals(Pair(false, "14:30"), validateAndNormalizeTime("25:00", "14:30"))
        assertEquals(Pair(false, "14:30"), validateAndNormalizeTime("12:60", "14:30"))
    }

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

        // Daily repeat tasks past date -> not overdue
        val dailyTodo = Todo.create("Test", date = "2026-06-10")
        dailyTodo.recurring = RecurringType.DAILY_REPEAT
        assertFalse(dailyTodo.isOverdue("2026-06-15"))

        // Monthly checkin tasks past date -> not overdue
        val monthlyTodo = Todo.create("Test", date = "2026-05")
        monthlyTodo.taskType = TaskType.MONTHLY_CHECKIN
        assertFalse(monthlyTodo.isOverdue("2026-06-15"))
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

    @Test
    fun testParseIsoToLocalDateTime() {
        // UTC format
        val ldt1 = parseIsoToLocalDateTime("2026-06-15T03:00:00Z")
        val instant1 = ldt1.atZone(java.time.ZoneId.systemDefault()).toInstant()
        assertEquals(java.time.Instant.parse("2026-06-15T03:00:00Z"), instant1)

        // Offset format (+08:00)
        val ldt2 = parseIsoToLocalDateTime("2026-06-15T11:00:00+08:00")
        val instant2 = ldt2.atZone(java.time.ZoneId.systemDefault()).toInstant()
        assertEquals(java.time.Instant.parse("2026-06-15T03:00:00Z"), instant2)
    }

    @Test
    fun testFormatCheckinDateTime() {
        val iso1 = formatCheckinDateTime("2026-08-02", "14:30")
        assertTrue(iso1.contains("2026-08-02T"))

        val iso2 = formatCheckinDateTime("2026-08-02", "9:5")
        assertTrue(iso2.contains("2026-08-02T"))

        assertEquals("2026-08-02", formatCheckinDateTime("2026-08-02", "--:--"))
        assertEquals("2026-08-02", formatCheckinDateTime("2026-08-02", ""))
        assertEquals("2026-08-02", formatCheckinDateTime("2026-08-02", "14:"))
        assertEquals("2026-08-02", formatCheckinDateTime("2026-08-02", "14:60"))
    }

    @Test
    fun testCreateFromParsed_DefaultDueDate() {
        val parsedWithoutDate = parseDateSyntax("买菜")
        
        // 1. defaultDueDate = "today"
        val todoToday = Todo.createFromParsed(
            parsed = parsedWithoutDate,
            currentList = emptyList(),
            defaultDueDatePref = "today"
        )
        assertEquals(LocalDate.now().toString(), todoToday.date)

        // 2. defaultDueDate = "tomorrow"
        val todoTomorrow = Todo.createFromParsed(
            parsed = parsedWithoutDate,
            currentList = emptyList(),
            defaultDueDatePref = "tomorrow"
        )
        assertEquals(LocalDate.now().plusDays(1).toString(), todoTomorrow.date)

        // 3. defaultDueDate = "none"
        val todoNone = Todo.createFromParsed(
            parsed = parsedWithoutDate,
            currentList = emptyList(),
            defaultDueDatePref = "none"
        )
        assertEquals(null, todoNone.date)

        // 4. 显式指定 @none 时，不受 defaultDueDate = "today" 覆盖
        val parsedExplicitNone = parseDateSyntax("买菜 @none")
        val todoExplicitNone = Todo.createFromParsed(
            parsed = parsedExplicitNone,
            currentList = emptyList(),
            defaultDueDatePref = "today"
        )
        assertEquals(null, todoExplicitNone.date)
    }

    @Test
    fun testCreateFromParsed_SubtasksAndInsertionOrder() {
        val parsedWithSubtasks = parseDateSyntax("大任务 #子步骤1 #子步骤2")
        val existingTodo1 = Todo.create("Existing 1").apply { order = 100.0 }
        val existingTodo2 = Todo.create("Existing 2").apply { order = 200.0 }
        val currentList = listOf(existingTodo1, existingTodo2)

        // 置顶插入
        val todoTop = Todo.createFromParsed(
            parsed = parsedWithSubtasks,
            currentList = currentList,
            defaultInsertion = "top"
        )
        assertEquals(2, todoTop.subtasks.size)
        assertEquals("子步骤1", todoTop.subtasks[0].content)
        assertEquals("子步骤2", todoTop.subtasks[1].content)
        assertTrue(todoTop.order < 100.0)

        // 置底插入
        val todoBottom = Todo.createFromParsed(
            parsed = parsedWithSubtasks,
            currentList = currentList,
            defaultInsertion = "bottom"
        )
        assertTrue(todoBottom.order > 200.0)
    }
}
