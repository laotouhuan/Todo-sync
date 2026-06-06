const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ====== State ======
let todoData = {
    version: 1,
    last_updated: new Date().toISOString(),
    todos: []
};

let currentView = 'list'; // 'list' | 'matrix' | 'stats'
let isPinned = false;
let statsPeriod = 'day'; // 'day' | 'week' | 'month'
let statsStatus = 'all'; // 'all' | 'completed' | 'uncompleted'
let statsTargetDate = new Date();
let todayCollapsed = false;
let weekCollapsed = true;
let monthCollapsed = true;
let currentEditingTodo = null;
let editImportance = 2;
let editUrgency = 2;
let dateFilter = 'today'; // 'today' | 'all'
let currentEditingSubtasks = [];
let currentImportType = null;
let currentImportCandidates = [];

// SVG Icons
const ICON_VIEW_LIST = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M4 6H20V8H4V6ZM4 11H20V13H4V11ZM4 16H20V18H4V16Z" fill="currentColor"/></svg>`;
const ICON_VIEW_MATRIX = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M4 4H10V10H4V4ZM14 4H20V10H14V4ZM4 14H10V20H4V14ZM14 14H20V20H14V14Z" fill="currentColor"/></svg>`;

// DOM Elements (initialized in DOMContentLoaded)
let listEl, formEl, inputEl, statusEl;

// ====== Utility Functions ======
function setSyncStatus(isSyncing) {
    if (statusEl) {
        if (isSyncing) statusEl.classList.add('syncing');
        else statusEl.classList.remove('syncing');
    }
}

function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getISOWeekString(d) {
    const date = new Date(d.getTime());
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
    const week1 = new Date(date.getFullYear(), 0, 4);
    const week = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getThisWeekString() { return getISOWeekString(new Date()); }
function getLastWeekString() { const d = new Date(); d.setDate(d.getDate() - 7); return getISOWeekString(d); }
function getThisMonthString() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function getLastMonthString() { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function getTodayString() { return formatDate(new Date()); }
function getTomorrowString() { const d = new Date(); d.setDate(d.getDate() + 1); return formatDate(d); }

function sortFunc(a, b) {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const scoreA = Number(a.importance || 2) + Number(a.urgency || 2);
    const scoreB = Number(b.importance || 2) + Number(b.urgency || 2);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return new Date(b.created_at) - new Date(a.created_at);
}

function getSeverityClass(importance, urgency) {
    const sum = Number(importance || 2) + Number(urgency || 2);
    return `level-${sum}`;
}

function getNextRecurringDate(baseDateStr, rule) {
    const d = new Date(baseDateStr);
    if (isNaN(d.getTime())) return baseDateStr;
    if (rule === 'daily') d.setDate(d.getDate() + 1);
    else if (rule === 'weekly') d.setDate(d.getDate() + 7);
    else if (rule === 'monthly') d.setMonth(d.getMonth() + 1);
    return formatDate(d);
}

function setActiveRatingBtn(groupId, value) {
    document.querySelectorAll(`#${groupId} .rate-btn`).forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.getAttribute('data-value'), 10) === value);
    });
}

// ====== Data I/O ======
async function loadData() {
    try {
        setSyncStatus(true);
        const jsonStr = await invoke("read_todo_data");
        const parsed = JSON.parse(jsonStr);
        if (parsed && parsed.todos) {
            todoData = parsed;
            render();
        }
        setTimeout(() => setSyncStatus(false), 500);
    } catch (e) {
        console.error("Failed to load data:", e);
        setSyncStatus(false);
    }
}

async function saveData() {
    try {
        setSyncStatus(true);
        todoData.last_updated = new Date().toISOString();
        await invoke("write_todo_data", { data: JSON.stringify(todoData, null, 2) });
        setTimeout(() => setSyncStatus(false), 500);
    } catch (e) {
        console.error("Failed to save data:", e);
        setSyncStatus(false);
    }
}

