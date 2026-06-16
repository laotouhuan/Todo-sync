const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

import {
    formatDate, getISOWeekString,
    getTodayString, getTomorrowString, getThisWeekString, getLastWeekString,
    getThisMonthString, getLastMonthString,
    isWeekDate, isMonthDate, isOverdue, getDateLabel, getCompletionStatusLabel,
    sortFunc, getNextRecurringDate, parseInputSyntax, createTodo, groupTodosByDate
} from './dateUtils.js';

// ====== State ======
let todoData = {
    version: 1,
    last_updated: new Date().toISOString(),
    todos: []
};

let saveVersion = 0; // 递增版本号，防止自身写入触发的文件变更重载
let currentView = 'list'; // 'list' | 'stats'
let appConfig = {};
let isPinned = false;
let statsPeriod = 'day'; // 'day' | 'week' | 'month'
let statsStatus = 'all'; // 'all' | 'completed' | 'uncompleted'
let statsTargetDate = new Date();
let todayCollapsed = false;
let weekCollapsed = true;
let monthCollapsed = true;
let currentEditingTodo = null;
let dateFilter = 'today'; // 'today' | 'all'
let currentEditingSubtasks = [];
let currentImportType = null;
let currentImportCandidates = [];
let expandedTaskIds = new Set();

// SVG Icons
const ICON_VIEW_LIST = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M4 6H20V8H4V6ZM4 11H20V13H4V11ZM4 16H20V18H4V16Z" fill="currentColor"/></svg>`;

// DOM Elements (initialized in DOMContentLoaded)
let listEl, formEl, inputEl, statusEl;

// ====== Utility Functions ======
/** 将用户数据转义为安全 HTML，防止 XSS */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

const SyncState = { IDLE: 'idle', SYNCING: 'syncing', ERROR: 'error' };

function setSyncStatus(state) {
    if (statusEl) {
        statusEl.classList.remove('syncing', 'error');
        if (state === SyncState.SYNCING) statusEl.classList.add('syncing');
        else if (state === SyncState.ERROR) statusEl.classList.add('error');
    }
}

function mergeTodoData(localData, cloudData) {
    if (!localData || !localData.todos) return { data: cloudData, changed: true };
    if (!cloudData || !cloudData.todos) return { data: localData, changed: false };
    const localMap = new Map(localData.todos.map(t => [t.id, t]));
    const cloudMap = new Map(cloudData.todos.map(t => [t.id, t]));
    const mergedTodos = [];
    let changed = false;
    for (const [id, lTodo] of localMap) {
        const cTodo = cloudMap.get(id);
        if (cTodo) {
            const lTime = new Date(lTodo.updated_at || lTodo.created_at || 0).getTime();
            const cTime = new Date(cTodo.updated_at || cTodo.created_at || 0).getTime();
            if (cTime > lTime) { mergedTodos.push(cTodo); changed = true; }
            else { mergedTodos.push(lTodo); }
        } else {
            mergedTodos.push(lTodo);
        }
    }
    for (const [id, cTodo] of cloudMap) {
        if (!localMap.has(id)) { mergedTodos.push(cTodo); changed = true; }
    }
    mergedTodos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
        data: {
            version: localData.version || 1,
            last_updated: new Date().toISOString(),
            todos: mergedTodos
        },
        changed: changed || mergedTodos.length !== (localData.todos ? localData.todos.length : 0)
    };
}

