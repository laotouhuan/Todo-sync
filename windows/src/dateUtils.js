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
    const date = d instanceof Date ? new Date(d.getTime()) : new Date(d);
    if (isNaN(date.getTime())) return '';
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
    return /^\d{4}-W\d{2}$/.test(dateStr);
}

/**
 * Check if a date string represents a monthly period (e.g. "2026-06").
 */
export function isMonthDate(dateStr) {
    return /^\d{4}-\d{2}$/.test(dateStr);
}

/**
 * Check if a todo is overdue.
 * A todo is overdue when its specific date (not week/month) is before today and it's not completed.
 */
export function isOverdue(todo, todayStr) {
    if (!todo.date || todo.completed) return false;
    // Exclude week and month tasks — they don't have a specific due date
    if (isWeekDate(todo.date) || isMonthDate(todo.date)) return false;
    // Exclude recurring and checkin tasks — habit tasks do not have overdue status
    if (todo.recurring === 'daily_repeat' || todo.task_type === 'weekly_checkin' || todo.task_type === 'monthly_checkin') return false;
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
 * Convert ISO date-time string (e.g. UTC '2026-07-29T18:00:00Z') to local date string (e.g. '2026-07-30').
 */
export function getLocalDateStringFromISO(isoStr) {
    if (!isoStr) return '';
    if (isoStr.length === 10) return isoStr;
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.substring(0, 10);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** 将 Date 转换为本地 HH:mm；无效日期返回空字符串。 */
export function formatLocalTime(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    if (isNaN(value.getTime())) return '';
    const hour = String(value.getHours()).padStart(2, '0');
    const minute = String(value.getMinutes()).padStart(2, '0');
    return `${hour}:${minute}`;
}

/**
 * 将 ISO 时间或纯日期拆成本地表单可用的日期和时间。
 * 纯日期不会被当作 UTC 转换，避免跨时区后日期偏移。
 */
export function parseIsoToLocalDateTime(value, fallbackDate = '') {
    if (!value) return { date: fallbackDate, time: '' };
    const text = String(value);
    const datePrefix = text.substring(0, 10);
    const safeDatePrefix = /^\d{4}-\d{2}-\d{2}$/.test(datePrefix) ? datePrefix : fallbackDate;
    if (text.length <= 10 || !text.includes('T')) {
        return { date: safeDatePrefix, time: '' };
    }

    const date = new Date(text);
    if (isNaN(date.getTime())) {
        return { date: safeDatePrefix, time: '' };
    }
    return { date: formatDate(date), time: formatLocalTime(date) };
}

/** 将本地日期和时间合成为 ISO；未填写时间时保留纯日期。 */
export function combineLocalDateAndTimeToISO(dateValue, timeValue = '') {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
    if (!dateMatch) return null;
    if (!timeValue) return dateValue;

    const normalizedTime = validateAndNormalizeTime(timeValue, '');
    if (!normalizedTime.valid || normalizedTime.value === '--:--') return dateValue;

    const [, yearText, monthText, dayText] = dateMatch;
    const [hourText, minuteText] = normalizedTime.value.split(':');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    const isSameLocalValue = date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day &&
        date.getHours() === hour &&
        date.getMinutes() === minute;
    return isSameLocalValue ? date.toISOString() : null;
}

/** 格式化打卡日历悬浮提示。 */
export function formatCheckinDateTimeTooltip(value, fallbackDate = '') {
    const local = parseIsoToLocalDateTime(value, fallbackDate);
    return `日期: ${local.date || fallbackDate}\n时间: ${local.time || '--:--'}`;
}

/**
 * Validate and normalize a time input string (e.g. '14:30' or '--:--').
 * Returns { valid: true, value: 'HH:mm'|'--:--' } if valid,
 * or { valid: false, value: prevTime } if invalid.
 */
export function validateAndNormalizeTime(input, prevTime = '--:--') {
    if (!input) return { valid: true, value: '--:--' };
    const str = String(input).trim();
    if (str === '--:--' || str === '') return { valid: true, value: '--:--' };

    const parts = str.split(':');
    if (parts.length === 2) {
        const [hStr, mStr] = parts;
        if (hStr === '--' && mStr === '--') return { valid: true, value: '--:--' };
        if (/^\d{1,2}$/.test(hStr) && /^\d{1,2}$/.test(mStr)) {
            const h = parseInt(hStr, 10);
            const m = parseInt(mStr, 10);
            if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                const hh = String(h).padStart(2, '0');
                const mm = String(m).padStart(2, '0');
                return { valid: true, value: `${hh}:${mm}` };
            }
        }
    }
    return { valid: false, value: prevTime || '--:--' };
}

/**
 * Get completion status label relative to due date.
 * Returns null if not applicable, or one of: '逾期完成', '提前完成', '按时完成'
 */
export function getCompletionStatusLabel(todo) {
    if (!todo.completed || !todo.completed_at || !todo.date || todo.date.length !== 10) return null;
    const completedDateStr = getLocalDateStringFromISO(todo.completed_at);
    if (completedDateStr > todo.date) return '逾期完成';
    if (completedDateStr < todo.date) return '提前完成';
    return '按时完成';
}

// ====== Sorting ======

export function sortFunc(a, b) {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    // ISO 字符串字典序比较等同于时间序，无需创建 Date 对象
    return (b.created_at || '').localeCompare(a.created_at || '');
}

// ====== Input Parsing ======

/**
 * Parse @date syntax from raw input text.
 * Supports: @today, @tomorrow, @week, @month, @YYYY-MM-DD, @MM-DD
 */
export function parseInputSyntax(rawContent) {
    let content = rawContent.trim();
    
    // 提取 #子任务（要求紧跟非空白字符，并且非 @ 和 #）
    const subtaskRegex = /#([^\s#@][^#@]*)/g;
    const subtasks = [];
    let match;
    while ((match = subtaskRegex.exec(content)) !== null) {
        const st = match[1].trim();
        if (st) subtasks.push(st);
    }
    content = content.replace(subtaskRegex, '').trim();

    const dateRegex = /(?:\s+|^)@(today|tomorrow|none|week|month|day|daily|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:[*/:](\d*))?$/i;

    let taskDate = null;
    let taskType = 'normal';
    let targetCount = null;
    let hasExplicitDate = false;

    const dateMatch = content.match(dateRegex);
    if (dateMatch) {
        hasExplicitDate = true;
        const v = dateMatch[1].toLowerCase();
        const countStr = dateMatch[2];
        
        if (v === 'none') {
            taskDate = null;
        }
        else if (v === 'today') taskDate = getTodayString();
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

    return { content, taskDate, taskType, targetCount, subtasks, hasExplicitDate };
}

// ====== UUID Generator ======

export function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        try {
            return crypto.randomUUID();
        } catch (e) {
            // fallback if randomUUID fails in non-secure contexts
        }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ====== Todo Factory ======

export function createTodo(content, date = null, subtaskContents = []) {
    return {
        id: generateUUID(),
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
        label: null,
        reminder: null,
        subtasks: subtaskContents.map(sc => ({
            id: generateUUID(),
            content: sc,
            completed: false,
            completed_at: null
        }))
    };
}

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
    const createdMs = new Date(createdAt).getTime();
    const nowMs = new Date(now).getTime();
    if (isNaN(createdMs) || isNaN(nowMs)) return -1;
    const diff = nowMs - createdMs;
    if (diff < 0) return 0;
    return Math.floor(diff / 86400000);
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
