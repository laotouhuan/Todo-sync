import { labelGroups, planLabelChange } from './labelUtils.js';
import { normalizeLabel } from './timeTracking.js';

const node = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
function action(text, handler) { const b = node('button', text); b.type = 'button'; b.className = 'learning-button'; b.onclick = handler; return b; }
function dialog(title) {
    const d = node('dialog'); d.className = 'learning-dialog'; d.append(node('h3', title));
    document.body.append(d); d.showModal(); d.addEventListener('keydown', e => e.stopPropagation());
    d.addEventListener('close', () => d.remove()); return d;
}

export function createLabelManager({ getTodos, commit }) {
    let host, label = null, query = '', selected = new Set(), previous = '', busy = false;
    function propose(title, whole, clear = false) {
        const plan = planLabelChange(getTodos(), label, whole ? null : [...selected]);
        if (!plan.expected.length) return;
        const d = dialog(title); const field = node('input'); field.placeholder = '输入新标签或选择已有标签';
        field.value = clear ? '' : label || ''; field.setAttribute('aria-label', '目标标签');
        const choices = node('select'); choices.setAttribute('aria-label', '选择已有标签');
        choices.append(new Option('选择已有标签', ''));
        labelGroups(getTodos()).filter(g => g.label !== null).forEach(g => choices.append(new Option(g.label, g.label)));
        choices.onchange = () => { field.value = choices.value; update(); };
        if (!clear) d.append(field, choices);
        const summary = node('p'); d.append(summary, node('p', '相关计时记录将在统计中按新标签归类，计时时长不变。'));
        const error = node('p'); error.className = 'learning-error'; d.append(error);
        function update() {
            const target = normalizeLabel(field.value);
            const merging = whole && target !== null && target !== plan.label && labelGroups(getTodos()).some(g => g.label === target);
            summary.textContent = `个人清单 · ${plan.expected.length} 个任务 → ${target || '未分类'}${merging ? '（将合并到已有标签）' : ''}`;
        }
        field.oninput = update; update();
        const cancel = action('取消', () => d.close());
        const save = action('确认修改', async () => {
            busy = true; save.disabled = cancel.disabled = field.disabled = choices.disabled = true;
            try {
                const count = await commit(plan, clear ? null : field.value);
                if (plan.wholeLabel) label = normalizeLabel(clear ? null : field.value);
                selected.clear(); d.close(); render(); host.prepend(node('p', `已在本地修改 ${count} 个任务；云同步结果请查看同步状态。`));
            } catch (e) { error.textContent = e.message || String(e); }
            finally { busy = false; save.disabled = cancel.disabled = field.disabled = choices.disabled = false; }
        });
        d.addEventListener('cancel', e => { if (busy) e.preventDefault(); }); d.append(save, cancel);
    }
    function render() {
        if (!host) return;
        const todos = getTodos(); previous = JSON.stringify(todos.map(t => [t.id, t.label, t.updated_at]));
        host.replaceChildren(node('h3', '个人清单 · 标签管理'));
        const search = node('input'); search.type = 'search'; search.placeholder = '搜索标签'; search.value = query;
        search.setAttribute('aria-label', '搜索标签'); host.append(search);
        const groups = node('div'); groups.className = 'label-actions'; host.append(groups);
        const drawGroups = () => {
            groups.replaceChildren();
            labelGroups(getTodos()).filter(g => (g.label || '未分类').includes(query.trim())).forEach(g => {
                const b = action(`${g.label === label ? '✓ ' : ''}${g.label || '未分类'} · ${g.count}`, () => { label = g.label; selected.clear(); render(); });
                b.setAttribute('aria-pressed', String(g.label === label)); groups.append(b);
            });
        };
        search.oninput = () => { query = search.value; selected.clear(); drawGroups(); drawTasks(); }; drawGroups();
        const tasks = node('div'); host.append(tasks);
        function drawTasks() {
            tasks.replaceChildren(node('h4', label || '未分类'));
            const members = getTodos().filter(t => !t.deleted && normalizeLabel(t.label) === label);
            const toolbar = node('div'); toolbar.className = 'label-actions';
            const edit = action('批量修改', () => propose('批量修改标签', false));
            const remove = action('移除标签', () => propose('移除所选任务标签', false, true));
            const count = node('span');
            const updateSelection = () => { count.textContent = `已选 ${selected.size} 个`; edit.disabled = remove.disabled = !selected.size; };
            toolbar.append(action('全选', () => { selected = new Set(members.map(t => t.id)); drawTasks(); }),
                action('清除选择', () => { selected.clear(); drawTasks(); }), count, edit, remove);
            if (label !== null) toolbar.append(action('重命名 / 合并', () => propose('重命名 / 合并标签', true)), action('清空标签', () => propose('清空标签（不删除任务）', true, true)));
            tasks.append(toolbar); updateSelection();
            if (!members.length) tasks.append(node('p', '此标签暂无任务'));
            for (const t of members) {
                const row = node('div'); row.className = 'label-task';
                const check = node('input'); check.type = 'checkbox'; check.checked = selected.has(t.id); check.setAttribute('aria-label', `选择 ${t.content}`);
                check.onchange = () => { if (check.checked) selected.add(t.id); else selected.delete(t.id); updateSelection(); };
                const text = action(`${t.completed ? '✓ ' : ''}${t.content}`, () => {
                    const d = dialog('任务详情'); d.append(node('p', t.content), node('p', `${t.date || '无日期'} ${t.time || ''} · ${t.completed ? '已完成' : '未完成'}`));
                    (t.subtasks || []).forEach(s => d.append(node('p', `${s.completed ? '✓' : '○'} ${s.content}`)));
                    d.append(action('关闭', () => d.close()));
                });
                row.append(check, text, node('small', t.date || '无日期')); tasks.append(row);
            }
        }
        drawTasks();
    }
    return { mount(element) { host = element; render(); }, refresh() {
        if (!busy && host && previous !== JSON.stringify(getTodos().map(t => [t.id, t.label, t.updated_at]))) { selected.clear(); render(); }
    } };
}
