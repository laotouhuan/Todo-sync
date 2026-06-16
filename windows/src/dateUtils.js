/**
 * Date utility functions shared across the application.
 * Extracted from main.js to eliminate duplication.
 */

// ====== Date Formatting ======

export function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function getISOWeekString(d) {
    const date = new Date(d.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
    const week1 = new Date(date.getFullYear(), 0, 4);
    const week = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ====== Convenience Date Strings ======

export function getTodayString() { return formatDate(new Date()); }
export function getTomorrowString() { const d = new Date(); d.setDate(d.getDate() + 1); return formatDate(d); }
export function getThisWeekString() { return getISOWeekString(new Date()); }
export function getLastWeekString() { const d = new Date(); d.setDate(d.getDate() - 7); return getISOWeekString(d); }
export function getThisMonthString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
export function getLastMonthString() { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

// ====== Date Type Checks ======

/**
 * Check if a date string represents a weekly period (e.g. "2026-W03").
 */
export function isWeekDate(dateStr) {
    return dateStr && dateStr.includes('-W');
}

/**
 * Check if a date string represents a monthly period (e.g. "2026-06").
 */
export function isMonthDate(dateStr) {
    return dateStr && dateStr.length === 7 && !dateStr.includes('-W');
}

/**
 * Check if a todo is overdue.
 * A todo is overdue when its specific date (not week/month) is before today and it's not completed.
 */
export function isOverdue(todo, todayStr) {
    if (!todo.date || todo.completed) return false;
    // Exclude week and month tasks — they don't have a specific due date
    if (isWeekDate(todo.date) || isMonthDate(todo.date)) return false;
    return todo.date < todayStr;
}

/**
 * Get a human-readable label for a date string.
 */
export function getDateLabel(dateStr, todayStr, tomorrowStr) {
    if (!dateStr) return '';
    if (dateStr === todayStr) return '今天';
    if (dateStr === tomorrowStr) return '明天';
    if (isWeekDate(dateStr)) return '周任务';
    if (isMonthDate(dateStr)) return '月任务';
    return dateStr.substring(5); // show MM-DD
}

/**
 * Get completion status label relative to due date.
 * Returns null if not applicable, or one of: '逾期完成', '提前完成', '按时完成'
 */
export function getCompletionStatusLabel(todo) {
    if (!todo.completed || !todo.completed_at || !todo.date || todo.date.length !== 10) return null;
    const completedDateStr = todo.completed_at.substring(0, 10);
    if (completedDateStr > todo.date) return '逾期完成';
    if (completedDateStr < todo.date) return '提前完成';
    return '按时完成';
}

// ====== Sorting ======

export function sortFunc(a, b) {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return new Date(b.created_at) - new Date(a.created_at);
}

// ====== Recurring Dates ======

export function getNextRecurringDate(baseDateStr, rule) {
    const d = new Date(baseDateStr);
    if (isNaN(d.getTime())) return baseDateStr;
    if (rule === 'daily') d.setDate(d.getDate() + 1);
    else if (rule === 'weekly') d.setDate(d.getDate() + 7);
    else if (rule === 'monthly') d.setMonth(d.getMonth() + 1);
    return formatDate(d);
}

// ====== Input Parsing ======

/**
 * Parse @date syntax from raw input text.
 * Supports: @today, @tomorrow, @week, @month, @YYYY-MM-DD, @MM-DD
 */
export function parseInputSyntax(rawContent) {
    const dateRegex = /(?:\s+|^)@(today|tomorrow|week|month|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/i;

    let content = rawContent.trim();
    let taskDate = null;

    const dateMatch = content.match(dateRegex);
    if (dateMatch) {
        const v = dateMatch[1].toLowerCase();
        if (v === 'today') taskDate = getTodayString();
        else if (v === 'tomorrow') taskDate = getTomorrowString();
        else if (v === 'week') taskDate = getThisWeekString();
        else if (v === 'month') taskDate = getThisMonthString();
        else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) taskDate = v;
        else if (/^\d{2}-\d{2}$/.test(v)) taskDate = `${new Date().getFullYear()}-${v}`;
        content = content.replace(dateRegex, '').trim();
    }

    return { content, taskDate };
}

// ====== Todo Factory ======

export function createTodo(content, date = null) {
    return {
        id: crypto.randomUUID(),
        content,
        date,
        time: null,
        completed: false,
        created_at: new Date().toISOString(),
        completed_at: null,
        order: Date.now(),
        updated_at: new Date().toISOString(),
        deleted: false,
        recurring: 'none',
        subtasks: []
    };
}

// ====== Todo Grouping (for "all" view) ======

/**
 * Group todos by date category for the "all tasks" view.
 * Returns { todayGroup, noDateGroup, weekGroup, monthGroup, futureGroup, pastGroup }
 */
export function groupTodosByDate(todos, todayStr) {
    const groups = {
        todayGroup: [],
        noDateGroup: [],
        weekGroup: [],
        monthGroup: [],
        futureGroup: [],
        pastGroup: []
    };

    todos.forEach(todo => {
        const d = todo.date;
        if (!d) {
            groups.noDateGroup.push(todo);
        } else if (d === todayStr) {
            groups.todayGroup.push(todo);
        } else if (isWeekDate(d)) {
            groups.weekGroup.push(todo);
        } else if (isMonthDate(d)) {
            groups.monthGroup.push(todo);
        } else if (d > todayStr) {
            groups.futureGroup.push(todo);
        } else {
            groups.pastGroup.push(todo);
        }
    });

    return groups;
}