// ====== Meta HTML for todo items ======
function getMetaHtml(todo, todayStr, tomorrowStr) {
    let html = '';
    if (todo.date) {
        let dateLabel;
        if (todo.date === todayStr) dateLabel = '今天';
        else if (todo.date === tomorrowStr) dateLabel = '明天';
        else if (todo.date.includes('-W')) dateLabel = '周任务';
        else if (todo.date.length === 7) dateLabel = '月任务';
        else dateLabel = todo.date ? todo.date.substring(5) : '';

        const isOverdue = todo.date < todayStr && !todo.completed;
        const dateClass = isOverdue ? 'overdue' : '';
        html += `<span class="meta-item date ${dateClass}">📅 ${dateLabel}</span>`;
    }
    if (todo.time) {
        html += `<span class="meta-item time">🕐 ${todo.time}</span>`;
    }
    if (todo.recurring && todo.recurring !== 'none') {
        const recurringLabels = { daily: '每天', weekly: '每周', monthly: '每月' };
        html += `<span class="meta-item meta-icon" title="循环: ${recurringLabels[todo.recurring]}">🔄</span>`;
    }
    if (todo.subtasks && todo.subtasks.length > 0) {
        const completedCount = todo.subtasks.filter(s => s.completed).length;
        html += `<span class="meta-item subtask-progress">📋 ${completedCount}/${todo.subtasks.length}</span>`;
    }
    return html;
}

// ====== Create Todo Item Element ======
function createTodoItemElement(todo, todayStr, tomorrowStr) {
    const li = document.createElement('li');
    li.className = `todo-item ${todo.completed ? 'completed' : ''}`;
    li.innerHTML = `
        <div class="checkbox">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 13L9 17L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
        <div class="todo-info">
            <span class="todo-content"></span>
            <div class="todo-meta">${getMetaHtml(todo, todayStr, tomorrowStr)}</div>
        </div>
        <div class="severity-dot ${getSeverityClass(todo.importance, todo.urgency)}"></div>
        <button class="edit-btn" aria-label="修改">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <path d="M3 17.25V21H6.75L17.81 9.94L14.06 6.19L3 17.25ZM20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C17.98 2.9 17.35 2.9 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04Z" fill="currentColor"/>
            </svg>
        </button>
    `;
    // 用 textContent 设置待办内容，防止 HTML 注入
    li.querySelector('.todo-content').textContent = todo.content;

    li.addEventListener('click', async (e) => {
        if (e.target.closest('.edit-btn')) return;
        const index = todoData.todos.findIndex(t => t.id === todo.id);
        if (index !== -1) {
            const t = todoData.todos[index];
            if (!t.completed && t.recurring && t.recurring !== 'none') {
                const nextDate = getNextRecurringDate(t.date || getTodayString(), t.recurring);
                const clone = {
                    ...t,
                    id: crypto.randomUUID(),
                    date: nextDate,
                    completed: false,
                    created_at: new Date().toISOString(),
                    subtasks: t.subtasks ? JSON.parse(JSON.stringify(t.subtasks)).map(s => { s.completed = false; return s; }) : []
                };
                todoData.todos.push(clone);
            }
            t.completed = !t.completed;
            render();
            await saveData();
        }
    });

    const editBtn = li.querySelector('.edit-btn');
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(todo);
    });

    return li;
}

// ====== Edit Subtasks ======
function renderEditSubtasks() {
    const listEl = document.getElementById('edit-subtasks-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    currentEditingSubtasks.forEach((sub, idx) => {
        const li = document.createElement('li');
        li.className = `subtask-item ${sub.completed ? 'completed' : ''}`;
        li.innerHTML = `
            <div class="subtask-checkbox"></div>
            <span></span>
            <button type="button" class="icon-btn-small delete-subtask">
                <svg viewBox="0 0 24 24" fill="none" width="14" height="14">
                    <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </button>
        `;
        li.querySelector('span').textContent = sub.content;
        li.querySelector('.subtask-checkbox').addEventListener('click', () => {
            sub.completed = !sub.completed;
            renderEditSubtasks();
        });
        li.querySelector('.delete-subtask').addEventListener('click', () => {
            currentEditingSubtasks.splice(idx, 1);
            renderEditSubtasks();
        });
        listEl.appendChild(li);
    });
}