// ====== Data I/O ======
async function loadData() {
    try {
        setSyncStatus(SyncState.SYNCING);
        appConfig = await invoke("get_app_config");

        let localJsonStr = await invoke("read_todo_data").catch(() => "{}");
        let localData = null;
        try { localData = JSON.parse(localJsonStr); } catch (e) {}

        if (appConfig.sync_mode === 'webdav') {
            try {
                let cloudJsonStr = await invoke("fetch_from_cloud");
                let cloudData = JSON.parse(cloudJsonStr);

                let { data: mergedData, changed } = mergeTodoData(localData, cloudData);
                todoData = mergedData;
                render();

                if (changed || JSON.stringify(mergedData.todos) !== JSON.stringify(localData.todos)) {
                    await saveData();
                }
            } catch (e) {
                console.error("WebDAV pull failed, using local cache:", e);
                if (localData && localData.todos) {
                    todoData = localData;
                    render();
                }
                setSyncStatus(SyncState.ERROR);
            }
        } else {
            if (localData && localData.todos) {
                todoData = localData;
                render();
            }
        }

        if (statusEl && !statusEl.classList.contains('error')) {
            setTimeout(() => setSyncStatus(SyncState.IDLE), 500);
        }
    } catch (e) {
        console.error("Failed to load data:", e);
        setSyncStatus(SyncState.ERROR);
    }
}

let _savingPromise = null;

async function saveData() {
    // Promise 锁：防止多个 saveData 并发执行
    if (_savingPromise) await _savingPromise;
    _savingPromise = _doSaveData();
    try { await _savingPromise; } finally { _savingPromise = null; }
}

async function _doSaveData() {
    try {
        setSyncStatus(SyncState.SYNCING);
        todoData.last_updated = new Date().toISOString();
        const jsonStr = JSON.stringify(todoData, null, 2);
        saveVersion++;
        await invoke("write_todo_data", { data: jsonStr });

        if (appConfig.sync_mode === 'webdav') {
            try {
                await invoke("sync_to_cloud", { data: jsonStr });
            } catch (e) {
                console.error("WebDAV push failed:", e);
                alert("推送至云端失败: " + e);
                setSyncStatus(SyncState.ERROR);
                return;
            }
        }

        setTimeout(() => setSyncStatus(SyncState.IDLE), 500);
    } catch (e) {
        console.error("Failed to save data:", e);
        setSyncStatus(SyncState.ERROR);
    }
}

