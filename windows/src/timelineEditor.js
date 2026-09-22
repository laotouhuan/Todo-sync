function element(tag, text) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return node;
}

export function editTimelineSubtask(todo, subtask, save) {
    const dialog = element('dialog'); dialog.className = 'learning-dialog';
    dialog.append(element('h3', '子步骤详情'), element('p', '所属任务：' + todo.content));
    const field = (caption, type, value) => {
        const label = element('label', caption), input = element('input');
        input.type = type; input.value = value; label.append(input); dialog.append(label); return input;
    };
    const content = field('子步骤内容', 'text', subtask.content);
    const originalTime = subtask.completed_at;
    const date = originalTime ? new Date(originalTime) : null;
    const pad = n => String(n).padStart(2, '0');
    const local = date && !isNaN(date) ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : '';
    const completed = field('完成时间（无具体时间可留空）', 'datetime-local', local); completed.step = '1';
    const error = element('p'); error.className = 'learning-error'; dialog.append(error);
    const confirm = element('button', '保存'), close = element('button', '取消');
    confirm.className = close.className = 'learning-button';
    confirm.onclick = async () => {
        confirm.disabled = close.disabled = true;
        try {
            if (!content.value.trim()) throw new Error('子步骤内容不能为空');
            if (completed.validity.badInput || (completed.value && isNaN(Date.parse(completed.value)))) throw new Error('请输入有效的完成时间');
            await save({ content: content.value.trim(), completed_at: completed.value === local ? originalTime : completed.value ? new Date(completed.value).toISOString() : null });
            dialog.close();
        } catch (e) { error.textContent = e.message || String(e); }
        finally { confirm.disabled = close.disabled = false; }
    };
    close.onclick = () => dialog.close(); dialog.append(confirm, close);
    dialog.addEventListener('keydown', e => e.stopPropagation());
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}

export function selectTimelineRecord(entries, open) {
    const unique = [...new Map(entries.map(e => [e.id, e])).values()];
    if (unique.length === 1) { open(unique[0]); return; }
    if (!unique.length) return;
    const dialog = element('dialog'); dialog.className = 'learning-dialog timeline-detail';
    dialog.append(element('h3', '选择计时记录'));
    unique.forEach(entry => {
        const button = element('button', `${entry.task_content_snapshot} · ${new Date(entry.started_at).toLocaleString()} — ${entry.ended_at ? new Date(entry.ended_at).toLocaleString() : '进行中'}`);
        button.className = 'learning-button'; button.onclick = () => { dialog.close(); open(entry); }; dialog.append(button);
    });
    const close = element('button', '关闭'); close.onclick = () => dialog.close(); dialog.append(close);
    dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
