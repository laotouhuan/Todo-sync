import { localDay, learningRange, summarizeLearning, formatDuration, resolveLearningEntries, taskReference } from './timeTracking.js';

export const reviewFields = [
    ['fact', '事实', '今天具体推进了什么？理解、推导、例子、明确卡点都算。'],
    ['obstacle', '卡点', '最影响你的一次拖延或中断发生在哪里？当时发生了什么？'],
    ['effective_action', '有效动作', '什么帮助你开始或回到任务？'],
    ['next_step', '下一步', '明天想保留什么，或只调整什么？']
];

export function reviewPreview(review) {
    const field = reviewFields.find(([key]) => review[key]?.trim());
    return field ? `${field[1]}：${review[field[0]].split('\n').slice(0, 2).join('\n')}` : '';
}

export function exportReviews(data, period, target, includeLearning = true, tasks = (data.todos || []).map(todo => ({ todo, ref: taskReference(todo) }))) {
    const resolved = resolveLearningEntries(data.time_entries || [], tasks);
    const { start, end } = learningRange(period, target);
    const reviews = (data.daily_reviews || []).filter(r => !r.deleted && r.date >= start && r.date < end);
    const dates = new Set(reviews.map(r => r.date));
    const totals = summarizeLearning(resolved, start, end);
    if (includeLearning) totals.parts.forEach(p => dates.add(p.date));
    if (!dates.size) throw new Error('这个时间范围没有可导出的内容');
    const lines = ['# 每日复盘', ''];
    for (const date of [...dates].sort()) {
        lines.push(`## ${date}`, '');
        const review = reviews.find(r => r.date === date);
        if (review) for (const [key, name] of reviewFields) lines.push(`### ${name}`, '', review[key]?.trim() || '未填写', '');
        else lines.push('当日未填写复盘', '');
        if (includeLearning) {
            const range = learningRange('day', date + 'T12:00:00');
            const summary = summarizeLearning(resolved, range.start, range.end);
            lines.push('### 学习投入', '', `合计：${formatDuration(summary.duration)}，${summary.count} 次。`, '', '| 标签 | 时长 | 次数 |', '| --- | --- | --- |');
            for (const group of summary.groups) lines.push(`| ${group.label.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')} | ${formatDuration(group.duration)} | ${group.count} |`);
            lines.push('');
        }
    }
    if (includeLearning) {
        lines.push(`统计时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}。次数按每天有效记录计数，跨日记录每天均计次。`);
        if (totals.pending) lines.push(`有 ${totals.pending} 条待核对记录未计入。`);
        if (totals.running) lines.push(`有 ${totals.running} 条进行中记录未计入。`);
    }
    const last = new Date(end + 'T12:00:00'); last.setDate(last.getDate() - 1);
    const name = period === 'day' ? start : period === 'month' ? start.slice(0, 7) : `${start}_${localDay(last)}`;
    return { filename: `${name}-复盘.md`, content: lines.join('\n') + '\n' };
}