// ====== Meta HTML for todo items ======
function getMetaHtml(todo, todayStr, tomorrowStr) {
    let html = '';
    if (todo.date) {
        const dateLabel = getDateLabel(todo.date, todayStr, tomorrowStr);
        const overdue = isOverdue(todo, todayStr);
        const dateClass = (overdue && dateFilter === 'today') ? 'overdue' : '';
        const statusLabel = getCompletionStatusLabel(todo);

        if (dateFilter !== 'all' && statusLabel) {
            const colorStyle = statusLabel === '提前完成' ? ' style="color: #52c41a"' : '';
            const extraClass = statusLabel === '逾期完成' ? ' overdue' : '';
            html += `<span class="meta-item date${extraClass}"${colorStyle}>📅 ${dateLabel} (${statusLabel})</span>`;
        } else {
            html += `<span class="meta-item date ${dateClass}">📅 ${dateLabel}</span>`;
        }
    }
    if (todo.time) {
        html += `<span class="meta-item time">🕐 ${escapeHtml(todo.time)}</span>`;
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
    li.dataset.id = todo.id;
    li.innerHTML = `
        <div class="checkbox">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 13L9 17L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
        <div class="todo-info">
            <span class="todo-content"></span>
            <div class="todo-meta">${getMetaHtml(todo, todayStr, tomorrowStr)}</div>
            <ul class="inline-subtasks-list" style="display: ${expandedTaskIds.has(todo.id) ? 'block' : 'none'}; padding-left: 0; list-style: none; margin-top: 8px; width: 100%;"></ul>
        </div>
        <button class="edit-btn" aria-label="修改">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <path d="M3 17.25V21H6.75L17.81 9.94L14.06 6.19L3 17.25ZM20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C17.98 2.9 17.35 2.9 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04Z" fill="currentColor"/>
            </svg>
        </button>
    `;
    // 用 textContent 设置待办内容，防止 HTML 注入
    li.querySelector('.todo-content').textContent = todo.content;

    const subtasksList = li.querySelector('.inline-subtasks-list');
    if (todo.subtasks && todo.subtasks.length > 0) {
        todo.subtasks.forEach((sub, idx) => {
            const subLi = document.createElement('li');
            subLi.className = `subtask-item ${sub.completed ? 'completed' : ''}`;
            subLi.style.cssText = "display: flex; align-items: center; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 4px; padding: 4px 0;";
            subLi.innerHTML = `
                <div class="subtask-checkbox" style="width: 14px; height: 14px; margin-right: 8px;"></div>
                <span></span>
            `;
            subLi.querySelector('span').textContent = sub.content;
            subLi.querySelector('.subtask-checkbox').addEventListener('click', async (e) => {
                e.stopPropagation();
                sub.completed = !sub.completed;
                todo.updated_at = new Date().toISOString();
                
                const allCompleted = todo.subtasks.length > 0 && todo.subtasks.every(s => s.completed);
                if (allCompleted && !todo.completed) {
                    todo.completed = true;
                    todo.completed_at = new Date().toISOString();
                }

                render();
                saveData(); // 不再 await，避免与防抖的 autoSave 产生双重保存
            });
            subtasksList.appendChild(subLi);
        });
    }

    li.querySelector('.checkbox').addEventListener('click', async (e) => {
        e.stopPropagation();
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
                    completed_at: null,
                    subtasks: t.subtasks ? JSON.parse(JSON.stringify(t.subtasks)).map(s => { s.completed = false; return s; }) : []
                };
                todoData.todos.push(clone);
            }
            t.completed = !t.completed;
            if (t.completed) {
                t.completed_at = new Date().toISOString();
                if (t.subtasks && t.subtasks.length > 0) {
                    t.subtasks.forEach(s => s.completed = true);
                }
            } else {
                t.completed_at = null;
                // 不联动取消子代办
            }
            t.updated_at = new Date().toISOString();
            render();
            await saveData();
        }
    });

    li.querySelector('.todo-info').addEventListener('click', (e) => {
        if (e.target.closest('.subtask-item')) return; // let subtask clicks bubble or be handled
        if (todo.subtasks && todo.subtasks.length > 0) {
            if (subtasksList.style.display === 'none') {
                subtasksList.style.display = 'block';
                expandedTaskIds.add(todo.id);
            } else {
                subtasksList.style.display = 'none';
                expandedTaskIds.delete(todo.id);
            }
        }
    });

    const editBtn = li.querySelector('.edit-btn');
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(todo);
    });

    if (dateFilter === 'today') {
        li.dataset.id = todo.id;
    }

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
            <div class="subtask-checkbox" style="width: 16px; height: 16px; margin-right: 12px; flex-shrink: 0; cursor: pointer; border: 1.5px solid ${sub.completed ? 'var(--accent-color)' : 'var(--text-secondary)'}; background: ${sub.completed ? 'var(--accent-color)' : 'transparent'}; border-radius: 4px; display: flex; justify-content: center; align-items: center; transition: all 0.2s;">
                <svg viewBox="0 0 24 24" fill="none" width="12" height="12" style="opacity: ${sub.completed ? '1' : '0'}; transition: opacity 0.2s;">
                    <path d="M5 13L9 17L19 7" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <div class="subtask-text-container" style="flex: 1; display: flex; align-items: center; overflow: hidden; min-height: 20px;">
                <span class="subtask-content-span" style="color: ${sub.completed ? 'var(--text-secondary)' : 'var(--text-primary)'}; text-decoration: ${sub.completed ? 'line-through' : 'none'}; font-size: 0.95rem; white-space: pre-wrap; word-break: break-word; transition: color 0.2s;"></span>
                <textarea class="subtask-inline-edit" rows="1" style="flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-family: inherit; font-size: 0.95rem; margin: 0; padding: 0; resize: none; overflow: hidden; word-break: break-word; display: none;"></textarea>
            </div>
            <div class="subtask-actions" style="display: flex; flex-direction: column; gap: 4px; opacity: 0; transition: all 0.2s; margin-left: 8px;">
                <button type="button" class="icon-btn-small edit-subtask">
                    <svg viewBox="0 0 24 24" fill="none" width="14" height="14">
                        <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <button type="button" class="icon-btn-small delete-subtask">
                    <svg viewBox="0 0 24 24" fill="none" width="14" height="14">
                        <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                </button>
            </div>
        `;

        const checkbox = li.querySelector('.subtask-checkbox');
        const svg = checkbox.querySelector('svg');
        const span = li.querySelector('.subtask-content-span');
        span.textContent = sub.content; // 使用 textContent 防止 XSS
        const textarea = li.querySelector('.subtask-inline-edit');
        const editBtn = li.querySelector('.edit-subtask');
        const deleteBtn = li.querySelector('.delete-subtask');
        const actions = li.querySelector('.subtask-actions');

        checkbox.addEventListener('click', () => {
            sub.completed = !sub.completed;
            if (sub.completed) {
                li.classList.add('completed');
                checkbox.style.background = 'var(--accent-color)';
                checkbox.style.borderColor = 'var(--accent-color)';
                svg.style.opacity = '1';
                span.style.color = 'var(--text-secondary)';
                span.style.textDecoration = 'line-through';
            } else {
                li.classList.remove('completed');
                checkbox.style.background = 'transparent';
                checkbox.style.borderColor = 'var(--text-secondary)';
                svg.style.opacity = '0';
                span.style.color = 'var(--text-primary)';
                span.style.textDecoration = 'none';
            }
            autoSaveEdit();
        });

        const resizeTextarea = () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        };

        editBtn.addEventListener('click', () => {
            span.style.display = 'none';
            textarea.style.display = 'block';
            textarea.value = sub.content;
            resizeTextarea();
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        });

        textarea.addEventListener('input', resizeTextarea);

        const saveSubtaskEdit = () => {
            if (textarea.style.display === 'block') {
                const newText = textarea.value.trim();
                if (newText) {
                    sub.content = newText;
                    span.textContent = newText;
                }
                textarea.style.display = 'none';
                span.style.display = 'block';
                autoSaveEdit();
            }
        };

        textarea.addEventListener('blur', saveSubtaskEdit);
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                textarea.blur();
            }
        });

        deleteBtn.addEventListener('click', () => {
            currentEditingSubtasks.splice(idx, 1);
            renderEditSubtasks();
            autoSaveEdit();
        });

        listEl.appendChild(li);
    });
}

let _autoSaveTimer = null;

async function _doAutoSave() {
    if (!currentEditingTodo) return;
    const newContent = document.getElementById('edit-content').value.trim();
    // 空内容时不更新 content 字段，但仍允许保存其他字段（date、time、subtasks 等）
    const hasContent = !!newContent;

    const index = todoData.todos.findIndex(t => t.id === currentEditingTodo.id);
    if (index !== -1) {
        if (hasContent) todoData.todos[index].content = newContent;
        todoData.todos[index].date = document.getElementById('edit-date').value || null;
        todoData.todos[index].time = document.getElementById('edit-time').value || null;
        const recurringSelect = document.getElementById('edit-recurring');
        todoData.todos[index].recurring = recurringSelect ? recurringSelect.value : 'none';
        todoData.todos[index].subtasks = JSON.parse(JSON.stringify(currentEditingSubtasks));
        todoData.todos[index].updated_at = new Date().toISOString();

        const allCompleted = todoData.todos[index].subtasks.length > 0 && todoData.todos[index].subtasks.every(s => s.completed);
        if (allCompleted && !todoData.todos[index].completed) {
            todoData.todos[index].completed = true;
            todoData.todos[index].completed_at = new Date().toISOString();
        }

        render();
        await saveData();
    }
}

/** Debounced auto-save (300ms). Coalesces rapid edits into a single save. */
function autoSaveEdit() {
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => { _doAutoSave(); _autoSaveTimer = null; }, 300);
}

/** Immediate auto-save — used by closeEditModal to ensure data is persisted before the modal closes. */
async function autoSaveEditImmediate() {
    if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
    await _doAutoSave();
}

function openEditModal(todo) {
    currentEditingTodo = todo;

    const modal = document.getElementById('edit-modal');
    const input = document.getElementById('edit-content');
    input.value = todo.content;

    document.getElementById('edit-date').value = todo.date || '';
    document.getElementById('edit-time').value = todo.time || '';

    const recurringSelect = document.getElementById('edit-recurring');
    if (recurringSelect) recurringSelect.value = todo.recurring || 'none';

    currentEditingSubtasks = todo.subtasks ? JSON.parse(JSON.stringify(todo.subtasks)) : [];
    renderEditSubtasks();

    modal.classList.add('active');
    setTimeout(() => input.focus(), 80);
}

function closeEditModal() {
    autoSaveEditImmediate().finally(() => {
        document.getElementById('edit-modal').classList.remove('active');
        currentEditingTodo = null;
    });
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
    const overdueCount = periodTodos.filter(t => isOverdue(t, todayStr)).length;

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
    const container = document.createElement('ul');
    container.className = 'group-sortable-container';
    container.style.cssText = 'list-style:none;padding:0;margin:0;';
    group.forEach(todo => {
        container.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr));
    });
    listEl.appendChild(container);
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
        if (type === 'today') {
            const hasDate = group.filter(t => t.date);
            const noDate = group.filter(t => !t.date);
            hasDate.forEach(todo => content.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr)));
            const separator = document.createElement('div');
            separator.className = 'list-separator';
            separator.style.cssText = 'height: 2px; background: var(--border-color); margin: 8px 12px; border-radius: 2px;';
            if (hasDate.length === 0 || noDate.length === 0) {
                separator.style.opacity = '0.5';
            }
            content.appendChild(separator);
            noDate.forEach(todo => content.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr)));
        } else {
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
    let filteredTodos = [...todoData.todos].filter(t => !t.deleted);
    if (dateFilter === 'today') {
        filteredTodos = filteredTodos.filter(t => {
            return t.date === todayStr || isOverdue(t, todayStr) || !t.date || t.date === thisWeekStr || t.date === thisMonthStr;
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
            const groups = groupTodosByDate(filteredTodos, todayStr);
            const { todayGroup, noDateGroup, weekGroup, monthGroup, futureGroup, pastGroup } = groups;

            todayGroup.sort(sortFunc);
            noDateGroup.sort(sortFunc);
            weekGroup.sort(sortFunc);
            monthGroup.sort(sortFunc);

            futureGroup.sort((a, b) => {
                if (a.date !== b.date) return a.date.localeCompare(b.date);
                return sortFunc(a, b);
            });

            pastGroup.sort((a, b) => {
                if (a.date !== b.date) return b.date.localeCompare(a.date);
                return sortFunc(a, b);
            });

            if (todayGroup.length > 0) renderGroup(todayGroup, '今天', { color: 'var(--text-primary)' }, todayStr, tomorrowStr);
            if (noDateGroup.length > 0) renderGroup(noDateGroup, '无日期', {}, todayStr, tomorrowStr);
            if (weekGroup.length > 0) renderGroup(weekGroup, '周任务', { color: '#fadb14', borderLeftColor: '#fadb14' }, todayStr, tomorrowStr);
            if (monthGroup.length > 0) renderGroup(monthGroup, '月任务', { color: '#fadb14', borderLeftColor: '#fadb14' }, todayStr, tomorrowStr);
            if (futureGroup.length > 0) renderGroup(futureGroup, '未来计划', { color: 'var(--text-primary)' }, todayStr, tomorrowStr);
            if (pastGroup.length > 0) renderGroup(pastGroup, '过往记忆', { color: 'var(--text-secondary)', borderLeftColor: 'var(--border-color)' }, todayStr, tomorrowStr);
        }
        
        // Initialize SortableJS — 仅对"今天聚焦"启用拖动排序
        if (dateFilter === 'today' && window.Sortable) {
            // 销毁旧 Sortable 实例，防止内存泄漏
            document.querySelectorAll('.collapsible-content').forEach(el => {
                if (el._sortableInstance) {
                    el._sortableInstance.destroy();
                    el._sortableInstance = null;
                }
            });
            document.querySelectorAll('.collapsible-content').forEach(container => {
                container._sortableInstance = new Sortable(container, {
                    animation: 150,
                    ghostClass: 'drag-over',
                    chosenClass: 'drag-chosen',
                    dragClass: 'drag-active',
                    filter: '.checkbox, .todo-content, .todo-meta, .inline-subtasks-list, .edit-btn',
                    preventOnFilter: false,
                    delay: 200,
                    delayOnTouchOnly: false,
                    fallbackTolerance: 5,
                    forceFallback: true,
                    fallbackClass: 'drag-fallback',
                    fallbackOnBody: true,
                    onEnd: async function(evt) {
                        const allNodes = Array.from(evt.to.children);
                        const separatorIndex = allNodes.findIndex(n => n.classList.contains('list-separator'));
                        let stateChanged = false;
                        
                        const items = Array.from(evt.to.querySelectorAll('.todo-item'));
                        items.forEach((el, index) => {
                            const id = el.dataset.id;
                            const t = todoData.todos.find(td => td.id === id);
                            if (t) {
                                if (t.order !== index) {
                                    t.order = index;
                                    t.updated_at = new Date().toISOString();
                                    stateChanged = true;
                                }
                                
                                if (separatorIndex !== -1) {
                                    const nodeIndex = allNodes.indexOf(el);
                                    if (nodeIndex < separatorIndex) {
                                        // 拖到了上半区，赋予今天日期
                                        if (!t.date) {
                                            t.date = getTodayString();
                                            stateChanged = true;
                                        }
                                    } else {
                                        // 拖到了下半区，如果原本是明确日期（非周期）则清除日期
                                        if (t.date && !isWeekDate(t.date) && !isMonthDate(t.date)) {
                                            t.date = '';
                                            stateChanged = true;
                                        }
                                    }
                                }
                            }
                        });
                        if (stateChanged) {
                            render();
                            await saveData();
                        }
                    }
                });
            });
        }
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

    // 手动同步按钮
    const manualSyncBtn = document.getElementById('manual-sync-btn');
    if (manualSyncBtn) {
        manualSyncBtn.addEventListener('click', async () => {
            const svg = manualSyncBtn.querySelector('svg');
            if (svg) svg.classList.add('sync-spin');
            
            await loadData();
            
            if (svg) svg.classList.remove('sync-spin');
        });
    }

    // 设置同步目录/WebDAV
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const settingsCancelBtn = document.getElementById('settings-cancel-btn');
    const settingsSaveBtn = document.getElementById('settings-save-btn');
    const settingSyncMode = document.getElementById('setting-sync-mode');
    const settingLocalGroup = document.getElementById('setting-local-group');
    const settingWebdavGroup = document.getElementById('setting-webdav-group');
    const settingChooseDirBtn = document.getElementById('setting-choose-dir-btn');
    const settingSyncPath = document.getElementById('setting-sync-path');
    const settingWebdavUrl = document.getElementById('setting-webdav-url');
    const settingWebdavUser = document.getElementById('setting-webdav-user');
    const settingWebdavPass = document.getElementById('setting-webdav-pass');
    const settingWebdavFilepath = document.getElementById('setting-webdav-filepath');

    if (settingsBtn) {
        settingsBtn.addEventListener('click', async () => {
            appConfig = await invoke("get_app_config");
            settingSyncMode.value = appConfig.sync_mode || 'local';
            settingSyncPath.value = appConfig.sync_path || '';
            settingWebdavUrl.value = appConfig.webdav_url || 'https://dav.jianguoyun.com/dav/';
            settingWebdavUser.value = appConfig.webdav_username || '';
            settingWebdavPass.value = appConfig.webdav_password || '';
            settingWebdavFilepath.value = appConfig.webdav_filepath || '我的坚果云/to-do/todo_data.json';
            
            if (settingSyncMode.value === 'webdav') {
                settingLocalGroup.style.display = 'none';
                settingWebdavGroup.style.display = 'block';
            } else {
                settingLocalGroup.style.display = 'block';
                settingWebdavGroup.style.display = 'none';
            }
            settingsModal.classList.add('active');
        });

        settingSyncMode.addEventListener('change', (e) => {
            if (e.target.value === 'webdav') {
                settingLocalGroup.style.display = 'none';
                settingWebdavGroup.style.display = 'block';
            } else {
                settingLocalGroup.style.display = 'block';
                settingWebdavGroup.style.display = 'none';
            }
        });

        settingChooseDirBtn.addEventListener('click', async () => {
            try {
                await invoke('set_always_on_top', { alwaysOnTop: true });
                const selectedPath = await invoke("pick_sync_folder");
                await invoke('set_always_on_top', { alwaysOnTop: false });
                if (selectedPath) {
                    settingSyncPath.value = selectedPath;
                    await invoke("set_sync_path", { newPath: selectedPath });
                }
            } catch (e) {
                console.error("Failed to pick folder", e);
                await invoke('set_always_on_top', { alwaysOnTop: false });
            }
        });

        settingsCancelBtn.addEventListener('click', () => {
            settingsModal.classList.remove('active');
        });

        settingsSaveBtn.addEventListener('click', async () => {
            const newConfig = {
                sync_mode: settingSyncMode.value,
                sync_path: settingSyncPath.value,
                webdav_url: settingWebdavUrl.value,
                webdav_username: settingWebdavUser.value,
                webdav_password: settingWebdavPass.value,
                webdav_filepath: settingWebdavFilepath.value,
            };
            await invoke("save_app_config", { config: newConfig });
            appConfig = newConfig;
            
            settingsModal.classList.remove('active');
            await loadData();
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
        } else {
            currentView = 'list';
            mainContentEl.classList.remove('hidden');
            mainContentEl.className = 'list-view';
            if (tabsContainerEl) tabsContainerEl.classList.remove('hidden');
            if (appFooterEl) appFooterEl.classList.remove('hidden');
            statsContainerEl.classList.add('hidden');
            statsBtn.classList.remove('active');
        }
        render();
    };

    if (statsBtn) {
        statsBtn.addEventListener('click', () => {
            toggleStatsView(currentView !== 'stats');
        });
    }

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

    // 添加子步骤
    document.getElementById('add-subtask-btn').addEventListener('click', () => {
        const input = document.getElementById('add-subtask-input');
        if (!input) return;
        const content = input.value.trim();
        if (content && currentEditingTodo) {
            currentEditingSubtasks.push({ id: crypto.randomUUID(), content, completed: false });
            input.value = '';
            renderEditSubtasks();
            autoSaveEdit();
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
                const orig = currentImportCandidates[idx];
                const newTodo = createTodo(orig.content, targetDateStr);
                newTodo.time = orig.time || null;
                newTodo.recurring = orig.recurring || 'none';
                newTodo.subtasks = orig.subtasks ? JSON.parse(JSON.stringify(orig.subtasks)).map(s => { s.completed = false; return s; }) : [];
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

    // 绑定编辑模态框自动保存
    ['edit-content', 'edit-date', 'edit-time', 'edit-recurring'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', autoSaveEdit);
            el.addEventListener('blur', autoSaveEdit);
        }
    });

    document.getElementById('edit-modal').addEventListener('click', (e) => {
        if (e.target.id === 'edit-modal') closeEditModal();
    });

    document.getElementById('delete-confirm-modal').addEventListener('click', (e) => {
        if (e.target.id === 'delete-confirm-modal') {
            document.getElementById('delete-confirm-modal').classList.remove('active');
        }
    });

    document.getElementById('modal-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!currentEditingTodo) return;
        const confirmModal = document.getElementById('delete-confirm-modal');
        confirmModal.classList.add('active');
    });

    document.getElementById('delete-cancel-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('delete-confirm-modal').classList.remove('active');
    });

    document.getElementById('delete-confirm-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!currentEditingTodo) return;
        const index = todoData.todos.findIndex(t => t.id === currentEditingTodo.id);
        if (index !== -1) {
            todoData.todos[index].deleted = true;
            todoData.todos[index].updated_at = new Date().toISOString();
            render();
            await saveData();
        }
        document.getElementById('delete-confirm-modal').classList.remove('active');
        closeEditModal();
    });

    document.getElementById('modal-tomorrow-btn').addEventListener('click', async () => {
        if (!currentEditingTodo) return;
        document.getElementById('edit-date').value = getTomorrowString();
        await autoSaveEdit();
        closeEditModal();
    });

    // Back button
    document.getElementById('modal-back-btn').addEventListener('click', () => {
        closeEditModal();
    });

    // 复制子步骤逻辑
    const copyModal = document.getElementById('copy-modal');
    document.getElementById('copy-subtasks-btn').addEventListener('click', () => {
        if (!currentEditingSubtasks || currentEditingSubtasks.length === 0) {
            alert('没有子步骤可复制');
            return;
        }
        copyModal.style.display = 'flex';
        // Force reflow
        void copyModal.offsetWidth;
        copyModal.classList.add('active');
    });

    const performCopy = async (format) => {
        let textToCopy = '';
        currentEditingSubtasks.forEach((sub, i) => {
            if (format === '2') {
                textToCopy += '- ' + sub.content + '\n';
            } else if (format === '3') {
                textToCopy += (i + 1) + '. ' + sub.content + '\n';
            } else {
                textToCopy += sub.content + '\n';
            }
        });
        try {
            await navigator.clipboard.writeText(textToCopy.trim());
        } catch (e) {
            console.error('Clipboard error', e);
        }
        copyModal.classList.remove('active');
        setTimeout(() => copyModal.style.display = 'none', 200);
    };

    document.getElementById('copy-opt-1').addEventListener('click', () => performCopy('1'));
    document.getElementById('copy-opt-2').addEventListener('click', () => performCopy('2'));
    document.getElementById('copy-opt-3').addEventListener('click', () => performCopy('3'));
    document.getElementById('copy-opt-cancel').addEventListener('click', () => {
        copyModal.classList.remove('active');
        setTimeout(() => copyModal.style.display = 'none', 200);
    });

    // 添加新待办表单
    formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        const raw = inputEl.value;
        const { content, taskDate } = parseInputSyntax(raw);
        if (!content) return;

        todoData.todos.push(createTodo(content, taskDate));
        inputEl.value = '';
        render();
        await saveData();
    });

    // Watch file changes
    listen("todo_data_changed", () => {
        if (saveVersion > 0) {
            saveVersion--; // 消耗掉自身写入产生的文件变更事件
            return;
        }
        if (appConfig.sync_mode === 'webdav') return; // WebDAV 模式下避免死循环
        loadData();
    });

    // 闪电录入逻辑
    const quickAddModal = document.getElementById('quick-add-modal');
    const quickAddInput = document.getElementById('quick-add-input');
    
    listen('trigger-quick-add', (event) => {
        if (quickAddModal && quickAddInput) {
            quickAddModal.classList.add('active');
            quickAddInput.value = '';
            setTimeout(() => quickAddInput.focus(), 100);
        }
    });

    quickAddInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') {
            quickAddModal.classList.remove('active');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const content = quickAddInput.value.trim();
            if (!content) return;

            todoData.todos.push(createTodo(content, getTodayString()));
            quickAddModal.classList.remove('active');
            render();
            await saveData();
        }
    });

    quickAddModal.addEventListener('mousedown', (e) => {
        if (e.target === quickAddModal) {
            quickAddModal.classList.remove('active');
        }
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