// ====== Edit Modal ======
function openEditModal(todo) {
    currentEditingTodo = todo;
    editImportance = todo.importance || 2;
    editUrgency = todo.urgency || 2;

    const modal = document.getElementById('edit-modal');
    const input = document.getElementById('edit-content');
    input.value = todo.content;

    document.getElementById('edit-date').value = todo.date || '';
    document.getElementById('edit-time').value = todo.time || '';

    setActiveRatingBtn('edit-importance-options', editImportance);
    setActiveRatingBtn('edit-urgency-options', editUrgency);

    const recurringSelect = document.getElementById('edit-recurring');
    if (recurringSelect) recurringSelect.value = todo.recurring || 'none';

    currentEditingSubtasks = todo.subtasks ? JSON.parse(JSON.stringify(todo.subtasks)) : [];
    renderEditSubtasks();

    modal.classList.add('active');
    setTimeout(() => input.focus(), 80);
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('active');
    currentEditingTodo = null;
}

// ====== Render Stats ======
function renderStats(todayStr, tomorrowStr, thisWeekStr, thisMonthStr) {
    const statsList = document.getElementById('stats-list');
    statsList.innerHTML = '';

    const targetDayStr = formatDate(statsTargetDate);
    const targetWeekStr = getISOWeekString(statsTargetDate);
    const targetMonthStr = `${statsTargetDate.getFullYear()}-${String(statsTargetDate.getMonth() + 1).padStart(2, '0')}`;
    const labelEl = document.getElementById('stats-date-label');

    let periodTodos = [];
    if (statsPeriod === 'day') {
        labelEl.textContent = targetDayStr;
        periodTodos = todoData.todos.filter(t => t.date === targetDayStr);
    } else if (statsPeriod === 'week') {
        const parts = targetWeekStr.split('-W');
        labelEl.textContent = `${parts[0]}年 第${parts[1]}周`;
        periodTodos = todoData.todos.filter(t => {
            if (!t.date) return false;
            if (t.date === targetWeekStr) return true;
            if (t.date.length === 10) {
                const checkDate = new Date(t.date);
                if (isNaN(checkDate.getTime())) return false;
                return getISOWeekString(checkDate) === targetWeekStr;
            }
            return false;
        });
    } else {
        const parts = targetMonthStr.split('-');
        labelEl.textContent = `${parts[0]}年 ${parts[1]}月`;
        periodTodos = todoData.todos.filter(t => {
            if (!t.date) return false;
            if (t.date === targetMonthStr) return true;
            if (t.date.length === 10) return t.date.startsWith(targetMonthStr);
            return false;
        });
    }

    const totalCount = periodTodos.length;
    const completedCount = periodTodos.filter(t => t.completed).length;
    const progress = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
    const overdueCount = periodTodos.filter(t => t.date && t.date < todayStr && !t.completed && !t.date.includes('-W') && t.date.length !== 7).length;

    document.getElementById('stats-summary-text').textContent = `共 ${totalCount} 项，已完成 ${completedCount} 项，其中逾期 ${overdueCount} 项`;
    document.getElementById('stats-progress-fill').style.width = `${progress}%`;

    let displayTodos = periodTodos;
    if (statsStatus === 'completed') displayTodos = periodTodos.filter(t => t.completed);
    else if (statsStatus === 'uncompleted') displayTodos = periodTodos.filter(t => !t.completed);

    displayTodos.sort(sortFunc);

    if (displayTodos.length === 0) {
        const emptyTip = document.createElement('div');
        emptyTip.style.cssText = 'text-align: center; color: var(--text-secondary); padding: 20px; font-size: 0.85rem; font-style: italic;';
        emptyTip.textContent = '没有符合条件的任务';
        statsList.appendChild(emptyTip);
    } else {
        displayTodos.forEach(todo => {
            statsList.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr));
        });
    }
}

// ====== Render Group (for "all" filter) ======
function renderGroup(group, label, headerStyle = {}, todayStr, tomorrowStr) {
    if (group.length === 0) return;
    const header = document.createElement('div');
    header.className = 'date-group-header';
    header.textContent = label;
    Object.assign(header.style, headerStyle);
    listEl.appendChild(header);
    group.forEach(todo => {
        listEl.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr));
    });
}

