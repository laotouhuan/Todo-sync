import { formatDate, getISOWeekString, isOverdue } from './dateUtils.js';

function isCheckin(todo) {
    return todo.task_type === 'weekly_checkin' || todo.task_type === 'monthly_checkin';
}

function isRecurring(todo) {
    return todo.recurring === 'daily_repeat' || isCheckin(todo);
}

// 完成记录按设备本地日期判断；旧版纯日期保持原意，无效时间不算完成证据。
function completionDate(value) {
    if (typeof value !== 'string' || !value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (!value.includes('T')) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : formatDate(date);
}

/** 与 Android 提醒执行使用相同口径，供设置页预览复用。 */
export function evaluateReminderRule(rule, todos, date = new Date()) {
    const today = formatDate(date);
    const week = getISOWeekString(date);
    const month = today.slice(0, 7);
    const active = todos.filter(todo => !todo.deleted);
    const hasCompletion = todo => isCheckin(todo)
        ? (todo.completed_dates || []).some(value => completionDate(value) === today)
        : Boolean(todo.completed && completionDate(todo.completed_at) === today);
    const isCurrentRecurring = todo => {
        if (todo.recurring === 'daily_repeat') {
            return !todo.date || todo.date === today || (!todo.completed && todo.date < today);
        }
        if (todo.task_type === 'weekly_checkin') return !todo.date || todo.date === week;
        if (todo.task_type === 'monthly_checkin') return !todo.date || todo.date === month;
        return false;
    };
    const completedCount = active.filter(todo => {
        const matchesScope = rule.task_scope === 'today_only'
            ? !isRecurring(todo) && /^\d{4}-\d{2}-\d{2}$/.test(todo.date || '') && todo.date <= today
            : rule.task_scope === 'recurring_only' ? isRecurring(todo) : true;
        return matchesScope && hasCompletion(todo);
    }).length;
    const remaining = active.filter(todo => {
        const isTodayNormal = !isRecurring(todo) && (todo.date === today || isOverdue(todo, today));
        const matchesScope = rule.task_scope === 'today_only' ? isTodayNormal
            : rule.task_scope === 'recurring_only' ? isCurrentRecurring(todo)
                : isTodayNormal || isCurrentRecurring(todo);
        return matchesScope && !todo.completed && !hasCompletion(todo);
    });
    // 昨天已完成的任务既不是今天的成果，也不能重新算作待办。
    const remainingCount = remaining.length;
    const totalCount = completedCount + remainingCount;
    const overdueCount = remaining.filter(todo => isOverdue(todo, today)).length;
    const completionRate = totalCount ? Math.round(completedCount / totalCount * 100) : 0;
    const shouldTrigger = rule.condition === 'none_completed' ? completedCount === 0
        : rule.condition === 'any_remaining' ? remainingCount > 0
            : rule.condition === 'unconditional';
    return { shouldTrigger, completedCount, remainingCount, totalCount, overdueCount, completionRate };
}
