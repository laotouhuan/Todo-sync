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
export function getThisMonthString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

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

// ====== Input Parsing ======

/**
 * Parse @date syntax from raw input text.
 * Supports: @today, @tomorrow, @week, @month, @YYYY-MM-DD, @MM-DD
 */
export function parseInputSyntax(rawContent) {
    const dateRegex = /(?:\s+|^)@(today|tomorrow|week|month|day|daily|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:[*/:](\d*))?$/i;

    let content = rawContent.trim();
    let taskDate = null;
    let taskType = 'normal';
    let targetCount = null;

    const dateMatch = content.match(dateRegex);
    if (dateMatch) {
        const v = dateMatch[1].toLowerCase();
        const countStr = dateMatch[2];
        
        if (v === 'today') taskDate = getTodayString();
        else if (v === 'tomorrow') taskDate = getTomorrowString();
        else if (v === 'day' || v === 'daily') {
            taskDate = getTodayString();
            taskType = 'daily_repeat';
        }
        else if (v === 'week') {
            taskDate = getThisWeekString();
            taskType = 'weekly_checkin';
            targetCount = (countStr && countStr !== "") ? parseInt(countStr, 10) : null;
        }
        else if (v === 'month') {
            taskDate = getThisMonthString();
            taskType = 'monthly_checkin';
            targetCount = (countStr && countStr !== "") ? parseInt(countStr, 10) : null;
        }
        else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) taskDate = v;
        else if (/^\d{2}-\d{2}$/.test(v)) taskDate = `${new Date().getFullYear()}-${v}`;
        
        content = content.replace(dateRegex, '').trim();
    }

    return { content, taskDate, taskType, targetCount };
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
        task_type: 'normal',
        completed_dates: [],
        target_count: null,
        subtasks: []
    };
}

// ====== Todo Grouping (for "all" view) ======

/**
 * Group todos by date category for the "all tasks" view.
 * Returns { todayGroup, noDateGroup, weekGroup, monthGroup, futureGroup, pastGroup }
 */
export function groupTodosByDate(todos, todayStr) {
    const today = new Date(todayStr + 'T00:00:00');
    const thisWeekStr = getISOWeekString(today);
    const thisMonthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

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
        if (todo.task_type === 'weekly_checkin' || isWeekDate(d)) {
            const weekVal = d || thisWeekStr;
            if (weekVal === thisWeekStr) {
                groups.weekGroup.push(todo);
            } else if (weekVal < thisWeekStr) {
                groups.pastGroup.push(todo);
            } else {
                groups.futureGroup.push(todo);
            }
        } else if (todo.task_type === 'monthly_checkin' || isMonthDate(d)) {
            const monthVal = d || thisMonthStr;
            if (monthVal === thisMonthStr) {
                groups.monthGroup.push(todo);
            } else if (monthVal < thisMonthStr) {
                groups.pastGroup.push(todo);
            } else {
                groups.futureGroup.push(todo);
            }
        } else if (!d) {
            groups.noDateGroup.push(todo);
        } else if (d === todayStr) {
            groups.todayGroup.push(todo);
        } else if (d > todayStr) {
            groups.futureGroup.push(todo);
        } else {
            groups.pastGroup.push(todo);
        }
    });

    return groups;
}

export function getLastWeekString(date = new Date()) {
    const target = new Date(date);
    target.setDate(target.getDate() - 7);
    return getISOWeekString(target);
}

export function getLastMonthString(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth(); // 0-11
    if (month === 0) {
        return `${year - 1}-12`;
    }
    return `${year}-${String(month).padStart(2, '0')}`;
}

// ====== Stats Helpers ======

/**
 * Categorize completed task by local time.
 * @param {string} isoTimestamp 
 * @returns {string} 'morning' | 'afternoon' | 'evening' | 'night' | 'unknown'
 */
export function categorizeByTimeSlot(isoTimestamp) {
    if (!isoTimestamp) return 'unknown';
    try {
        const date = new Date(isoTimestamp);
        if (isNaN(date.getTime())) return 'unknown';
        const hours = date.getHours();
        if (hours >= 6 && hours < 12) return 'morning';      // 6-11
        if (hours >= 12 && hours < 18) return 'afternoon';   // 12-17
        if (hours >= 18 && hours < 24) return 'evening';     // 18-23
        return 'night';                                      // 0-5
    } catch (e) {
        return 'unknown';
    }
}

/**
 * Calculate the number of days a task has existed.
 * @param {string} createdAt ISO timestamp
 * @param {Date|string} [now] Current date reference
 * @returns {number} Age in days, or -1 if createdAt is invalid
 */
export function calcTaskAgeDays(createdAt, now = new Date()) {
    if (!createdAt) return -1;
    try {
        const createdMs = new Date(createdAt).getTime();
        const nowMs = new Date(now).getTime();
        if (isNaN(createdMs) || isNaN(nowMs)) return -1;
        const diff = nowMs - createdMs;
        if (diff < 0) return 0;
        return Math.floor(diff / 86400000);
    } catch (e) {
        return -1;
    }
}

/**
 * Get health grade based on average age of incomplete tasks.
 * @param {number} avgAgeDays 
 * @returns {object} { grade: 'A'|'B'|'C', text: string, color: string }
 */
export function getHealthGrade(avgAgeDays) {
    if (isNaN(avgAgeDays) || avgAgeDays <= 0) {
        return { grade: 'A', text: '清单已清空，太棒了！', color: '#22c55e' };
    }
    if (avgAgeDays < 3) {
        return { grade: 'A', text: '你的清单代谢非常健康！', color: '#22c55e' };
    }
    if (avgAgeDays < 7) {
        return { grade: 'B', text: '清单状态良好，继续保持', color: '#f59e0b' };
    }
    return { grade: 'C', text: '清单有些积压，试试清理一下？', color: '#ef4444' };
}