// ====== Render Collapsible Group (for "today" filter) ======
function renderCollapsibleGroup(group, label, isCollapsed, type, themeColor, todayStr, tomorrowStr) {
    const groupLi = document.createElement('li');
    groupLi.className = `collapsible-group ${!isCollapsed ? 'expanded' : ''}`;

    const header = document.createElement('div');
    header.className = 'collapsible-header';
    header.style.borderLeftColor = themeColor;
    header.innerHTML = `
        <span class="arrow">▶</span>
        <span class="title" style="color: ${themeColor};">${label}</span>
        <span class="badge">${group.length}</span>
    `;

    header.addEventListener('click', () => {
        if (type === 'today') todayCollapsed = !todayCollapsed;
        else if (type === 'weekly') weekCollapsed = !weekCollapsed;
        else monthCollapsed = !monthCollapsed;
        render();
    });

    const content = document.createElement('div');
    content.className = 'collapsible-content';

    if (!isCollapsed) {
        if (group.length > 0) {
            group.forEach(todo => {
                content.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr));
            });
        }
    }

    groupLi.appendChild(header);
    groupLi.appendChild(content);
    listEl.appendChild(groupLi);
}

// ====== Main Render Function ======
function render() {
    const todayStr = getTodayString();
    const tomorrowStr = getTomorrowString();
    const thisWeekStr = getThisWeekString();
    const thisMonthStr = getThisMonthString();

    // 根据 dateFilter 过滤数据
    let filteredTodos = [...todoData.todos];
    if (dateFilter === 'today') {
        filteredTodos = filteredTodos.filter(t => {
            const isOverdue = t.date && t.date < todayStr && !t.completed && !t.date.includes('-W') && t.date.length !== 7;
            return t.date === todayStr || isOverdue || !t.date || t.date === thisWeekStr || t.date === thisMonthStr;
        });
    }

    if (currentView === 'stats') {
        renderStats(todayStr, tomorrowStr, thisWeekStr, thisMonthStr);
        return;
    }

    if (currentView === 'list') {
        listEl.innerHTML = '';

        if (dateFilter === 'today') {
            const monthGroup = filteredTodos.filter(t => t.date === thisMonthStr).sort(sortFunc);
            const weekGroup = filteredTodos.filter(t => t.date === thisWeekStr).sort(sortFunc);
            const todayGroup = filteredTodos.filter(t => t.date !== thisMonthStr && t.date !== thisWeekStr).sort(sortFunc);

            renderCollapsibleGroup(todayGroup, '今日任务', todayCollapsed, 'today', 'var(--accent-color)', todayStr, tomorrowStr);
            renderCollapsibleGroup(weekGroup, '本周任务', weekCollapsed, 'weekly', '#fadb14', todayStr, tomorrowStr);
            renderCollapsibleGroup(monthGroup, '本月任务', monthCollapsed, 'monthly', '#ff7a45', todayStr, tomorrowStr);
        } else {
            const groups = { overdue: [], today: [], tomorrow: [], weekMonth: [], inboxAndFuture: [] };
            filteredTodos.forEach(todo => {
                if (todo.date) {
                    if (todo.date.includes('-W') || todo.date.length === 7) {
                        groups.weekMonth.push(todo);
                    } else if (todo.date < todayStr) {
                        groups.overdue.push(todo);
                    } else if (todo.date === todayStr) {
                        groups.today.push(todo);
                    } else if (todo.date === tomorrowStr) {
                        groups.tomorrow.push(todo);
                    } else {
                        groups.inboxAndFuture.push(todo);
                    }
                } else {
                    groups.inboxAndFuture.push(todo);
                }
            });
            Object.values(groups).forEach(group => group.sort(sortFunc));
            renderGroup(groups.overdue, '逾期', { color: '#ff4d4f', borderLeftColor: '#ff4d4f' }, todayStr, tomorrowStr);
            renderGroup(groups.today, '今天', {}, todayStr, tomorrowStr);
            renderGroup(groups.tomorrow, '明天', {}, todayStr, tomorrowStr);
            renderGroup(groups.weekMonth, '周/月目标', { color: '#fadb14', borderLeftColor: '#fadb14' }, todayStr, tomorrowStr);
            renderGroup(groups.inboxAndFuture, '未来与待安排', {}, todayStr, tomorrowStr);
        }
    } else if (currentView === 'matrix') {
        const quadrants = [
            document.getElementById('quadrant-list-1'),
            document.getElementById('quadrant-list-2'),
            document.getElementById('quadrant-list-3'),
            document.getElementById('quadrant-list-4')
        ];
        quadrants.forEach(q => q.innerHTML = '');

        const sortedTodos = filteredTodos.sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            return new Date(b.created_at) - new Date(a.created_at);
        });

        sortedTodos.forEach(todo => {
            const imp = todo.importance || 2;
            const urg = todo.urgency || 2;
            const el = createTodoItemElement(todo, todayStr, tomorrowStr);
            if (imp >= 2 && urg >= 2) quadrants[0].appendChild(el);
            else if (imp >= 2 && urg < 2) quadrants[1].appendChild(el);
            else if (imp < 2 && urg >= 2) quadrants[2].appendChild(el);
            else quadrants[3].appendChild(el);
        });
    }
}

// ====== Import Modal ======
window.openImportModal = function(type) {
    currentImportType = type;
    const importListEl = document.getElementById('import-tasks-list');
    const titleEl = document.getElementById('import-modal-title');
    importListEl.innerHTML = '';
    const targetDateStr = type === 'weekly' ? getLastWeekString() : getLastMonthString();
    titleEl.textContent = type === 'weekly' ? '从上周导入' : '从上月导入';
    currentImportCandidates = todoData.todos.filter(t => t.date === targetDateStr);
    if (currentImportCandidates.length === 0) {
        importListEl.innerHTML = '<li style="text-align:center;color:var(--text-secondary);padding:10px;">上个周期没有可导入的任务</li>';
    } else {
        currentImportCandidates.forEach((todo, idx) => {
            const li = document.createElement('li');
            li.className = 'subtask-item';
            li.setAttribute('data-selected', 'true');

            const box = document.createElement('div');
            box.className = 'subtask-checkbox';
            box.style.background = 'var(--accent-color)';
            box.style.borderColor = 'var(--accent-color)';
            box.style.position = 'relative';
            const check = document.createElement('div');
            check.style.width = '3px';
            check.style.height = '6px';
            check.style.border = 'solid white';
            check.style.borderWidth = '0 2px 2px 0';
            check.style.transform = 'rotate(45deg)';
            check.style.marginBottom = '2px';
            box.appendChild(check);

            const span = document.createElement('span');
            span.style.flex = '1';
            span.textContent = todo.content; // textContent 防止 XSS

            li.appendChild(box);
            li.appendChild(span);

            li.addEventListener('click', () => {
                const isSelected = li.getAttribute('data-selected') === 'true';
                if (isSelected) {
                    li.setAttribute('data-selected', 'false');
                    box.style.background = 'transparent';
                    box.style.borderColor = 'var(--text-secondary)';
                    check.style.display = 'none';
                } else {
                    li.setAttribute('data-selected', 'true');
                    box.style.background = 'var(--accent-color)';
                    box.style.borderColor = 'var(--accent-color)';
                    check.style.display = 'block';
                }
            });
            importListEl.appendChild(li);
        });
    }
    document.getElementById('import-modal').classList.add('active');
};

function closeImportModal() {
    document.getElementById('import-modal').classList.remove('active');
}

// ====== DOMContentLoaded: Init Event Listeners ======
window.addEventListener("DOMContentLoaded", () => {
    // 初始化 DOM 元素
    listEl = document.getElementById('todo-list');
    formEl = document.getElementById('add-form');
    inputEl = document.getElementById('todo-input');
    statusEl = document.getElementById('sync-status');

    // 置顶按钮
    const pinBtn = document.getElementById('pin-btn');
    if (pinBtn) {
        pinBtn.addEventListener('click', async () => {
            isPinned = !isPinned;
            try {
                await invoke('set_always_on_top', { alwaysOnTop: isPinned });
                pinBtn.classList.toggle('active', isPinned);
                pinBtn.title = isPinned ? "取消置顶" : "固定置顶";
            } catch (e) {
                console.error("Failed to set always on top:", e);
                isPinned = !isPinned;
            }
        });
    }

    // 设置按钮（选择同步目录）
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', async () => {
            try {
                await invoke('set_always_on_top', { alwaysOnTop: true });
                const selectedPath = await invoke("pick_sync_folder");
                await invoke('set_always_on_top', { alwaysOnTop: false });

                if (selectedPath) {
                    await invoke("set_sync_path", { newPath: selectedPath });
                    const jsonStr = await invoke("read_todo_data");
                    const parsed = JSON.parse(jsonStr);
                    if (parsed && parsed.todos) {
                        todoData = parsed;
                        render();
                    } else {
                        await saveData();
                    }
                    alert("同步目录已更新为:\n" + selectedPath + "\n\n程序将自动从此目录加载/同步数据。");
                }
            } catch (e) {
                alert("打开文件夹选择器失败: " + JSON.stringify(e));
                console.error("Failed to open dialog or set path:", e);
                await invoke('set_always_on_top', { alwaysOnTop: false });
            }
        });
    }

    // 备份恢复按钮
    const backupBtn = document.getElementById('backup-btn');
    const backupModal = document.getElementById('backup-modal');
    const backupCloseBtn = document.getElementById('backup-close-btn');
    const backupList = document.getElementById('backup-list');

    if (backupBtn) {
        backupBtn.addEventListener('click', async () => {
            backupList.innerHTML = '<li>加载中...</li>';
            backupModal.classList.add('active');
            try {
                const backups = await invoke('list_backups');
                backupList.innerHTML = '';
                if (backups.length === 0) {
                    backupList.innerHTML = '<li style="text-align:center;color:var(--text-secondary);padding:10px;">暂无本地备份记录。</li>';
                } else {
                    backups.forEach(b => {
                        const li = document.createElement('li');
                        li.className = 'subtask-item';
                        li.style.cursor = 'pointer';
                        li.style.padding = '8px';
                        li.style.borderBottom = '1px solid var(--border-color)';
                        li.textContent = b;
                        li.addEventListener('click', async () => {
                            if (confirm(`确定要恢复备份 ${b} 吗？当前数据会被覆盖（覆盖前会自动保存一个新快照）。`)) {
                                try {
                                    await invoke('restore_backup', { filename: b });
                                    alert('恢复成功！');
                                    backupModal.classList.remove('active');
                                    loadData();
                                } catch (e) {
                                    alert('恢复失败: ' + e);
                                }
                            }
                        });
                        backupList.appendChild(li);
                    });
                }
            } catch (e) {
                backupList.innerHTML = `<li>获取备份失败: ${e}</li>`;
            }
        });
    }

    if (backupCloseBtn) {
        backupCloseBtn.addEventListener('click', () => {
            backupModal.classList.remove('active');
        });
    }

    // 视图切换按钮
    const viewToggleBtn = document.getElementById('view-toggle-btn');
    const mainContentEl = document.getElementById('main-content');
    const tabsContainerEl = document.querySelector('.tabs-container');
    const appFooterEl = document.getElementById('app-footer');
    const statsContainerEl = document.getElementById('stats-container');
    const statsBtn = document.getElementById('stats-btn');

    const toggleStatsView = (enterStats) => {
        if (enterStats) {
            currentView = 'stats';
            statsTargetDate = new Date();
            mainContentEl.classList.add('hidden');
            if (tabsContainerEl) tabsContainerEl.classList.add('hidden');
            if (appFooterEl) appFooterEl.classList.add('hidden');
            statsContainerEl.classList.remove('hidden');
            statsBtn.classList.add('active');
            viewToggleBtn.classList.remove('active');
        } else {
            currentView = 'list';
            mainContentEl.classList.remove('hidden');
            mainContentEl.className = 'list-view';
            if (tabsContainerEl) tabsContainerEl.classList.remove('hidden');
            if (appFooterEl) appFooterEl.classList.remove('hidden');
            statsContainerEl.classList.add('hidden');
            statsBtn.classList.remove('active');
            viewToggleBtn.title = '切换四象限视图';
            viewToggleBtn.innerHTML = ICON_VIEW_MATRIX;
        }
        render();
    };

    if (statsBtn) {
        statsBtn.addEventListener('click', () => {
            toggleStatsView(currentView !== 'stats');
        });
    }

    viewToggleBtn.addEventListener('click', () => {
        if (currentView === 'stats') {
            toggleStatsView(false);
            return;
        }
        if (currentView === 'list') {
            currentView = 'matrix';
            mainContentEl.classList.remove('list-view');
            mainContentEl.classList.add('matrix-view');
            viewToggleBtn.title = '切换列表视图';
            viewToggleBtn.innerHTML = ICON_VIEW_LIST;
        } else {
            currentView = 'list';
            mainContentEl.classList.remove('matrix-view');
            mainContentEl.classList.add('list-view');
            viewToggleBtn.title = '切换四象限视图';
            viewToggleBtn.innerHTML = ICON_VIEW_MATRIX;
        }
        render();
    });

    // 统计周期切换
    const periodDayBtn = document.getElementById('stats-period-day');
    if (periodDayBtn) {
        periodDayBtn.addEventListener('click', () => {
            statsPeriod = 'day';
            periodDayBtn.classList.add('active');
            document.getElementById('stats-period-week').classList.remove('active');
            document.getElementById('stats-period-month').classList.remove('active');
            render();
        });
    }

    document.getElementById('stats-period-week').addEventListener('click', () => {
        statsPeriod = 'week';
        document.getElementById('stats-period-week').classList.add('active');
        if (periodDayBtn) periodDayBtn.classList.remove('active');
        document.getElementById('stats-period-month').classList.remove('active');
        render();
    });

    document.getElementById('stats-period-month').addEventListener('click', () => {
        statsPeriod = 'month';
        document.getElementById('stats-period-month').classList.add('active');
        document.getElementById('stats-period-week').classList.remove('active');
        if (periodDayBtn) periodDayBtn.classList.remove('active');
        render();
    });

    document.getElementById('stats-prev-btn').addEventListener('click', () => {
        if (statsPeriod === 'day') statsTargetDate.setDate(statsTargetDate.getDate() - 1);
        else if (statsPeriod === 'week') statsTargetDate.setDate(statsTargetDate.getDate() - 7);
        else statsTargetDate.setMonth(statsTargetDate.getMonth() - 1);
        render();
    });

    document.getElementById('stats-next-btn').addEventListener('click', () => {
        if (statsPeriod === 'day') statsTargetDate.setDate(statsTargetDate.getDate() + 1);
        else if (statsPeriod === 'week') statsTargetDate.setDate(statsTargetDate.getDate() + 7);
        else statsTargetDate.setMonth(statsTargetDate.getMonth() + 1);
        render();
    });

    document.querySelectorAll('.stats-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.stats-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            statsStatus = btn.getAttribute('data-filter');
            render();
        });
    });

    // 今天/全部过滤标签
    const tabToday = document.getElementById('tab-today');
    const tabAll = document.getElementById('tab-all');

    tabToday.addEventListener('click', () => {
        dateFilter = 'today';
        tabToday.classList.add('active');
        tabAll.classList.remove('active');
        render();
    });

    tabAll.addEventListener('click', () => {
        dateFilter = 'all';
        tabAll.classList.add('active');
        tabToday.classList.remove('active');
        render();
    });

    // 编辑模态框内部评分按钮
    document.querySelectorAll('#edit-importance-options .rate-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            editImportance = parseInt(btn.getAttribute('data-value'), 10);
            setActiveRatingBtn('edit-importance-options', editImportance);
        });
    });

    document.querySelectorAll('#edit-urgency-options .rate-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            editUrgency = parseInt(btn.getAttribute('data-value'), 10);
            setActiveRatingBtn('edit-urgency-options', editUrgency);
        });
    });

    // 添加子步骤
    document.getElementById('add-subtask-btn').addEventListener('click', () => {
        const input = document.getElementById('add-subtask-input');
        if (!input) return;
        const content = input.value.trim();
        if (content && currentEditingTodo) {
            currentEditingSubtasks.push({ id: crypto.randomUUID(), content, completed: false });
            input.value = '';
            renderEditSubtasks();
        }
    });

    const addSubtaskInput = document.getElementById('add-subtask-input');
    if (addSubtaskInput) {
        addSubtaskInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('add-subtask-btn').click();
            }
        });
    }

    // 导入模态框
    document.getElementById('import-cancel-btn').addEventListener('click', closeImportModal);

    document.getElementById('import-confirm-btn').addEventListener('click', async () => {
        const listItems = document.querySelectorAll('#import-tasks-list .subtask-item');
        const targetDateStr = currentImportType === 'weekly' ? getThisWeekString() : getThisMonthString();
        let imported = false;
        listItems.forEach((li, idx) => {
            if (li.getAttribute('data-selected') === 'true') {
                const originalTodo = currentImportCandidates[idx];
                const newTodo = {
                    ...originalTodo,
                    id: crypto.randomUUID(),
                    date: targetDateStr,
                    completed: false,
                    created_at: new Date().toISOString(),
                    subtasks: originalTodo.subtasks ? JSON.parse(JSON.stringify(originalTodo.subtasks)).map(s => { s.completed = false; return s; }) : []
                };
                todoData.todos.push(newTodo);
                imported = true;
            }
        });
        if (imported) {
            render();
            await saveData();
        }
        closeImportModal();
    });

    // 编辑模态框按钮
    document.getElementById('modal-cancel-btn').addEventListener('click', closeEditModal);

    document.getElementById('edit-modal').addEventListener('click', (e) => {
        if (e.target.id === 'edit-modal') closeEditModal();
    });

    document.getElementById('modal-delete-btn').addEventListener('click', async () => {
        if (!currentEditingTodo) return;
        const index = todoData.todos.findIndex(t => t.id === currentEditingTodo.id);
        if (index !== -1) {
            todoData.todos.splice(index, 1);
            render();
            await saveData();
        }
        closeEditModal();
    });

    document.getElementById('modal-save-btn').addEventListener('click', async () => {
        if (!currentEditingTodo) return;
        const newContent = document.getElementById('edit-content').value.trim();
        if (!newContent) return;

        const index = todoData.todos.findIndex(t => t.id === currentEditingTodo.id);
        if (index !== -1) {
            todoData.todos[index].content = newContent;
            todoData.todos[index].importance = editImportance;
            todoData.todos[index].urgency = editUrgency;
            todoData.todos[index].date = document.getElementById('edit-date').value || null;
            todoData.todos[index].time = document.getElementById('edit-time').value || null;
            const recurringSelect = document.getElementById('edit-recurring');
            todoData.todos[index].recurring = recurringSelect ? recurringSelect.value : 'none';
            todoData.todos[index].subtasks = JSON.parse(JSON.stringify(currentEditingSubtasks));
            render();
            await saveData();
        }
        closeEditModal();
    });

    // 添加新待办表单
    formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        const content = inputEl.value.trim();
        if (!content) return;

        let importance = 2;
        let urgency = 2;
        let taskDate = getTodayString();
        let finalContent = content;

        const syntaxRegex = /(?:\s+|^)!([1-3])([1-3])?$/;
        const dateRegex = /(?:\s+|^)@(today|tomorrow|week|month|\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/i;

        // 尝试匹配评分
        let match = finalContent.match(syntaxRegex);
        if (match) {
            importance = parseInt(match[1], 10);
            if (match[2]) urgency = parseInt(match[2], 10);
            finalContent = finalContent.replace(syntaxRegex, '').trim();
        }

        // 尝试匹配日期
        let dateMatch = finalContent.match(dateRegex);
        if (dateMatch) {
            const dateVal = dateMatch[1].toLowerCase();
            if (dateVal === 'today') taskDate = getTodayString();
            else if (dateVal === 'tomorrow') taskDate = getTomorrowString();
            else if (dateVal === 'week') taskDate = getThisWeekString();
            else if (dateVal === 'month') taskDate = getThisMonthString();
            else if (/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) taskDate = dateVal;
            else if (/^\d{2}-\d{2}$/.test(dateVal)) taskDate = `${new Date().getFullYear()}-${dateVal}`;
            finalContent = finalContent.replace(dateRegex, '').trim();
        }

        // 再次尝试匹配评分（防止顺序是 @date !score）
        match = finalContent.match(syntaxRegex);
        if (match) {
            importance = parseInt(match[1], 10);
            if (match[2]) urgency = parseInt(match[2], 10);
            finalContent = finalContent.replace(syntaxRegex, '').trim();
        }

        if (!finalContent) return;

        const newTodo = {
            id: crypto.randomUUID(),
            content: finalContent,
            date: taskDate,
            time: null,
            importance: importance,
            urgency: urgency,
            completed: false,
            created_at: new Date().toISOString(),
            recurring: 'none',
            subtasks: []
        };

        todoData.todos.push(newTodo);
        inputEl.value = '';
        render();
        await saveData();
    });

    // 监听后端文件变动，自动同步数据
    listen("todo_data_changed", () => {
        loadData();
    });

    // 初始加载
    loadData();

    // 全局拖动支持
    document.addEventListener('mousedown', (e) => {
        const isInteractive = e.target.closest('button, input, select, .checkbox, .edit-btn, .tab-btn, .todo-item, .collapsible-header, .reminder-bar, .reminder-btn');
        const modalActive = document.getElementById('edit-modal').classList.contains('active');
        const isScrollbar = e.offsetX > e.target.clientWidth || e.offsetY > e.target.clientHeight;

        if (!isInteractive && !modalActive && !isScrollbar) {
            invoke('start_drag').catch(err => console.error('Failed to drag:', err));
        }
    });
});