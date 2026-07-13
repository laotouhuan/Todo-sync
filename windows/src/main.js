import {
    formatDate, getISOWeekString,
    getTodayString, getTomorrowString, getThisWeekString, getLastWeekString,
    getThisMonthString, getLastMonthString,
    isWeekDate, isMonthDate, isOverdue, getDateLabel, getCompletionStatusLabel,
    sortFunc, parseInputSyntax, createTodo, groupTodosByDate,
    categorizeByTimeSlot, calcTaskAgeDays, getHealthGrade
} from './dateUtils.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ====== State ======
const appState = {
    todoData: { version: 1, last_updated: new Date().toISOString(), todos: [] },
    saveVersion: 0, // 递增版本号，防止自身写入触发的文件变更重载
    currentView: 'list', // 'list' | 'stats'
    appConfig: {},
    isPinned: false,
    statsPeriod: 'day', // 'day' | 'week' | 'month'
    statsStatus: 'all', // 'all' | 'completed' | 'uncompleted'
    statsTargetDate: new Date(),
    statsSubTab: 'insights', // 'insights' | 'health'
    healthThroughputDays: 30, // 吞吐量统计天数，默认30天
    todayCollapsed: false,
    weekCollapsed: true,
    monthCollapsed: true,
    currentEditingTodo: null,
    editCachedDate: '',
    dateFilter: 'today', // 'today' | 'all'
    searchQuery: '',
    allTabMode: 'uncompleted', // 'uncompleted' | 'completed'
    showAllHistory: false,
    currentEditingSubtasks: [],
    currentImportType: null,
    currentImportCandidates: [],
    expandedTaskIds: new Set(),
    completedCollapsed: {},
    futureCollapsed: true,
    noDateCollapsed: true,
    pastCollapsed: true,
    statsFilters: {
        normal: true,
        daily: true,
        weekly: true,
        monthly: true
    },
    showStatsList: false,
};

// 模块级拖拽状态（替代 window 全局属性）
let _currentlyDraggedTodoId = null;
let _currentlyHoveredHeaderType = null;

// 渲染差异检测
let _lastRenderedHash = '';

// 保存队列（串行化并发写入）
let _saveQueue = Promise.resolve();
let _pendingMidnightRefresh = false;

// ====== 共享常量 ======
const PURGE_DELETED_AFTER_DAYS = 7;
const DEFAULT_HISTORY_VISIBLE_DAYS = 3;
const RECURRING_LABELS = { daily_repeat: '每天重复' };

// SVG Icons
const ICON_VIEW_LIST = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M4 6H20V8H4V6ZM4 11H20V13H4V11ZM4 16H20V18H4V16Z" fill="currentColor"/></svg>`;

// DOM Elements (initialized in DOMContentLoaded)
let listEl, formEl, inputEl, statusEl;

// ====== Utility Functions ======
function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/** 将用户数据转义为安全 HTML，防止 XSS */
function escapeHtml(str) {
    if (!str) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, c => map[c]);
}

/** 深拷贝工具（替代 JSON.parse(JSON.stringify(...))） */
function deepClone(obj) {
    return structuredClone(obj);
}

const SyncState = { IDLE: 'idle', SYNCING: 'syncing', ERROR: 'error' };

function setSyncStatus(state) {
    if (statusEl) {
        statusEl.classList.remove('syncing', 'error');
        if (state === SyncState.SYNCING) statusEl.classList.add('syncing');
        else if (state === SyncState.ERROR) statusEl.classList.add('error');
    }
}

/**
 * 智能输入联想与补全逻辑
 */
function insertCompletion(input, value) {
    const lastAtIdx = input.value.lastIndexOf('@');
    if (lastAtIdx !== -1) {
        input.value = input.value.substring(0, lastAtIdx) + value + ' ';
    }
}

function bindAutocomplete(inputEl, listEl) {
    if (!inputEl || !listEl) return;
    
    const items = [
        { label: '今天', value: '@today', desc: '今天截止' },
        { label: '明天', value: '@tomorrow', desc: '明天截止' },
        { label: '每天重复', value: '@daily', desc: '每日重复任务' },
        { label: '本周打卡', value: '@week', desc: '本周打卡任务' },
        { label: '本月打卡', value: '@month', desc: '本月打卡任务' }
    ];
    
    inputEl.addEventListener('input', () => {
        const match = inputEl.value.match(/(?:^|\s)@([a-zA-Z0-9-]*)$/);
        if (!match) {
            listEl.style.display = 'none';
            return;
        }
        
        const query = match[1].toLowerCase();
        const filtered = items.filter(item => item.value.toLowerCase().startsWith('@' + query));
        
        listEl.innerHTML = '';
        if (filtered.length === 0) {
            listEl.style.display = 'none';
            return;
        }
        
        filtered.forEach((item, index) => {
            const li = document.createElement('li');
            li.className = 'autocomplete-item';
            if (index === 0) {
                li.classList.add('active');
            }
            li.dataset.value = item.value;
            li.innerHTML = `${item.label} <span class="shortcut-desc">${item.desc}</span>`;
            
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                insertCompletion(inputEl, item.value);
                listEl.style.display = 'none';
            });
            
            listEl.appendChild(li);
        });
        
        listEl.style.display = 'block';
    });
    
    inputEl.addEventListener('keydown', (e) => {
        if (listEl.style.display === 'none') return;
        
        const liElements = listEl.querySelectorAll('.autocomplete-item');
        if (liElements.length === 0) return;
        
        let activeIdx = -1;
        liElements.forEach((li, index) => {
            if (li.classList.contains('active')) {
                activeIdx = index;
            }
        });
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (activeIdx !== -1) {
                liElements[activeIdx].classList.remove('active');
            }
            const nextIdx = (activeIdx + 1) % liElements.length;
            liElements[nextIdx].classList.add('active');
            liElements[nextIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (activeIdx !== -1) {
                liElements[activeIdx].classList.remove('active');
            }
            const prevIdx = (activeIdx - 1 + liElements.length) % liElements.length;
            liElements[prevIdx].classList.add('active');
            liElements[prevIdx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            if (activeIdx !== -1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const val = liElements[activeIdx].dataset.value;
                insertCompletion(inputEl, val);
                listEl.style.display = 'none';
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            listEl.style.display = 'none';
        }
    });
    
    inputEl.addEventListener('blur', () => {
        listEl.style.display = 'none';
    });
}

/**
 * 统一设置任务类型和重复属性（供表单提交和闪电录入共用）
 * @param {Object} todo - createTodo 返回的对象
 * @param {string|null} taskType - parseInputSyntax 解析出的任务类型
 * @param {number|null} targetCount - parseInputSyntax 解析出的目标打卡次数
 */
function applyTaskType(todo, taskType, targetCount) {
    if (taskType === 'daily_repeat') {
        todo.task_type = 'normal';
        todo.recurring = 'daily_repeat';
    } else {
        if (taskType) todo.task_type = taskType;
        if (targetCount !== null) todo.target_count = targetCount;
        if (taskType === 'weekly_checkin' || taskType === 'monthly_checkin') {
            todo.recurring = 'none';
        }
    }
}

function migrateAndNormalize(todo) {
    if (!todo) return todo;
    // 1. 旧版 recurring 迁移
    if (todo.recurring === 'daily') {
        todo.recurring = 'daily_repeat';
        todo.task_type = todo.task_type || 'normal';
    } else if (todo.recurring === 'weekly') {
        todo.recurring = 'none';
        todo.task_type = 'weekly_checkin';
    } else if (todo.recurring === 'monthly') {
        todo.recurring = 'none';
        todo.task_type = 'monthly_checkin';
    }
    // 3. 强制类型与日期的同步
    if (todo.date && isWeekDate(todo.date)) {
        todo.task_type = 'weekly_checkin';
    } else if (todo.date && isMonthDate(todo.date)) {
        todo.task_type = 'monthly_checkin';
    }
    // 2. 补全新字段默认值
    todo.task_type = todo.task_type || 'normal';
    todo.completed_dates = todo.completed_dates || [];
    todo.target_count = todo.target_count ?? null;
    if (todo.completed === null) todo.completed = false;
    if (todo.subtasks) {
        todo.subtasks.forEach(s => {
            s.completed_at = s.completed_at || null;
        });
    } else {
        todo.subtasks = [];
    }
    return todo;
}

function mergeTodoData(localData, cloudData) {
    if (!localData || !localData.todos) {
        if (cloudData && cloudData.todos) {
            cloudData.todos.forEach(migrateAndNormalize);
        }
        return { data: cloudData, changed: true };
    }
    if (!cloudData || !cloudData.todos) {
        localData.todos.forEach(migrateAndNormalize);
        return { data: localData, changed: false };
    }

    localData.todos.forEach(migrateAndNormalize);
    cloudData.todos.forEach(migrateAndNormalize);

    const localMap = new Map(localData.todos.map(t => [t.id, t]));
    const cloudMap = new Map(cloudData.todos.map(t => [t.id, t]));
    const mergedTodos = [];
    let changed = false;

    for (const [id, lTodo] of localMap) {
        const cTodo = cloudMap.get(id);
        if (cTodo) {
            const lTime = new Date(lTodo.updated_at || lTodo.created_at || 0).getTime();
            const cTime = new Date(cTodo.updated_at || cTodo.created_at || 0).getTime();
            let merged;
            if (cTime > lTime) {
                merged = deepClone(cTodo);
                changed = true;
            } else {
                merged = deepClone(lTodo);
            }
            // completed_dates 智能合并：支持销卡（删除打卡）同步与离线补卡合并
            const lDates = lTodo.completed_dates || [];
            const cDates = cTodo.completed_dates || [];
            const allDateParts = [...new Set([
                ...lDates.map(d => d.split('T')[0]),
                ...cDates.map(d => d.split('T')[0])
            ])];

            const mergedDates = [];
            allDateParts.forEach(datePart => {
                const checkinL = lDates.find(d => d.startsWith(datePart));
                const checkinC = cDates.find(d => d.startsWith(datePart));

                if (checkinL && checkinC) {
                    if (checkinL.length >= checkinC.length) {
                        mergedDates.push(checkinL);
                    } else {
                        mergedDates.push(checkinC);
                    }
                } else if (checkinL) {
                    if (checkinL.length > 10) {
                        const tCheck = new Date(checkinL).getTime();
                        if (tCheck > cTime) {
                            mergedDates.push(checkinL);
                        }
                    } else {
                        mergedDates.push(checkinL);
                    }
                } else if (checkinC) {
                    if (checkinC.length > 10) {
                        const tCheck = new Date(checkinC).getTime();
                        if (tCheck > lTime) {
                            mergedDates.push(checkinC);
                        }
                    } else {
                        mergedDates.push(checkinC);
                    }
                }
            });
            mergedDates.sort();

            if (JSON.stringify(merged.completed_dates) !== JSON.stringify(mergedDates)) {
                merged.completed_dates = mergedDates;
                merged.updated_at = new Date().toISOString();
                changed = true;
            }

            // 重新计算周/月打卡任务完成状态
            if (merged.task_type === 'weekly_checkin' || merged.task_type === 'monthly_checkin') {
                const currentPeriodCount = merged.task_type === 'weekly_checkin'
                    ? getWeeklyCompletedCount(merged)
                    : getMonthlyCompletedCount(merged);
                const shouldBeCompleted = Boolean(merged.target_count && currentPeriodCount >= merged.target_count);
                if (merged.completed !== shouldBeCompleted) {
                    merged.completed = shouldBeCompleted;
                    merged.completed_at = shouldBeCompleted ? (merged.completed_at || new Date().toISOString()) : null;
                    merged.updated_at = new Date().toISOString();
                    changed = true;
                }
            }
            mergedTodos.push(merged);
        } else {
            mergedTodos.push(lTodo);
        }
    }
    for (const [id, cTodo] of cloudMap) {
        if (!localMap.has(id)) {
            mergedTodos.push(cTodo);
            changed = true;
        }
    }
    mergedTodos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
        data: {
            version: localData.version || 1,
            last_updated: new Date().toISOString(),
            todos: mergedTodos
        },
        changed: changed || mergedTodos.length !== localData.todos.length
    };
}

// ====== Data I/O ======
async function loadData() {
    try {
        setSyncStatus(SyncState.SYNCING);
        appState.appConfig = await invoke("get_app_config");

        let localJsonStr = await invoke("read_todo_data").catch(() => "{}");
        let localData = null;
        try { localData = JSON.parse(localJsonStr); } catch (e) {}

        if (appState.appConfig.sync_mode === 'webdav') {
            try {
                let cloudJsonStr = await invoke("fetch_from_cloud");
                let cloudData = JSON.parse(cloudJsonStr);

                let { data: mergedData, changed } = mergeTodoData(localData, cloudData);
                appState.todoData = mergedData;
                // migrateAndNormalize 已在 mergeTodoData 内部对所有 todo 调用，无需重复
                render();

                if (changed || JSON.stringify(mergedData.todos) !== JSON.stringify(localData.todos)) {
                    await saveData();
                    showToast('检测到云端更新，已自动同步完成');
                }
            } catch (e) {
                if (e === "FILE_NOT_FOUND") {
                    console.log("Cloud file not found, but parent folder exists. Initializing cloud database with local data...");
                    if (localData && localData.todos) {
                        appState.todoData = localData;
                        appState.todoData.todos.forEach(migrateAndNormalize);
                        render();
                    } else {
                        appState.todoData = { version: 1, last_updated: new Date().toISOString(), todos: [] };
                        render();
                    }
                    await saveData();
                } else {
                    console.error("WebDAV pull failed, using local cache:", e);
                    if (localData && localData.todos) {
                        appState.todoData = localData;
                        appState.todoData.todos.forEach(migrateAndNormalize);
                        render();
                    }
                    setSyncStatus(SyncState.ERROR);
                    if (typeof e === 'string' && e.includes("云端同步目录不存在")) {
                        showToast(e);
                    } else {
                        showToast("云端同步失败，请检查网络或配置");
                    }
                }
            }
        } else {
            if (localData && localData.todos) {
                appState.todoData = localData;
                appState.todoData.todos.forEach(migrateAndNormalize);
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

// ====== 方案二：定期物理清理过期（已删除超 7 天）的任务 ======
function purgeOldDeletedTodos() {
    if (!appState.todoData || !appState.todoData.todos) return;
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - PURGE_DELETED_AFTER_DAYS);
    
    const originalCount = appState.todoData.todos.length;
    appState.todoData.todos = appState.todoData.todos.filter(t => {
        if (t.deleted) {
            const updateTime = t.updated_at ? new Date(t.updated_at) : new Date(t.created_at);
            if (isNaN(updateTime.getTime()) || updateTime < sevenDaysAgo) {
                // 已经删除超过 7 天，执行物理抹除
                return false;
            }
        }
        return true;
    });
    
    const purgedCount = originalCount - appState.todoData.todos.length;
    if (purgedCount > 0) {
        console.log(`[Purge] 自动物理清理了 ${purgedCount} 个已删除超过 7 天的旧任务记录。`);
    }
}

function saveData() {
    _saveQueue = _saveQueue.then(() => _doSaveData()).catch(e => console.error('Save failed:', e));
    return _saveQueue;
}

async function _doSaveData() {
    try {
        setSyncStatus(SyncState.SYNCING);
        // 执行物理清理，将删除超 7 天的旧任务彻底抹除，维持 JSON 大小
        purgeOldDeletedTodos();
        
        appState.todoData.last_updated = new Date().toISOString();
        const jsonStr = JSON.stringify(appState.todoData, null, 2);
        appState.saveVersion++;
        await invoke("write_todo_data", { data: jsonStr });

        if (appState.appConfig.sync_mode === 'webdav') {
            try {
                await invoke("sync_to_cloud", { data: jsonStr });
            } catch (e) {
                console.error("WebDAV push failed:", e);
                showToast("推送至云端失败: " + e);
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
        const dateClass = (overdue && appState.dateFilter === 'today') ? 'overdue' : '';

        // 已完成和未完成任务都显示截止日期，确保已完成历史中保留原始截止信息
        html += `<span class="meta-item date ${dateClass}">📅 ${escapeHtml(dateLabel)}</span>`;
    }
    // Time rendering removed as per v1.0.2 design
    if (todo.recurring && todo.recurring !== 'none') {
        html += `<span class="meta-item meta-icon" title="循环: ${escapeHtml(RECURRING_LABELS[todo.recurring] || todo.recurring)}">🔁</span>`;
    }
    if (todo.subtasks && todo.subtasks.length > 0) {
        const completedCount = todo.subtasks.filter(s => s.completed).length;
        html += `<span class="meta-item subtask-progress">📋 ${completedCount}/${todo.subtasks.length}</span>`;
    }
    if (todo.completed) {
        const dateSource = todo.completed_at || todo.checkinDate;
        if (dateSource) {
            const mmdd = dateSource.substring(5, 10);
            html += `<span class="meta-item completion-date" style="color: var(--urgency-low);">✓ 完成于 ${escapeHtml(mmdd)}</span>`;
        }
    }
    return html;
}

// ====== Create Todo Item Element ======
function createTodoItemElement(todo, todayStr, tomorrowStr, checkinDate = null) {
    const li = document.createElement('li');
    const isCheckinCompletedToday = (todo.task_type === 'weekly_checkin' || todo.task_type === 'monthly_checkin')
        && todo.completed_dates && todo.completed_dates.some(dStr => dStr.startsWith(todayStr));
    const isVisualCompleted = checkinDate !== null ? true : (todo.completed || isCheckinCompletedToday);
    const highlightDate = checkinDate ? checkinDate.substring(0, 10) : todayStr;
    li.className = `todo-item ${isVisualCompleted ? 'completed' : ''}`;
    li.id = checkinDate !== null ? `todo-${todo.id}-${checkinDate}` : `todo-${todo.id}`;
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
            <div class="read-only-checkin-container" style="margin-top: 6px;"></div>
            <ul class="inline-subtasks-list" style="display: ${appState.expandedTaskIds.has(todo.id) ? 'block' : 'none'}; padding-left: 0; list-style: none; margin-top: 8px; width: 100%;"></ul>
        </div>
        <button class="edit-btn" aria-label="修改">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
                <path d="M3 17.25V21H6.75L17.81 9.94L14.06 6.19L3 17.25ZM20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C17.98 2.9 17.35 2.9 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04Z" fill="currentColor"/>
            </svg>
        </button>
    `;
    // 用 textContent 设置待办内容，防止 HTML 注入
    li.querySelector('.todo-content').textContent = todo.content;

    const checkinContainer = li.querySelector('.read-only-checkin-container');
    if (todo.task_type === 'weekly_checkin') {
        const count = getWeeklyCompletedCount(todo);
        const infoRow = document.createElement('div');
        infoRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";
        const labelText = todo.target_count 
            ? `进度：${count}/${todo.target_count}次` 
            : `打卡：${count}次`;
        infoRow.innerHTML = `<span style="font-size: 0.75rem; color: var(--text-secondary);">${labelText}</span>`;
        checkinContainer.appendChild(infoRow);

        const grid = document.createElement('div');
        grid.className = 'checkin-grid-container compact-checkin-grid';
        let monday;
        if (todo.date && isWeekDate(todo.date)) {
            monday = getMondayFromWeek(todo.date);
        } else {
            monday = new Date();
            const day = monday.getDay();
            const diff = monday.getDate() - day + (day === 0 ? -6 : 1);
            monday.setDate(diff);
        }

        const labels = ['一', '二', '三', '四', '五', '六', '日'];
        const completedDates = todo.completed_dates || [];
        for (let i = 0; i < 7; i++) {
            const current = new Date(monday);
            current.setDate(monday.getDate() + i);
            const dateStr = formatDate(current);

            const cell = document.createElement('div');
            const isChecked = completedDates.some(d => d.startsWith(dateStr));
            cell.className = `checkin-grid-cell compact-cell${isChecked ? ' checked' : ''}${dateStr === highlightDate ? ' today-cell' : ''}`;
            cell.textContent = labels[i];
            cell.title = dateStr;
            grid.appendChild(cell);
        }
        checkinContainer.appendChild(grid);
    } else if (todo.task_type === 'monthly_checkin') {
        const progressWrapper = document.createElement('div');
        progressWrapper.style.cssText = "display: flex; flex-direction: column; gap: 4px; margin-top: 4px;";
        
        const count = getMonthlyCompletedCount(todo);
        const barRow = document.createElement('div');
        barRow.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 8px;";
        
        if (todo.target_count) {
            const target = todo.target_count;
            const pct = Math.min(100, Math.round((count / target) * 100));
            barRow.innerHTML = `
                <div style="flex-grow: 1; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; position: relative;">
                    <div style="width: ${pct}%; height: 100%; background: var(--accent-color); border-radius: 3px; transition: width 0.3s;"></div>
                </div>
                <span style="font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; margin-left: 8px;">进度：${count}/${target}天</span>
            `;
        } else {
            barRow.innerHTML = `
                <span style="font-size: 0.75rem; color: var(--text-secondary);">打卡：${count}次</span>
            `;
        }

        const monthCalendarGrid = document.createElement('div');
        monthCalendarGrid.className = 'checkin-grid-container compact-checkin-grid';
        monthCalendarGrid.style.display = appState.expandedTaskIds.has(todo.id) ? 'grid' : 'none';
        monthCalendarGrid.style.marginTop = '6px';

        renderMonthCalendar(monthCalendarGrid, todo, false, highlightDate);

        progressWrapper.appendChild(barRow);
        progressWrapper.appendChild(monthCalendarGrid);
        checkinContainer.appendChild(progressWrapper);
    }

    const subtasksList = li.querySelector('.inline-subtasks-list');
    if (todo.subtasks && todo.subtasks.length > 0) {
        todo.subtasks.forEach((sub, idx) => {
            const subLi = document.createElement('li');
            subLi.className = `subtask-item ${sub.completed ? 'completed' : ''}`;
            subLi.style.cssText = "display: flex; align-items: center; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 4px; padding: 4px 0; transition: all 0.2s;";
            subLi.innerHTML = `
                <div class="subtask-checkbox" style="width: 14px; height: 14px; margin-right: 8px; flex-shrink: 0; cursor: pointer; border: 1.5px solid ${sub.completed ? 'var(--accent-color)' : 'var(--text-secondary)'}; background: ${sub.completed ? 'var(--accent-color)' : 'transparent'}; border-radius: 4px; display: flex; justify-content: center; align-items: center; transition: all 0.2s;">
                    <svg viewBox="0 0 24 24" fill="none" width="10" height="10" style="opacity: ${sub.completed ? '1' : '0'}; transition: opacity 0.2s;">
                        <path d="M5 13L9 17L19 7" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <span style="color: ${sub.completed ? 'var(--text-secondary)' : 'var(--text-primary)'}; text-decoration: ${sub.completed ? 'line-through' : 'none'}; transition: all 0.2s;"></span>
            `;
            let subText = sub.content;
            if (sub.completed && sub.completed_at) {
                subText += ` (完成于 ${sub.completed_at.substring(5, 10)})`;
            }
            subLi.querySelector('span').textContent = subText;
            subLi.querySelector('.subtask-checkbox').addEventListener('click', async (e) => {
                e.stopPropagation();
                sub.completed = !sub.completed;
                sub.completed_at = sub.completed ? new Date().toISOString() : null;
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
        if (checkinDate !== null) {
            const index = appState.todoData.todos.findIndex(t => t.id === todo.id);
            if (index !== -1) {
                const t = appState.todoData.todos[index];
                const dateIdx = t.completed_dates.findIndex(d => d.startsWith(checkinDate));
                if (dateIdx > -1) {
                    t.completed_dates.splice(dateIdx, 1);
                }
                if (t.target_count) {
                    t.completed = t.completed_dates.length >= t.target_count;
                    t.completed_at = t.completed ? (t.completed_at || new Date().toISOString()) : null;
                } else {
                    t.completed = false;
                    t.completed_at = null;
                }
                t.updated_at = new Date().toISOString();
                render();
                await saveData();
            }
            return;
        }
        const index = appState.todoData.todos.findIndex(t => t.id === todo.id);
        if (index !== -1) {
            const t = appState.todoData.todos[index];

            // 周/月打卡任务处理分支
            if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                const todayISO = getTodayString();
                t.completed_dates = t.completed_dates || [];

                // 1. 已达标时的交互限制：不执行取消打卡操作
                if (t.completed) {
                    showToast('已达到目标次数！如需消卡，请点击文本进入编辑弹窗。');
                    return;
                }

                // 2. 今天已打过卡
                if (t.completed_dates.some(d => d.startsWith(todayISO))) {
                    showToast('今天已打卡！如需消卡，请点击文本进入编辑弹窗。');
                    return;
                }

                // 3. 执行打卡 (正常打卡保存完整 ISO 时间戳)
                t.completed_dates.push(new Date().toISOString());
                t.completed_dates.sort();

                // 检查是否达标
                const currentPeriodCount = t.task_type === 'weekly_checkin' 
                    ? getWeeklyCompletedCount(t) 
                    : getMonthlyCompletedCount(t);
                if (t.target_count && currentPeriodCount >= t.target_count) {
                    t.completed = true;
                    t.completed_at = new Date().toISOString();
                }

                t.updated_at = new Date().toISOString();
                render();
                await saveData();
                return;
            }

            if (!t.completed && t.recurring === 'daily_repeat') {
                const tomorrowStr = getTomorrowString();
                const existsClone = appState.todoData.todos.some(
                    x => x.content === t.content && x.date === tomorrowStr 
                         && x.recurring === 'daily_repeat' && !x.deleted
                );
                if (!existsClone) {
                    const clone = createTodo(t.content, tomorrowStr);
                    clone.recurring = 'daily_repeat';
                    clone.order = -Date.now(); // 负数确保排在最前面
                    clone.subtasks = t.subtasks
                        ? deepClone(t.subtasks).map(s => {
                            s.id = crypto.randomUUID();
                            s.completed = false;
                            s.completed_at = null;
                            return s;
                        })
                        : [];
                    appState.todoData.todos.push(clone);
                }
            }
            t.completed = !t.completed;
            if (t.completed) {
                t.completed_at = new Date().toISOString();
                if (t.subtasks && t.subtasks.length > 0) {
                    t.subtasks.forEach(s => {
                        s.completed = true;
                        s.completed_at = s.completed_at || new Date().toISOString();
                    });
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
        
        const hasSubtasks = todo.subtasks && todo.subtasks.length > 0;
        const isMonthlyCheckin = todo.task_type === 'monthly_checkin';
        
        if (hasSubtasks || isMonthlyCheckin) {
            const monthGrid = li.querySelector('.compact-checkin-grid');
            if (appState.expandedTaskIds.has(todo.id)) {
                appState.expandedTaskIds.delete(todo.id);
                subtasksList.style.display = 'none';
                if (monthGrid) monthGrid.style.display = 'none';
            } else {
                appState.expandedTaskIds.add(todo.id);
                if (hasSubtasks) subtasksList.style.display = 'block';
                if (monthGrid) monthGrid.style.display = 'grid';
            }
        }
    });

    const editBtn = li.querySelector('.edit-btn');
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(todo);
    });

    if (appState.dateFilter === 'today') {
        li.dataset.id = todo.id;
    }

    return li;
}

// Helper to get Monday from YYYY-Www week string
function getMondayFromWeek(weekStr) {
    if (!weekStr || !weekStr.includes('-W')) return new Date();
    const parts = weekStr.split('-W');
    const year = parseInt(parts[0], 10);
    const week = parseInt(parts[1], 10);
    const jan4 = new Date(year, 0, 4);
    const day = jan4.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const mondayOfWeek1 = new Date(jan4);
    mondayOfWeek1.setDate(jan4.getDate() + diffToMonday);
    const targetMonday = new Date(mondayOfWeek1);
    targetMonday.setDate(mondayOfWeek1.getDate() + (week - 1) * 7);
    return targetMonday;
}

function getWeeklyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => {
        const parts = dStr.split('-');
        if (parts.length !== 3) return false;
        const date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return getISOWeekString(date) === todo.date;
    }).length;
}

function getMonthlyCompletedCount(todo) {
    if (!todo.completed_dates || !todo.date) return 0;
    return todo.completed_dates.filter(dStr => dStr.startsWith(todo.date)).length;
}

// ====== Month Calendar Grid Rendering (Week-aligned, with previous/next month tails) ======
let activeCheckinDropdown = null;

function showCheckinDropdown(cellEl, todo, dateStr) {
    // 1. Remove existing dropdown
    if (activeCheckinDropdown) {
        const isSame = activeCheckinDropdown.dataset.cellId === dateStr;
        activeCheckinDropdown.remove();
        activeCheckinDropdown = null;
        if (isSame) return; // Toggle close behavior
    }

    const completedDates = todo.completed_dates || [];
    const matchedDate = completedDates.find(d => d.startsWith(dateStr));
    const isChecked = !!matchedDate;

    // Create dropdown element
    const dropdown = document.createElement('div');
    dropdown.className = 'checkin-dropdown';
    dropdown.dataset.cellId = dateStr;

    // Prefill date and time
    let initialDate = dateStr;
    let initialTime = '';
    
    if (isChecked) {
        if (matchedDate.length > 10) {
            const d = new Date(matchedDate);
            if (!isNaN(d.getTime())) {
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                initialDate = `${yyyy}-${mm}-${dd}`;
                const hh = String(d.getHours()).padStart(2, '0');
                const min = String(d.getMinutes()).padStart(2, '0');
                initialTime = `${hh}:${min}`;
            }
        }
    } else {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        initialTime = `${hh}:${min}`;
    }



    dropdown.innerHTML = `
        <div style="font-weight: 600; font-size: 0.85rem; margin-bottom: 4px; color: var(--accent-color);">
            ${isChecked ? '修改打卡时间' : '补打卡'}
        </div>
        <div>
            <label>完成日期</label>
            <input type="date" id="dropdown-date" value="${initialDate}" />
        </div>
        <div>
            <label>完成时间</label>
            <input type="time" id="dropdown-time" value="${initialTime}" />
        </div>
        <div class="checkin-dropdown-buttons">
            ${isChecked ? `
                <button type="button" class="checkin-dropdown-btn primary" id="dropdown-save">保存</button>
                <button type="button" class="checkin-dropdown-btn danger" id="dropdown-cancel-check">销卡</button>
            ` : `
                <button type="button" class="checkin-dropdown-btn primary" id="dropdown-save">打卡</button>
                <button type="button" class="checkin-dropdown-btn secondary" id="dropdown-close">取消</button>
            `}
        </div>
    `;

    document.body.appendChild(dropdown);
    activeCheckinDropdown = dropdown;

    // Position dropdown relative to cellEl
    const rect = cellEl.getBoundingClientRect();
    const dropdownHeight = 190; // approx height
    const dropdownWidth = 200; // width from css
    
    // Default show below
    let top = rect.bottom + window.scrollY + 6;
    let left = rect.left + window.scrollX - (dropdownWidth - rect.width) / 2;

    // Boundary check
    if (top + dropdownHeight > window.innerHeight + window.scrollY) {
        // Show above instead
        top = rect.top + window.scrollY - dropdownHeight - 6;
    }
    if (left < 10) left = 10;
    if (left + dropdownWidth > window.innerWidth - 10) {
        left = window.innerWidth - dropdownWidth - 10;
    }

    dropdown.style.top = `${top}px`;
    dropdown.style.left = `${left}px`;

    // Click handlers
    const saveBtn = dropdown.querySelector('#dropdown-save');
    const closeBtn = dropdown.querySelector('#dropdown-close');
    const cancelCheckBtn = dropdown.querySelector('#dropdown-cancel-check');

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            dropdown.remove();
            activeCheckinDropdown = null;
        });
    }

    if (cancelCheckBtn) {
        cancelCheckBtn.addEventListener('click', async () => {
            // Delete checkin
            const idx = todo.completed_dates.findIndex(d => d.startsWith(dateStr));
            if (idx > -1) {
                todo.completed_dates.splice(idx, 1);
            }
            await onDropdownCheckinUpdate(todo);
            dropdown.remove();
            activeCheckinDropdown = null;
        });
    }

    saveBtn.addEventListener('click', async () => {
        const inputDate = dropdown.querySelector('#dropdown-date').value;
        const inputTime = dropdown.querySelector('#dropdown-time').value;
        if (!inputDate) return;

        let newIso;
        if (inputTime) {
            const [yyyy, mm, dd] = inputDate.split('-').map(Number);
            const [hh, min] = inputTime.split(':').map(Number);
            const d = new Date(yyyy, mm - 1, dd, hh, min, 0, 0);
            newIso = d.toISOString();
        } else {
            newIso = inputDate;
        }

        if (isChecked) {
            // Edit existing checkin: remove old, push new
            const idx = todo.completed_dates.findIndex(d => d.startsWith(dateStr));
            if (idx > -1) {
                todo.completed_dates.splice(idx, 1);
            }
            todo.completed_dates.push(newIso);
        } else {
            // New checkin
            todo.completed_dates.push(newIso);
        }
        todo.completed_dates.sort();

        await onDropdownCheckinUpdate(todo);
        dropdown.remove();
        activeCheckinDropdown = null;
    });

    // Close on click outside
    setTimeout(() => {
        const outsideClickListener = (e) => {
            if (!dropdown.contains(e.target) && !cellEl.contains(e.target)) {
                dropdown.remove();
                activeCheckinDropdown = null;
                document.removeEventListener('click', outsideClickListener);
            }
        };
        document.addEventListener('click', outsideClickListener);
    }, 50);
}

async function onDropdownCheckinUpdate(todo) {
    // Recompute completed status if target_count is set
    if (todo.target_count) {
        const currentPeriodCount = todo.task_type === 'weekly_checkin' 
            ? getWeeklyCompletedCount(todo) 
            : getMonthlyCompletedCount(todo);
        todo.completed = currentPeriodCount >= todo.target_count;
        todo.completed_at = todo.completed ? new Date().toISOString() : null;
    } else {
        todo.completed = false;
        todo.completed_at = null;
    }
    
    todo.updated_at = new Date().toISOString();
    
    // Save to global state and trigger sync
    const index = appState.todoData.todos.findIndex(t => t.id === todo.id);
    if (index > -1) {
        appState.todoData.todos[index] = todo;
    }
    
    render();
    renderEditCheckinGrid(todo);
    await saveData();
}

function renderMonthCalendar(container, todo, isInteractive, todayStr) {
    container.innerHTML = '';
    
    // Add weekday headers
    const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
    weekLabels.forEach(label => {
        const headerCell = document.createElement('div');
        headerCell.className = 'checkin-grid-header';
        headerCell.style.cssText = "text-align: center; font-size: 0.7rem; color: var(--text-secondary); font-weight: 600; padding-bottom: 4px; user-select: none;";
        headerCell.textContent = label;
        container.appendChild(headerCell);
    });

    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-11
    if (todo.date && isMonthDate(todo.date)) {
        const parts = todo.date.split('-');
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
    }
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const firstDay = new Date(year, month, 1);
    const startDay = firstDay.getDay(); // 0 (Sun) - 6 (Sat)
    const offset = startDay === 0 ? 6 : startDay - 1;

    const completedDates = todo.completed_dates || [];

    // Render previous month tail
    const prevMonthDays = new Date(year, month, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) {
        const d = prevMonthDays - i;
        const cell = document.createElement('div');
        cell.className = isInteractive ? 'checkin-grid-cell prev-month-cell' : 'checkin-grid-cell compact-cell prev-month-cell';
        cell.style.opacity = '0.35';
        cell.style.pointerEvents = 'none';
        cell.textContent = d;
        container.appendChild(cell);
    }

    // Render current month
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const cell = document.createElement('div');
        const matchedDate = completedDates.find(dt => dt.startsWith(dateStr));
        const isChecked = !!matchedDate;
        const isToday = dateStr === todayStr;
        
        if (isInteractive) {
            cell.className = `checkin-grid-cell${isChecked ? ' checked' : ''}${isToday ? ' today-cell' : ''}`;
            cell.addEventListener('click', (e) => {
                showCheckinDropdown(cell, todo, dateStr);
            });
        } else {
            cell.className = `checkin-grid-cell compact-cell${isChecked ? ' checked' : ''}${isToday ? ' today-cell' : ''}`;
        }
        cell.textContent = d;
        
        if (isChecked) {
            if (matchedDate.length > 10) {
                const dateObj = new Date(matchedDate);
                if (!isNaN(dateObj.getTime())) {
                    const yyyy = dateObj.getFullYear();
                    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                    const dd = String(dateObj.getDate()).padStart(2, '0');
                    const hh = String(dateObj.getHours()).padStart(2, '0');
                    const min = String(dateObj.getMinutes()).padStart(2, '0');
                    cell.title = `日期: ${yyyy}-${mm}-${dd}\n时间: ${hh}:${min}`;
                } else {
                    cell.title = `日期: ${dateStr}\n时间: --:--`;
                }
            } else {
                cell.title = `日期: ${dateStr}\n时间: --:--`;
            }
        } else {
            cell.title = dateStr;
        }
        container.appendChild(cell);
    }

    // Render next month head
    const totalCells = offset + daysInMonth;
    const remaining = (7 - (totalCells % 7)) % 7;
    for (let d = 1; d <= remaining; d++) {
        const cell = document.createElement('div');
        cell.className = isInteractive ? 'checkin-grid-cell next-month-cell' : 'checkin-grid-cell compact-cell next-month-cell';
        cell.style.opacity = '0.35';
        cell.style.pointerEvents = 'none';
        cell.textContent = d;
        container.appendChild(cell);
    }
}

function renderEditCheckinGrid(todo) {
    const groupEl = document.getElementById('edit-checkin-grid-group');
    const gridEl = document.getElementById('edit-checkin-grid');
    if (!groupEl || !gridEl) return;

    if (todo.task_type !== 'weekly_checkin' && todo.task_type !== 'monthly_checkin') {
        groupEl.style.display = 'none';
        return;
    }

    groupEl.style.display = 'block';
    gridEl.innerHTML = '';
    gridEl.className = 'checkin-grid-container';

    const todayStr = getTodayString();
    const completedDates = todo.completed_dates || [];

    if (todo.task_type === 'weekly_checkin') {
        // 周打卡：周一到周日这 7 天
        let monday;
        if (todo.date && isWeekDate(todo.date)) {
            monday = getMondayFromWeek(todo.date);
        } else {
            monday = new Date();
            const day = monday.getDay();
            const diff = monday.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
            monday.setDate(diff);
        }

        const labels = ['一', '二', '三', '四', '五', '六', '日'];
        for (let i = 0; i < 7; i++) {
            const current = new Date(monday);
            current.setDate(monday.getDate() + i);
            const dateStr = formatDate(current);

            const matchedDate = completedDates.find(d => d.startsWith(dateStr));
            const isChecked = !!matchedDate;
            const cell = document.createElement('div');
            cell.className = `checkin-grid-cell${isChecked ? ' checked' : ''}${dateStr === todayStr ? ' today-cell' : ''}`;
            cell.textContent = labels[i];
            
            if (isChecked) {
                if (matchedDate.length > 10) {
                    const dateObj = new Date(matchedDate);
                    if (!isNaN(dateObj.getTime())) {
                        const yyyy = dateObj.getFullYear();
                        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                        const dd = String(dateObj.getDate()).padStart(2, '0');
                        const hh = String(dateObj.getHours()).padStart(2, '0');
                        const min = String(dateObj.getMinutes()).padStart(2, '0');
                        cell.title = `日期: ${yyyy}-${mm}-${dd}\n时间: ${hh}:${min}`;
                    } else {
                        cell.title = `日期: ${dateStr}\n时间: --:--`;
                    }
                } else {
                    cell.title = `日期: ${dateStr}\n时间: --:--`;
                }
            } else {
                cell.title = dateStr;
            }

            cell.addEventListener('click', (e) => {
                showCheckinDropdown(cell, todo, dateStr);
            });
            gridEl.appendChild(cell);
        }
    } else if (todo.task_type === 'monthly_checkin') {
        // 月打卡：调用统一渲染方法
        renderMonthCalendar(gridEl, todo, true, todayStr);
    }
}

// ====== Edit Subtasks ======
function renderEditSubtasks() {
    const listEl = document.getElementById('edit-subtasks-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    appState.currentEditingSubtasks.forEach((sub, idx) => {
        const li = document.createElement('li');
        li.className = `subtask-item ${sub.completed ? 'completed' : ''}`;
        li.dataset.index = idx;
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
            sub.completed_at = sub.completed ? new Date().toISOString() : null;
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
            appState.currentEditingSubtasks.splice(idx, 1);
            renderEditSubtasks();
            autoSaveEdit();
        });

        listEl.appendChild(li);
    });

    if (window.Sortable) {
        if (listEl._sortableInstance) {
            listEl._sortableInstance.destroy();
            listEl._sortableInstance = null;
        }
        if (appState.currentEditingSubtasks.length > 1) {
            listEl._sortableInstance = new Sortable(listEl, {
                animation: 150,
                delay: 300,
                delayOnTouchOnly: false,
                forceFallback: true,
                fallbackClass: 'drag-fallback',
                fallbackOnBody: true,
                fallbackTolerance: 5,
                ghostClass: 'drag-over',
                chosenClass: 'drag-chosen',
                dragClass: 'drag-active',
                scroll: listEl,
                scrollSensitivity: 50,
                scrollSpeed: 12,
                filter: '.subtask-checkbox, .subtask-inline-edit, .subtask-actions, .icon-btn-small',
                preventOnFilter: false,
                onEnd: function(evt) {
                    const { oldIndex, newIndex } = evt;
                    if (oldIndex !== newIndex && oldIndex != null && newIndex != null) {
                        const moved = appState.currentEditingSubtasks.splice(oldIndex, 1)[0];
                        appState.currentEditingSubtasks.splice(newIndex, 0, moved);
                        renderEditSubtasks();
                        autoSaveEdit();
                    }
                }
            });
        }
    }
}

let _autoSaveTimer = null;

async function _doAutoSave() {
    if (!appState.currentEditingTodo) return;
    const newContent = document.getElementById('edit-content').value.trim();
    // 空内容时不更新 content 字段，但仍允许保存其他字段（date、time、subtasks 等）
    const hasContent = !!newContent;

    const index = appState.todoData.todos.findIndex(t => t.id === appState.currentEditingTodo.id);
    if (index !== -1) {
        if (hasContent) appState.todoData.todos[index].content = newContent;

        const taskTypeSelect = document.getElementById('edit-task-type');
        if (taskTypeSelect) {
            const taskTypeVal = taskTypeSelect.value;
            if (taskTypeVal === 'daily_repeat') {
                appState.todoData.todos[index].task_type = 'normal';
                appState.todoData.todos[index].recurring = 'daily_repeat';
                appState.todoData.todos[index].time = null;
                // 确保每天重复任务拥有有效的今日/现有日期
                const existingDate = appState.todoData.todos[index].date;
                if (!existingDate || isWeekDate(existingDate) || isMonthDate(existingDate)) {
                    appState.todoData.todos[index].date = getTodayString();
                }
            } else {
                appState.todoData.todos[index].task_type = taskTypeVal;
                appState.todoData.todos[index].recurring = 'none';

                if (taskTypeVal === 'normal') {
                    const hasDateSwitch = document.getElementById('edit-has-date-switch');
                    if (hasDateSwitch && hasDateSwitch.checked) {
                        let dateVal = document.getElementById('edit-date').value || null;
                        if (dateVal) {
                            dateVal = dateVal.trim();
                            const isDay = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
                            const isWeek = isWeekDate(dateVal);
                            const isMonth = isMonthDate(dateVal);
                            if (!isDay && !isWeek && !isMonth) {
                                // 格式不合规时，恢复为上一合法值或空
                                dateVal = appState.currentEditingTodo.date || null;
                                document.getElementById('edit-date').value = dateVal || '';
                            } else if (isWeek) {
                                // 强转为周打卡任务
                                appState.todoData.todos[index].task_type = 'weekly_checkin';
                                if (taskTypeSelect) taskTypeSelect.value = 'weekly_checkin';
                                updateEditModalFields('weekly_checkin');
                            } else if (isMonth) {
                                // 强转为月打卡任务
                                appState.todoData.todos[index].task_type = 'monthly_checkin';
                                if (taskTypeSelect) taskTypeSelect.value = 'monthly_checkin';
                                updateEditModalFields('monthly_checkin');
                            }
                        }
                        appState.todoData.todos[index].date = dateVal;
                    } else {
                        appState.todoData.todos[index].date = null;
                    }
                    appState.todoData.todos[index].time = null;
                } else {
                    appState.todoData.todos[index].time = null;
                    if (taskTypeVal === 'weekly_checkin') {
                        if (!isWeekDate(appState.todoData.todos[index].date)) {
                            appState.todoData.todos[index].date = getThisWeekString();
                        }
                    } else if (taskTypeVal === 'monthly_checkin') {
                        if (!isMonthDate(appState.todoData.todos[index].date)) {
                            appState.todoData.todos[index].date = getThisMonthString();
                        }
                    }
                }
            }
        }

        const targetCountInput = document.getElementById('edit-target-count');
        if (targetCountInput) {
            const val = parseInt(targetCountInput.value, 10);
            appState.todoData.todos[index].target_count = (isNaN(val) || val <= 0) ? null : val;
        }

        // 保存完成日期和时间 (仅针对普通/每天重复任务且已完成的情况)
        const completedAtRow = document.getElementById('edit-completed-at-row');
        if (completedAtRow && completedAtRow.style.display !== 'none' && appState.todoData.todos[index].completed) {
            const compDateVal = document.getElementById('edit-completed-date').value;
            const compTimeVal = document.getElementById('edit-completed-time').value;
            if (compDateVal && compTimeVal) {
                const [yyyy, mm, dd] = compDateVal.split('-').map(Number);
                const [hh, min] = compTimeVal.split(':').map(Number);
                const d = new Date(yyyy, mm - 1, dd, hh, min, 0, 0);
                appState.todoData.todos[index].completed_at = d.toISOString();
            } else if (compDateVal) {
                const [yyyy, mm, dd] = compDateVal.split('-').map(Number);
                const d = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
                appState.todoData.todos[index].completed_at = d.toISOString();
            }
        }

        appState.todoData.todos[index].subtasks = deepClone(appState.currentEditingSubtasks);
        appState.todoData.todos[index].updated_at = new Date().toISOString();

        const allCompleted = appState.todoData.todos[index].subtasks.length > 0 && appState.todoData.todos[index].subtasks.every(s => s.completed);
        if (allCompleted && !appState.todoData.todos[index].completed) {
            appState.todoData.todos[index].completed = true;
            appState.todoData.todos[index].completed_at = new Date().toISOString();
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

function updateEditModalFields(taskTypeVal) {
    const dateTimeRow = document.getElementById('edit-date-time-row');
    const targetCountGroup = document.getElementById('target-count-group');
    const checkinGridGroup = document.getElementById('edit-checkin-grid-group');
    const completedAtRow = document.getElementById('edit-completed-at-row');
    
    if (dateTimeRow) {
        dateTimeRow.style.display = (taskTypeVal === 'normal') ? 'flex' : 'none';
    }
    
    const isCheckin = taskTypeVal === 'weekly_checkin' || taskTypeVal === 'monthly_checkin';
    if (targetCountGroup) {
        targetCountGroup.style.display = isCheckin ? 'block' : 'none';
    }
    if (checkinGridGroup) {
        checkinGridGroup.style.display = isCheckin ? 'block' : 'none';
    }

    const isNormalOrDaily = taskTypeVal === 'normal' || taskTypeVal === 'daily_repeat';
    if (completedAtRow) {
        const todo = appState.currentEditingTodo;
        completedAtRow.style.display = (isNormalOrDaily && todo && todo.completed) ? 'flex' : 'none';
    }
}

function openEditModal(todo) {
    appState.currentEditingTodo = todo;

    const modal = document.getElementById('edit-modal');
    const input = document.getElementById('edit-content');
    input.value = todo.content;

    const taskTypeSelect = document.getElementById('edit-task-type');
    let taskTypeVal = todo.task_type || 'normal';
    if (todo.recurring === 'daily_repeat') {
        taskTypeVal = 'daily_repeat';
    }
    if (taskTypeSelect) {
        taskTypeSelect.value = taskTypeVal;
    }

    updateEditModalFields(taskTypeVal);

    // 日期开关及缓存初始化
    const dateInput = document.getElementById('edit-date');
    const hasDateSwitch = document.getElementById('edit-has-date-switch');
    const dateContainer = document.getElementById('edit-date-container');
    const dateVal = todo.date || '';

    dateInput.type = 'date';

    if (dateVal && !isWeekDate(dateVal) && !isMonthDate(dateVal)) {
        hasDateSwitch.checked = true;
        dateContainer.style.display = 'flex';
        dateInput.value = dateVal;
        appState.editCachedDate = dateVal;
    } else {
        hasDateSwitch.checked = false;
        dateContainer.style.display = 'none';
        dateInput.value = '';
        appState.editCachedDate = (todo.task_type === 'normal' && todo.date && !isWeekDate(todo.date) && !isMonthDate(todo.date)) ? todo.date : getTodayString();
    }

    const targetCountInput = document.getElementById('edit-target-count');
    if (targetCountInput) {
        targetCountInput.value = todo.target_count || '';
    }

    // 初始化并填充完成日期和时间
    const completedAtRow = document.getElementById('edit-completed-at-row');
    if (completedAtRow) {
        const isNormalOrDaily = taskTypeVal === 'normal' || taskTypeVal === 'daily_repeat';
        if (todo.completed && isNormalOrDaily) {
            completedAtRow.style.display = 'flex';
            const compDateInput = document.getElementById('edit-completed-date');
            const compTimeInput = document.getElementById('edit-completed-time');
            if (todo.completed_at) {
                const d = new Date(todo.completed_at);
                if (!isNaN(d.getTime())) {
                    const yyyy = d.getFullYear();
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    const dd = String(d.getDate()).padStart(2, '0');
                    compDateInput.value = `${yyyy}-${mm}-${dd}`;
                    const hh = String(d.getHours()).padStart(2, '0');
                    const min = String(d.getMinutes()).padStart(2, '0');
                    compTimeInput.value = `${hh}:${min}`;
                } else {
                    compDateInput.value = '';
                    compTimeInput.value = '';
                }
            } else {
                compDateInput.value = '';
                compTimeInput.value = '';
            }
        } else {
            completedAtRow.style.display = 'none';
        }
    }

    appState.currentEditingSubtasks = todo.subtasks ? deepClone(todo.subtasks) : [];
    renderEditSubtasks();
    renderEditCheckinGrid(todo);

    modal.classList.add('active');
    setTimeout(() => input.focus(), 80);
}

function closeEditModal() {
    if (activeCheckinDropdown) {
        activeCheckinDropdown.remove();
        activeCheckinDropdown = null;
    }
    autoSaveEditImmediate().finally(() => {
        document.getElementById('edit-modal').classList.remove('active');
        appState.currentEditingTodo = null;
        if (_pendingMidnightRefresh) {
            _pendingMidnightRefresh = false;
            render();
        }
    });
}

// ====== Render Stats ======
// ====== Render Stats ======
function renderStats(todayStr, tomorrowStr, thisWeekStr, thisMonthStr) {
    const insightsEl = document.getElementById('stats-insights');
    const healthEl = document.getElementById('stats-health');

    if (appState.statsSubTab === 'insights') {
        if (insightsEl) insightsEl.classList.remove('hidden');
        if (healthEl) healthEl.classList.add('hidden');
        renderInsights(todayStr, tomorrowStr, thisWeekStr, thisMonthStr);
    } else {
        if (healthEl) healthEl.classList.remove('hidden');
        if (insightsEl) insightsEl.classList.add('hidden');
        renderHealth(todayStr, tomorrowStr);
    }
}

function renderInsights(todayStr, tomorrowStr, thisWeekStr, thisMonthStr) {
    const statsList = document.getElementById('stats-list');
    statsList.innerHTML = '';

    const targetDayStr = formatDate(appState.statsTargetDate);
    const targetWeekStr = getISOWeekString(appState.statsTargetDate);
    const targetMonthStr = `${appState.statsTargetDate.getFullYear()}-${String(appState.statsTargetDate.getMonth() + 1).padStart(2, '0')}`;
    const labelEl = document.getElementById('stats-date-label');

    const activeTodos = appState.todoData.todos.filter(t => !t.deleted);
    let periodTodos = [];
    if (appState.statsPeriod === 'day') {
        labelEl.textContent = targetDayStr;
        periodTodos = activeTodos.filter(t => {
            if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                return (t.completed_dates || []).some(dStr => dStr.startsWith(targetDayStr));
            } else {
                if (t.completed && t.completed_at) {
                    return t.completed_at.substring(0, 10) === targetDayStr;
                } else {
                    return t.date === targetDayStr;
                }
            }
        });
    } else if (appState.statsPeriod === 'week') {
        const parts = targetWeekStr.split('-W');
        labelEl.textContent = `${parts[0]}年 第${parts[1]}周`;
        periodTodos = activeTodos.filter(t => {
            if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                const hasCheckin = (t.completed_dates || []).some(dStr => {
                    const checkDate = new Date(dStr);
                    return !isNaN(checkDate.getTime()) && getISOWeekString(checkDate) === targetWeekStr;
                });
                if (t.task_type === 'weekly_checkin' && t.date === targetWeekStr) {
                    return t.target_count !== null ? true : hasCheckin;
                }
                return hasCheckin;
            } else {
                if (t.completed && t.completed_at) {
                    const compDate = new Date(t.completed_at);
                    if (!isNaN(compDate.getTime())) {
                        return getISOWeekString(compDate) === targetWeekStr;
                    }
                    return false;
                } else {
                    if (!t.date) return false;
                    if (t.date === targetWeekStr) return true;
                    if (t.date.length === 10) {
                        const checkDate = new Date(t.date);
                        if (isNaN(checkDate.getTime())) return false;
                        return getISOWeekString(checkDate) === targetWeekStr;
                    }
                    return false;
                }
            }
        });
    } else {
        const parts = targetMonthStr.split('-');
        labelEl.textContent = `${parts[0]}年 ${parts[1]}月`;
        periodTodos = activeTodos.filter(t => {
            if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                const hasCheckin = (t.completed_dates || []).some(dStr => dStr.startsWith(targetMonthStr));
                if (t.task_type === 'monthly_checkin' && t.date === targetMonthStr) {
                    return t.target_count !== null ? true : hasCheckin;
                }
                return hasCheckin;
            } else {
                if (t.completed && t.completed_at) {
                    return t.completed_at.substring(0, 7) === targetMonthStr;
                } else {
                    if (!t.date) return false;
                    if (t.date === targetMonthStr) return true;
                    if (t.date.length === 10) return t.date.startsWith(targetMonthStr);
                    return false;
                }
            }
        });
    }

    // Apply global category filter
    periodTodos = periodTodos.filter(t => {
        const filters = appState.statsFilters;
        if (t.task_type === 'weekly_checkin') return filters.weekly;
        if (t.task_type === 'monthly_checkin') return filters.monthly;
        if (t.recurring === 'daily_repeat') return filters.daily;
        return filters.normal;
    });

    let totalCountSum = 0;
    let completedCountSum = 0;

    periodTodos.forEach(t => {
        if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
            let periodCheckinCount = 0;
            const completedDates = t.completed_dates || [];
            completedDates.forEach(dStr => {
                if (appState.statsPeriod === 'day') {
                    if (dStr.startsWith(targetDayStr)) periodCheckinCount++;
                } else if (appState.statsPeriod === 'week') {
                    const checkDate = new Date(dStr);
                    if (!isNaN(checkDate.getTime()) && getISOWeekString(checkDate) === targetWeekStr) {
                        periodCheckinCount++;
                    }
                } else {
                    if (dStr.startsWith(targetMonthStr)) periodCheckinCount++;
                }
            });

            if (t.target_count !== null) {
                completedCountSum += Math.min(t.target_count, periodCheckinCount);
                totalCountSum += t.target_count;
            } else {
                completedCountSum += periodCheckinCount;
                totalCountSum += periodCheckinCount;
            }
        } else {
            totalCountSum += 1.0;
            if (t.completed) completedCountSum += 1.0;
        }
    });

    const formatVal = val => val % 1 === 0 ? val : val.toFixed(1);
    const progress = totalCountSum === 0 ? 0 : Math.round((completedCountSum / totalCountSum) * 100);

    document.getElementById('stats-summary-text').textContent = `共 ${formatVal(totalCountSum)} 项，已完成 ${formatVal(completedCountSum)} 项，进度 ${progress}%`;
    document.getElementById('stats-progress-fill').style.width = `${progress}%`;

    // 时段分布渲染 (打卡任务包含有时间戳记录的正常打卡，排除无时分秒的补打卡)
    let morningCount = 0, afternoonCount = 0, eveningCount = 0, nightCount = 0;
    let makeupCheckins = [];

    periodTodos.forEach(t => {
        if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
            const completedDates = t.completed_dates || [];
            completedDates.forEach(dStr => {
                let inPeriod = false;
                if (appState.statsPeriod === 'day') {
                    inPeriod = dStr.startsWith(targetDayStr);
                } else if (appState.statsPeriod === 'week') {
                    const checkDate = new Date(dStr);
                    inPeriod = !isNaN(checkDate.getTime()) && getISOWeekString(checkDate) === targetWeekStr;
                } else {
                    inPeriod = dStr.startsWith(targetMonthStr);
                }

                if (inPeriod) {
                    if (dStr.length > 10) {
                        // 正常打卡计入时段分布
                        const slot = categorizeByTimeSlot(dStr);
                        if (slot === 'morning') morningCount++;
                        else if (slot === 'afternoon') afternoonCount++;
                        else if (slot === 'evening') eveningCount++;
                        else if (slot === 'night') nightCount++;
                    } else {
                        // 补打卡（长度为10，如 YYYY-MM-DD）不计入时段，计为补打卡数
                        makeupCheckins.push({ date: dStr, content: t.content, todo: t });
                    }
                }
            });
        } else {
            if (t.completed && t.completed_at) {
                const slot = categorizeByTimeSlot(t.completed_at);
                if (slot === 'morning') morningCount++;
                else if (slot === 'afternoon') afternoonCount++;
                else if (slot === 'evening') eveningCount++;
                else if (slot === 'night') nightCount++;
            }
        }
    });

    const totalSlots = morningCount + afternoonCount + eveningCount + nightCount;
    
    const morningPct = totalSlots === 0 ? 0 : Math.round((morningCount / totalSlots) * 100);
    const afternoonPct = totalSlots === 0 ? 0 : Math.round((afternoonCount / totalSlots) * 100);
    const eveningPct = totalSlots === 0 ? 0 : Math.round((eveningCount / totalSlots) * 100);
    const nightPct = totalSlots === 0 ? 0 : Math.round((nightCount / totalSlots) * 100);

    const tipEl = document.getElementById('time-distribution-tip');
    const leftCol = document.getElementById('makeup-checkins-left');
    const rightCol = document.getElementById('makeup-checkins-right');
    
    if (leftCol) leftCol.innerHTML = '';
    if (rightCol) rightCol.innerHTML = '';

    if (tipEl) {
        if (makeupCheckins.length > 0) {
            let periodText = '本日';
            if (appState.statsPeriod === 'week') periodText = '本周';
            else if (appState.statsPeriod === 'month') periodText = '本月';
            tipEl.textContent = `* ${periodText}包含 ${makeupCheckins.length} 项补打卡，已列在左右两侧，不计入时段统计`;
            tipEl.classList.remove('hidden');

            // Render makeup checkins to left and right columns
            makeupCheckins.forEach((item, index) => {
                const t = item.todo;
                
                let color = '#10B981';
                let shape = 'circle';
                if (t.recurring === 'daily_repeat') {
                    color = '#F59E0B';
                    shape = 'triangle';
                } else if (t.task_type === 'weekly_checkin') {
                    color = '#6366F1';
                    shape = 'diamond';
                } else if (t.task_type === 'monthly_checkin') {
                    color = '#F43F5E';
                    shape = 'star';
                }

                let dotSize = 8;
                let strokeWidth = 1.5;
                let opacityVal = 0.95;
                if (appState.statsPeriod === 'week') {
                    dotSize = 6;
                    strokeWidth = 1.0;
                    opacityVal = 0.8;
                } else if (appState.statsPeriod === 'month') {
                    dotSize = 4.5;
                    strokeWidth = 0.7;
                    opacityVal = 0.6;
                }

                const x = 11, y = 11; // center of 22x22 SVG
                let innerSvg = '';

                if (shape === 'circle') {
                    innerSvg = `<circle cx="${x}" cy="${y}" r="${dotSize}" fill="${color}" stroke="#ffffff" stroke-width="${strokeWidth}" opacity="${opacityVal}" />`;
                } else if (shape === 'triangle') {
                    const p1 = `${x},${y - dotSize * 1.1}`;
                    const p2 = `${x - dotSize},${y + dotSize * 0.9}`;
                    const p3 = `${x + dotSize},${y + dotSize * 0.9}`;
                    innerSvg = `<polygon points="${p1} ${p2} ${p3}" fill="${color}" stroke="#ffffff" stroke-width="${strokeWidth}" opacity="${opacityVal}" />`;
                } else if (shape === 'diamond') {
                    const p1 = `${x},${y - dotSize * 1.1}`;
                    const p2 = `${x + dotSize * 1.1},${y}`;
                    const p3 = `${x},${y + dotSize * 1.1}`;
                    const p4 = `${x - dotSize * 1.1},${y}`;
                    innerSvg = `<polygon points="${p1} ${p2} ${p3} ${p4}" fill="${color}" stroke="#ffffff" stroke-width="${strokeWidth}" opacity="${opacityVal}" />`;
                } else if (shape === 'star') {
                    const spikes = 5;
                    const outerRadius = dotSize * 1.25;
                    const innerRadius = dotSize * 0.6;
                    let rot = Math.PI / 2 * 3;
                    let px, py;
                    let step = Math.PI / spikes;
                    let points = [];
                    for (let i = 0; i < spikes; i++) {
                        px = x + Math.cos(rot) * outerRadius;
                        py = y + Math.sin(rot) * outerRadius;
                        points.push(`${px},${py}`);
                        rot += step;
                        px = x + Math.cos(rot) * innerRadius;
                        py = y + Math.sin(rot) * innerRadius;
                        points.push(`${px},${py}`);
                        rot += step;
                    }
                    innerSvg = `<polygon points="${points.join(' ')}" fill="${color}" stroke="#ffffff" stroke-width="${strokeWidth}" opacity="${opacityVal}" />`;
                }

                const dot = document.createElement('div');
                dot.style.cssText = `
                    width: 22px; height: 22px; 
                    background: transparent; 
                    display: flex; justify-content: center; align-items: center; 
                    cursor: pointer;
                `;
                dot.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">${innerSvg}</svg>`;
                
                const tooltipEl = document.getElementById('clock-tooltip');
                dot.addEventListener('mouseover', (e) => {
                    if (tooltipEl) {
                        tooltipEl.style.display = 'block';
                        tooltipEl.innerHTML = `<strong>${item.content}</strong><br/>完成日期: ${item.date}`;
                    }
                });
                
                dot.addEventListener('mousemove', (e) => {
                    if (tooltipEl) {
                        const cardRect = document.getElementById('time-distribution').getBoundingClientRect();
                        let tooltipX = e.clientX - cardRect.left + 12;
                        if (index % 2 === 1) {
                            tooltipX = e.clientX - cardRect.left - tooltipEl.offsetWidth - 12;
                        }
                        const tooltipY = e.clientY - cardRect.top + 12;
                        tooltipEl.style.left = `${tooltipX}px`;
                        tooltipEl.style.top = `${tooltipY}px`;
                    }
                });
                
                dot.addEventListener('mouseout', () => {
                    if (tooltipEl) tooltipEl.style.display = 'none';
                });
                
                dot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (tooltipEl) tooltipEl.style.display = 'none';
                    openEditModal(t);
                });
                
                if (index % 2 === 0 && leftCol) {
                    leftCol.appendChild(dot);
                } else if (rightCol) {
                    rightCol.appendChild(dot);
                }
            });
        } else {
            tipEl.textContent = '';
            tipEl.classList.add('hidden');
        }
    }

    const insightTextEl = document.getElementById('time-insight-text');
    if (totalSlots === 0) {
        insightTextEl.textContent = '☀️ 暂无已完成的任务数据';
    } else {
        let maxCount = morningCount;
        let maxSlotLabel = '上午';
        let maxPct = morningPct;

        if (afternoonCount > maxCount) {
            maxCount = afternoonCount;
            maxSlotLabel = '下午';
            maxPct = afternoonPct;
        }
        if (eveningCount > maxCount) {
            maxCount = eveningCount;
            maxSlotLabel = '晚上';
            maxPct = eveningPct;
        }
        if (nightCount > maxCount) {
            maxCount = nightCount;
            maxSlotLabel = '深夜';
            maxPct = nightPct;
        }
        
        insightTextEl.textContent = `☀️ 当前周期内你的高效时段在 ${maxSlotLabel}，占已完成任务的 ${maxPct}%`;
    }

    // ====== CUSTOM SVG CLOCK RENDERING ======
    const svgEl = document.getElementById('efficiency-clock-svg');
    if (svgEl) {
        svgEl.innerHTML = ''; // clear previous elements
        
        const cx = 170;
        const cy = 130;
        const r = 80;
        const strokeW = 10;
        
        // Render background circular track
        const bgTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        bgTrack.setAttribute('cx', cx);
        bgTrack.setAttribute('cy', cy);
        bgTrack.setAttribute('r', r);
        bgTrack.setAttribute('fill', 'none');
        bgTrack.setAttribute('stroke', 'rgba(255, 255, 255, 0.05)');
        bgTrack.setAttribute('stroke-width', strokeW);
        svgEl.appendChild(bgTrack);
        
        // Draw the 4 quadrant arcs representing our time slots
        // Quadrant 1 (Top-Right): 0-6 (Night)
        const q1Path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        q1Path.setAttribute('d', `M ${cx},${cy - r} A ${r},${r} 0 0 1 ${cx + r},${cy}`);
        q1Path.setAttribute('fill', 'none');
        q1Path.setAttribute('stroke', '#3b82f6');
        q1Path.setAttribute('stroke-width', strokeW);
        q1Path.setAttribute('opacity', totalSlots > 0 ? (nightCount > 0 ? 0.95 : 0.2) : 0.2);
        svgEl.appendChild(q1Path);
        
        // Quadrant 2 (Bottom-Right): 6-12 (Morning)
        const q2Path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        q2Path.setAttribute('d', `M ${cx + r},${cy} A ${r},${r} 0 0 1 ${cx},${cy + r}`);
        q2Path.setAttribute('fill', 'none');
        q2Path.setAttribute('stroke', '#f59e0b');
        q2Path.setAttribute('stroke-width', strokeW);
        q2Path.setAttribute('opacity', totalSlots > 0 ? (morningCount > 0 ? 0.95 : 0.2) : 0.2);
        svgEl.appendChild(q2Path);
        
        // Quadrant 3 (Bottom-Left): 12-18 (Afternoon)
        const q3Path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        q3Path.setAttribute('d', `M ${cx},${cy + r} A ${r},${r} 0 0 1 ${cx - r},${cy}`);
        q3Path.setAttribute('fill', 'none');
        q3Path.setAttribute('stroke', '#7b61ff');
        q3Path.setAttribute('stroke-width', strokeW);
        q3Path.setAttribute('opacity', totalSlots > 0 ? (afternoonCount > 0 ? 0.95 : 0.2) : 0.2);
        svgEl.appendChild(q3Path);
        
        // Quadrant 4 (Top-Left): 18-24 (Evening)
        const q4Path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        q4Path.setAttribute('d', `M ${cx - r},${cy} A ${r},${r} 0 0 1 ${cx},${cy - r}`);
        q4Path.setAttribute('fill', 'none');
        q4Path.setAttribute('stroke', '#6366f1');
        q4Path.setAttribute('stroke-width', strokeW);
        q4Path.setAttribute('opacity', totalSlots > 0 ? (eveningCount > 0 ? 0.95 : 0.2) : 0.2);
        svgEl.appendChild(q4Path);

        // Draw dotted division lines
        const lineH = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        lineH.setAttribute('x1', cx - r - 15);
        lineH.setAttribute('y1', cy);
        lineH.setAttribute('x2', cx + r + 15);
        lineH.setAttribute('y2', cy);
        lineH.setAttribute('stroke', 'rgba(255, 255, 255, 0.15)');
        lineH.setAttribute('stroke-dasharray', '2,4');
        svgEl.appendChild(lineH);

        const lineV = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        lineV.setAttribute('x1', cx);
        lineV.setAttribute('y1', cy - r - 15);
        lineV.setAttribute('x2', cx);
        lineV.setAttribute('y2', cy + r + 15);
        lineV.setAttribute('stroke', 'rgba(255, 255, 255, 0.15)');
        lineV.setAttribute('stroke-dasharray', '2,4');
        svgEl.appendChild(lineV);
        
        // Center clock icon
        const centerGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        centerGroup.setAttribute('transform', `translate(${cx - 10}, ${cy - 10})`);
        centerGroup.setAttribute('opacity', '0.25');
        centerGroup.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" width="20" height="20" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        `;
        svgEl.appendChild(centerGroup);

        // Text Labels
        const drawLabel = (textStr, x, y, anchor, color) => {
            const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            txt.setAttribute('x', x);
            txt.setAttribute('y', y);
            txt.setAttribute('text-anchor', anchor);
            txt.setAttribute('fill', color);
            txt.setAttribute('font-size', '11.5px');
            txt.setAttribute('font-weight', '600');
            txt.textContent = textStr;
            svgEl.appendChild(txt);
        };
        
        drawLabel(`深夜 (0-6): ${nightPct}%`, 325, 25, 'end', '#3b82f6');
        drawLabel(`上午 (6-12): ${morningPct}%`, 325, 245, 'end', '#f59e0b');
        drawLabel(`下午 (12-18): ${afternoonPct}%`, 15, 245, 'start', '#7b61ff');
        drawLabel(`晚上 (18-24): ${eveningPct}%`, 15, 25, 'start', '#6366f1');

        // Draw dots representing task completions
        const completionEvents = [];
        periodTodos.forEach(t => {
            if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                const completedDates = t.completed_dates || [];
                completedDates.forEach(dStr => {
                    let inPeriod = false;
                    if (appState.statsPeriod === 'day') {
                        inPeriod = dStr.startsWith(targetDayStr);
                    } else if (appState.statsPeriod === 'week') {
                        const checkDate = new Date(dStr);
                        inPeriod = !isNaN(checkDate.getTime()) && getISOWeekString(checkDate) === targetWeekStr;
                    } else {
                        inPeriod = dStr.startsWith(targetMonthStr);
                    }

                    if (inPeriod && dStr.length > 10) {
                        completionEvents.push({
                            todo: t,
                            completed_at: dStr
                        });
                    }
                });
            } else {
                if (t.completed && t.completed_at) {
                    completionEvents.push({
                        todo: t,
                        completed_at: t.completed_at
                    });
                }
            }
        });

        let dotSize = 8;
        let strokeWidth = 1.5;
        let opacityVal = 0.95;
        if (appState.statsPeriod === 'week') {
            dotSize = 6;
            strokeWidth = 1.0;
            opacityVal = 0.8;
        } else if (appState.statsPeriod === 'month') {
            dotSize = 4.5;
            strokeWidth = 0.7;
            opacityVal = 0.6;
        }

        const tooltipEl = document.getElementById('clock-tooltip');

        completionEvents.forEach((ev, index) => {
            const t = ev.todo;
            const timeStr = ev.completed_at;
            const dateObj = new Date(timeStr);
            if (isNaN(dateObj.getTime())) return;
            
            const hour = dateObj.getHours();
            const minute = dateObj.getMinutes();
            const fracHour = hour + minute / 60.0;
            const angle = fracHour * 15.0; // 360 / 24 = 15 deg per hour
            
            const hash = (t.id + index).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const jitterR = ((hash % 5) - 2) * 5.5;
            const activeR = r + jitterR;
            const jitterAngle = ((hash % 7) - 3) * 1.5;
            
            const thetaRad = (angle + jitterAngle) * Math.PI / 180;
            const x = cx + activeR * Math.sin(thetaRad);
            const y = cy - activeR * Math.cos(thetaRad);
            
            let color = '#10B981';
            let shape = 'circle';
            if (t.recurring === 'daily_repeat') {
                color = '#F59E0B';
                shape = 'triangle';
            } else if (t.task_type === 'weekly_checkin') {
                color = '#6366F1';
                shape = 'diamond';
            } else if (t.task_type === 'monthly_checkin') {
                color = '#F43F5E';
                shape = 'star';
            }

            let shapeEl;
            if (shape === 'circle') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                shapeEl.setAttribute('cx', x);
                shapeEl.setAttribute('cy', y);
                shapeEl.setAttribute('r', dotSize);
            } else if (shape === 'triangle') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const p1 = `${x},${y - dotSize * 1.1}`;
                const p2 = `${x - dotSize},${y + dotSize * 0.9}`;
                const p3 = `${x + dotSize},${y + dotSize * 0.9}`;
                shapeEl.setAttribute('points', `${p1} ${p2} ${p3}`);
            } else if (shape === 'diamond') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const p1 = `${x},${y - dotSize * 1.1}`;
                const p2 = `${x + dotSize * 1.1},${y}`;
                const p3 = `${x},${y + dotSize * 1.1}`;
                const p4 = `${x - dotSize * 1.1},${y}`;
                shapeEl.setAttribute('points', `${p1} ${p2} ${p3} ${p4}`);
            } else if (shape === 'star') {
                shapeEl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const spikes = 5;
                const outerRadius = dotSize * 1.25;
                const innerRadius = dotSize * 0.6;
                let rot = Math.PI / 2 * 3;
                let px, py;
                let step = Math.PI / spikes;
                let points = [];
                for (let i = 0; i < spikes; i++) {
                    px = x + Math.cos(rot) * outerRadius;
                    py = y + Math.sin(rot) * outerRadius;
                    points.push(`${px},${py}`);
                    rot += step;
                    px = x + Math.cos(rot) * innerRadius;
                    py = y + Math.sin(rot) * innerRadius;
                    points.push(`${px},${py}`);
                    rot += step;
                }
                shapeEl.setAttribute('points', points.join(' '));
            }
            
            shapeEl.setAttribute('fill', color);
            shapeEl.setAttribute('stroke', '#ffffff');
            shapeEl.setAttribute('stroke-width', strokeWidth);
            shapeEl.setAttribute('opacity', opacityVal);
            shapeEl.setAttribute('class', 'task-dot');
            
            const pad = (n) => String(n).padStart(2, '0');
            const displayTime = `${pad(hour)}:${pad(minute)}`;
            
            shapeEl.addEventListener('mouseover', (e) => {
                if (tooltipEl) {
                    tooltipEl.style.display = 'block';
                    tooltipEl.innerHTML = `<strong>${t.content}</strong><br/>完成日期: ${timeStr.substring(0, 10)}<br/>打卡时间: ${displayTime}`;
                }
            });
            
            shapeEl.addEventListener('mousemove', (e) => {
                if (tooltipEl) {
                    const cardRect = document.getElementById('time-distribution').getBoundingClientRect();
                    const tooltipX = e.clientX - cardRect.left + 12;
                    const tooltipY = e.clientY - cardRect.top + 12;
                    tooltipEl.style.left = `${tooltipX}px`;
                    tooltipEl.style.top = `${tooltipY}px`;
                }
            });
            
            shapeEl.addEventListener('mouseout', () => {
                if (tooltipEl) tooltipEl.style.display = 'none';
            });
            
            shapeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (tooltipEl) tooltipEl.style.display = 'none';
                openEditModal(t);
            });
            
            svgEl.appendChild(shapeEl);
        });
    }

    let displayTodos = periodTodos;
    displayTodos.sort(sortFunc);

    // List visibility and toggle text
    const toggleListBtn = document.getElementById('toggle-stats-list-btn');
    if (toggleListBtn) {
        toggleListBtn.textContent = appState.showStatsList 
            ? '收起详细任务列表' 
            : `显示详细任务列表 (共 ${displayTodos.length} 项)`;
    }

    if (appState.showStatsList) {
        statsList.classList.remove('hidden');
    } else {
        statsList.classList.add('hidden');
    }

    if (displayTodos.length === 0) {
        const emptyTip = document.createElement('div');
        emptyTip.style.cssText = 'text-align: center; color: var(--text-secondary); padding: 20px; font-size: 0.85rem; font-style: italic;';
        emptyTip.textContent = '没有符合条件的任务';
        statsList.appendChild(emptyTip);
    } else {
        displayTodos.forEach(todo => {
            let checkinDateForTodo = null;
            if (todo.task_type === 'weekly_checkin' || todo.task_type === 'monthly_checkin') {
                if (appState.statsPeriod === 'day') {
                    const match = (todo.completed_dates || []).find(d => d.startsWith(targetDayStr));
                    if (match) checkinDateForTodo = match;
                } else if (appState.statsPeriod === 'week') {
                    const matches = (todo.completed_dates || []).filter(d => {
                        const checkDate = new Date(d);
                        return !isNaN(checkDate.getTime()) && getISOWeekString(checkDate) === targetWeekStr;
                    });
                    if (matches.length > 0) {
                        matches.sort();
                        checkinDateForTodo = matches[matches.length - 1];
                    }
                } else if (appState.statsPeriod === 'month') {
                    const matches = (todo.completed_dates || []).filter(d => d.startsWith(targetMonthStr));
                    if (matches.length > 0) {
                        matches.sort();
                        checkinDateForTodo = matches[matches.length - 1];
                    }
                }
            }
            statsList.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr, checkinDateForTodo));
        });
    }
}

function renderHealth(todayStr, tomorrowStr) {
    const activeTodos = appState.todoData.todos.filter(t => !t.deleted && t.task_type !== 'weekly_checkin' && t.task_type !== 'monthly_checkin' && t.recurring !== 'daily_repeat');
    const incompleteTodos = activeTodos.filter(t => !t.completed);
    const completedTodos = activeTodos.filter(t => t.completed && t.completed_at);
    
    const now = new Date();
    
    // 1. 计算三个指标的当前值
    // 1.1 平均任务寿命 (所有任务从设置到完成的平均时间)
    let totalCompletedAge = 0;
    completedTodos.forEach(t => {
        const age = calcTaskAgeDays(t.created_at, new Date(t.completed_at));
        if (age >= 0) totalCompletedAge += age;
    });
    const avgCompletedLife = completedTodos.length === 0 ? 0 : totalCompletedAge / completedTodos.length;
    
    // 1.2 积压任务平均时长 (未完成任务从设置到当前的平均存活时间)
    let totalIncompleteAge = 0;
    incompleteTodos.forEach(t => {
        const age = calcTaskAgeDays(t.created_at, now);
        if (age >= 0) totalIncompleteAge += age;
    });
    const avgBacklogLife = incompleteTodos.length === 0 ? 0 : totalIncompleteAge / incompleteTodos.length;
    
    // 1.3 沉睡任务数
    const sleepingTodosVal = incompleteTodos.filter(t => {
        const age = calcTaskAgeDays(t.created_at, now);
        return age >= 7;
    });
    const currentSleepingCount = sleepingTodosVal.length;
    
    // 2. 计算基准值 (今天凌晨 0 点)
    const localTodayStart = new Date();
    localTodayStart.setHours(0, 0, 0, 0);
    
    let baselineCompletedSum = 0;
    let baselineCompletedCount = 0;
    let baselineIncompleteSum = 0;
    let baselineIncompleteCount = 0;
    let baselineSleepingCount = 0;
    
    activeTodos.forEach(t => {
        const createdTime = t.created_at ? new Date(t.created_at) : null;
        if (!createdTime || isNaN(createdTime.getTime()) || createdTime >= localTodayStart) {
            return; // 今天创建的任务不参与昨天的基准计算
        }
        
        const completedTime = t.completed_at ? new Date(t.completed_at) : null;
        const wasCompletedBeforeToday = t.completed && (!completedTime || isNaN(completedTime.getTime()) || completedTime < localTodayStart);
        
        if (wasCompletedBeforeToday) {
            if (completedTime && !isNaN(completedTime.getTime())) {
                const age = calcTaskAgeDays(t.created_at, completedTime);
                if (age >= 0) {
                    baselineCompletedSum += age;
                    baselineCompletedCount++;
                }
            }
        } else {
            const age = calcTaskAgeDays(t.created_at, localTodayStart);
            if (age >= 0) {
                baselineIncompleteSum += age;
                baselineIncompleteCount++;
                if (age >= 7) {
                    baselineSleepingCount++;
                }
            }
        }
    });
    
    const baselineAvgCompletedLife = baselineCompletedCount === 0 ? avgCompletedLife : baselineCompletedSum / baselineCompletedCount;
    const baselineAvgBacklogLife = baselineIncompleteCount === 0 ? avgBacklogLife : baselineIncompleteSum / baselineIncompleteCount;
    const baselineSleepingVal = baselineSleepingCount;
    
    // 3. 渲染数值到 DOM
    document.getElementById('metric-avg-age').textContent = `${avgCompletedLife.toFixed(1)} 天`;
    document.getElementById('metric-backlog-age').textContent = `${avgBacklogLife.toFixed(1)} 天`;
    document.getElementById('metric-sleeping-count').textContent = `${currentSleepingCount} 项`;
    
    // 4. 计算并更新趋势图表
    function updateMetricTrend(elementId, change, isItemCount = false) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.className = 'metric-trend';
        
        if (change < -0.01) {
            el.classList.add('good');
            el.innerHTML = `↓ ${Math.abs(change).toFixed(isItemCount ? 0 : 1)}${isItemCount ? '' : '天'}`;
        } else if (change > 0.01) {
            el.classList.add('bad');
            el.innerHTML = `↑ ${change.toFixed(isItemCount ? 0 : 1)}${isItemCount ? '' : '天'}`;
        } else {
            el.classList.add('neutral');
            el.innerHTML = '—';
        }
    }
    
    const changeCompleted = avgCompletedLife - baselineAvgCompletedLife;
    const changeBacklog = avgBacklogLife - baselineAvgBacklogLife;
    const changeSleeping = currentSleepingCount - baselineSleepingVal;
    
    updateMetricTrend('metric-avg-age-trend', changeCompleted, false);
    updateMetricTrend('metric-backlog-age-trend', changeBacklog, false);
    updateMetricTrend('metric-sleeping-count-trend', changeSleeping, true);
    
    // 5. 健康评级 (以积压任务时长为依据)
    const healthGrade = getHealthGrade(avgBacklogLife);
    const gradeLetterEl = document.getElementById('health-grade-letter');
    const gradeTextEl = document.getElementById('health-grade-text');
    gradeLetterEl.textContent = healthGrade.grade;
    gradeLetterEl.style.color = healthGrade.color;
    gradeTextEl.textContent = `“${healthGrade.text}”`;
 
    // 3. 吞吐量对比
    const thresholdMs = now.getTime() - (appState.healthThroughputDays * 86400000);
    const thresholdDate = new Date(thresholdMs);
    
    let addedCount = 0;
    let completedCount = 0;
    
    activeTodos.forEach(t => {
        if (t.created_at) {
            const createdDate = new Date(t.created_at);
            if (!isNaN(createdDate.getTime()) && createdDate >= thresholdDate) {
                addedCount++;
            }
        }
        if (t.completed && t.completed_at) {
            const completedDate = new Date(t.completed_at);
            if (!isNaN(completedDate.getTime()) && completedDate >= thresholdDate) {
                completedCount++;
            }
        }
    });

    document.getElementById('throughput-added').textContent = addedCount;
    document.getElementById('throughput-completed').textContent = completedCount;

    const totalThroughput = addedCount + completedCount;
    const addedPct = totalThroughput === 0 ? 50 : (addedCount / totalThroughput) * 100;
    const completedPct = totalThroughput === 0 ? 50 : (completedCount / totalThroughput) * 100;

    document.getElementById('throughput-bar-added').style.flex = addedPct;
    document.getElementById('throughput-bar-completed').style.flex = completedPct;

    const verdictEl = document.getElementById('throughput-verdict');
    if (completedCount > addedCount) {
        verdictEl.textContent = '清单正在变轻盈 ✨';
        verdictEl.style.display = 'block';
    } else if (completedCount === addedCount) {
        verdictEl.textContent = '收支平衡，保持节奏';
        verdictEl.style.display = 'block';
    } else {
        verdictEl.textContent = '';
        verdictEl.style.display = 'none';
    }

    // 4. 沉睡待办
    const sleepingTodos = incompleteTodos.filter(t => {
        const age = calcTaskAgeDays(t.created_at, now);
        return age >= 7; // SLEEPING_THRESHOLD_DAYS
    });
    
    sleepingTodos.sort((a, b) => {
        const ageA = calcTaskAgeDays(a.created_at, now);
        const ageB = calcTaskAgeDays(b.created_at, now);
        return ageB - ageA;
    });

    document.getElementById('metric-sleeping-count').textContent = `${sleepingTodos.length} 项`;

    const sleepingList = document.getElementById('sleeping-list');
    sleepingList.innerHTML = '';

    const emptyEl = document.getElementById('sleeping-empty');
    if (sleepingTodos.length === 0) {
        emptyEl.style.display = 'block';
    } else {
        emptyEl.style.display = 'none';
        sleepingTodos.forEach(todo => {
            const age = calcTaskAgeDays(todo.created_at, now);
            const item = document.createElement('div');
            item.className = 'sleeping-item';
            item.innerHTML = `
                <div class="sleeping-item-info">
                    <span>${escapeHtml(todo.content)}</span>
                    <span>已存活 ${age} 天</span>
                </div>
                <div class="sleeping-item-actions">
                    <button class="sleeping-action-btn btn-postpone" data-id="${todo.id}">延期</button>
                    <button class="sleeping-action-btn btn-delete" data-id="${todo.id}">删除</button>
                </div>
            `;
            sleepingList.appendChild(item);
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
function renderCollapsibleGroup(group, label, isCollapsed, type, themeColor, todayStr, tomorrowStr, groupCheckinDate = null) {
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

    // 为拖拽悬停增加交互反馈与目标捕获（用于在折叠状态下拖入并自动下拉）
    header.addEventListener('mouseenter', () => {
        if (_currentlyDraggedTodoId && (type === 'today' || type === 'weekly' || type === 'monthly')) {
            _currentlyHoveredHeaderType = type;
            header.classList.add('drag-hover-header');
        }
    });

    header.addEventListener('mouseleave', () => {
        if (_currentlyHoveredHeaderType === type) {
            _currentlyHoveredHeaderType = null;
        }
        header.classList.remove('drag-hover-header');
    });

    header.addEventListener('click', () => {
        // 折叠状态 Map 映射：type 前缀 → 对应的状态变量访问器
        const collapseMap = {
            today: () => { appState.todayCollapsed = !appState.todayCollapsed; },
            weekly: () => { appState.weekCollapsed = !appState.weekCollapsed; },
            monthly: () => { appState.monthCollapsed = !appState.monthCollapsed; },
            future: () => { appState.futureCollapsed = !appState.futureCollapsed; },
            nodate: () => { appState.noDateCollapsed = !appState.noDateCollapsed; },
            past: () => { appState.pastCollapsed = !appState.pastCollapsed; },
        };
        const baseType = type.replace('_uncompleted', '');
        if (type.startsWith('completed_')) {
            appState.completedCollapsed[type] = !appState.completedCollapsed[type];
        } else if (collapseMap[baseType]) {
            collapseMap[baseType]();
        }
        render();
    });

    const content = document.createElement('div');
    content.className = 'collapsible-content';
    content.dataset.groupType = type;

    if (!isCollapsed) {
        if (type === 'today' || type === 'today_uncompleted') {
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
            if (group.length === 0 && (type === 'weekly' || type === 'monthly')) {
                const emptyTip = document.createElement('div');
                emptyTip.style.cssText = 'text-align: center; color: var(--text-secondary); padding: 16px; font-size: 0.85rem;';
                emptyTip.innerHTML = `
                    <p style="margin-bottom: 8px;">当前周期无打卡计划</p>
                    <button class="import-period-btn" style="background: var(--accent-color); color: white; border: none; padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; transition: opacity 0.2s;">从上期导入</button>
                `;
                emptyTip.querySelector('.import-period-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    openImportModal(type);
                });
                content.appendChild(emptyTip);
            } else {
                group.forEach(todo => {
                    const itemCheckinDate = todo.checkinDate || groupCheckinDate;
                    content.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr, itemCheckinDate));
                });
            }
        }
    }

    groupLi.appendChild(header);
    groupLi.appendChild(content);
    listEl.appendChild(groupLi);
}

// ====== Render Flat Pending Group (no collapsible wrappers, just flat headers & lists) ======
function renderFlatPendingGroup(group, label, themeColor, todayStr, tomorrowStr, groupType) {
    if (!group || group.length === 0) return;

    // 创建扁平时间线分类标题（不包含“待完成”前缀）
    const headerEl = document.createElement('div');
    headerEl.className = 'pending-timeline-date';
    headerEl.style.color = themeColor;
    headerEl.innerHTML = `<span>${label}</span>`;
    listEl.appendChild(headerEl);

    // 直接平铺待完成卡片列表
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'pending-timeline-items';
    itemsContainer.dataset.groupType = groupType;
    group.forEach(todo => {
        itemsContainer.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr));
    });
    listEl.appendChild(itemsContainer);
}

// ====== Main Render Function ======
function render() {
    // 差异更新：如果 todo 数据和 UI 状态均未变化则跳过渲染
    const uiStateHash = [
        appState.dateFilter,
        appState.currentView,
        appState.allTabMode,
        appState.searchQuery,
        appState.todayCollapsed,
        appState.weekCollapsed,
        appState.monthCollapsed,
        appState.statsPeriod,
        appState.statsTargetDate.getTime(),
        appState.statsSubTab,
        appState.healthThroughputDays,
        appState.showAllHistory,
        appState.statsFilters.normal,
        appState.statsFilters.daily,
        appState.statsFilters.weekly,
        appState.statsFilters.monthly,
        appState.showStatsList
    ].join('|');
    const _hash = appState.todoData.todos.map(t => `${t.id}:${t.updated_at}:${t.completed}`).join('|') + '|' + uiStateHash;
    if (_hash === _lastRenderedHash) return;
    _lastRenderedHash = _hash;

    const todayStr = getTodayString();
    const tomorrowStr = getTomorrowString();
    const thisWeekStr = getThisWeekString();
    const thisMonthStr = getThisMonthString();

    // 根据 appState.dateFilter 过滤数据
    let filteredTodos = [...appState.todoData.todos].filter(t => !t.deleted);
    if (appState.searchQuery) {
        const queryLower = appState.searchQuery.toLowerCase();
        filteredTodos = filteredTodos.filter(t => t.content.toLowerCase().includes(queryLower));
    }

    if (appState.dateFilter === 'today') {
        filteredTodos = filteredTodos.filter(t => {
            const completedToday = t.completed && t.completed_at && t.completed_at.substring(0, 10) === todayStr;
            const wasOverdue = t.date && t.date < todayStr && !isWeekDate(t.date) && !isMonthDate(t.date);
            const isOverdueCompletedToday = completedToday && wasOverdue;

            return t.date === todayStr 
                || isOverdue(t, todayStr) 
                || t.date === thisWeekStr 
                || t.date === thisMonthStr
                || isOverdueCompletedToday;
        });
    }

    if (appState.currentView === 'stats') {
        renderStats(todayStr, tomorrowStr, thisWeekStr, thisMonthStr);
        return;
    }

    if (appState.currentView === 'list') {
        listEl.innerHTML = '';

        if (appState.dateFilter === 'today') {
            const monthGroup = filteredTodos.filter(t => t.date === thisMonthStr).sort(sortFunc);
            const weekGroup = filteredTodos.filter(t => t.date === thisWeekStr && !monthGroup.includes(t)).sort(sortFunc);
            const todayGroup = filteredTodos.filter(t => !monthGroup.includes(t) && !weekGroup.includes(t)).sort(sortFunc);

            renderCollapsibleGroup(todayGroup, '今日任务', appState.todayCollapsed, 'today', 'var(--accent-color)', todayStr, tomorrowStr);
            renderCollapsibleGroup(weekGroup, '本周任务', appState.weekCollapsed, 'weekly', '#fadb14', todayStr, tomorrowStr);
            renderCollapsibleGroup(monthGroup, '本月任务', appState.monthCollapsed, 'monthly', '#ff7a45', todayStr, tomorrowStr);
        } else {
            if (appState.allTabMode === 'uncompleted') {
                // 1. 过滤未完成任务（未达标的打卡任务 + 未完成的普通任务）
                const uncompletedTodos = filteredTodos.filter(t => !t.completed);
                const groups = groupTodosByDate(uncompletedTodos, todayStr);
                const { todayGroup, noDateGroup, weekGroup, monthGroup, futureGroup, pastGroup } = groups;
                
                // 未来任务中不要出现周任务/月任务/逾期任务/今日任务，只需要有确定了日期的、明天以后的任务
                const futureTasks = futureGroup.filter(t => t.task_type === 'normal');
                
                noDateGroup.sort(sortFunc);
                futureTasks.sort((a, b) => {
                    if (a.date !== b.date) return a.date.localeCompare(b.date);
                    return sortFunc(a, b);
                });

                renderFlatPendingGroup(noDateGroup, '无日期', '#8c8c8c', todayStr, tomorrowStr, 'no-date');
                renderFlatPendingGroup(futureTasks, '未来任务', '#1890ff', todayStr, tomorrowStr, 'future');
            } else {
                // 2. 收集已完成任务（含打卡任务拆分）
                const completedGroupsMap = {};
                
                filteredTodos.forEach(t => {
                    if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                        (t.completed_dates || []).forEach(dStr => {
                            const dateKey = dStr.substring(0, 10);
                            if (!completedGroupsMap[dateKey]) completedGroupsMap[dateKey] = [];
                            const clone = deepClone(t);
                            clone.checkinDate = dStr;
                            clone.completed = true;
                            completedGroupsMap[dateKey].push(clone);
                        });
                    } else {
                        if (t.completed) {
                            const dStr = (t.completed_at || t.updated_at || todayStr).substring(0, 10);
                            if (!completedGroupsMap[dStr]) completedGroupsMap[dStr] = [];
                            completedGroupsMap[dStr].push(t);
                        }
                    }
                });

                const sortedCompletionDates = Object.keys(completedGroupsMap).sort((a, b) => b.localeCompare(a));
                
                // 任务截断：默认只显示最近3天有记录的已完成日期，其他展开
                const showDates = appState.showAllHistory ? sortedCompletionDates : sortedCompletionDates.slice(0, DEFAULT_HISTORY_VISIBLE_DAYS);
                
                showDates.forEach(dateStr => {
                    const list = completedGroupsMap[dateStr];
                    list.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
                    
                    // 渲染扁平时间线日期标题（仅显示日期，去除“已完成”前缀）
                    const dateHeader = document.createElement('div');
                    dateHeader.className = 'completed-timeline-date';
                    dateHeader.textContent = dateStr;
                    listEl.appendChild(dateHeader);
                    
                    // 直接平铺任务卡片，无折叠边框盒子包装
                    const itemsContainer = document.createElement('div');
                    itemsContainer.className = 'completed-timeline-items';
                    list.forEach(todo => {
                        itemsContainer.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr, dateStr));
                    });
                    listEl.appendChild(itemsContainer);
                });

                // 如果多于3天，显示展开/收起历史归档按钮
                if (sortedCompletionDates.length > 3) {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'archive-toggle-wrapper';
                    const btn = document.createElement('button');
                    btn.className = 'archive-btn';
                    btn.id = 'toggle-archive-btn';
                    btn.textContent = appState.showAllHistory ? '收起历史归档' : `展开历史归档 (共 ${sortedCompletionDates.length} 天)`;
                    btn.addEventListener('click', () => {
                        appState.showAllHistory = !appState.showAllHistory;
                        render();
                    });
                    wrapper.appendChild(btn);
                    listEl.appendChild(wrapper);
                }
            }
        }
        
        // Initialize SortableJS — 仅对"今天聚焦"启用拖动排序
        if (appState.dateFilter === 'today' && window.Sortable) {
            // 销毁旧 Sortable 实例，防止内存泄漏
            document.querySelectorAll('.collapsible-content').forEach(el => {
                if (el._sortableInstance) {
                    el._sortableInstance.destroy();
                    el._sortableInstance = null;
                }
            });
            // 预构建 Sortable 配置模板，避免每次 render 重复创建大量闭包对象
            if (!window._sortableConfigTemplate) {
                window._sortableConfigTemplate = {
                    group: 'today-focus-group',
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
                    scrollSensitivity: 50,
                    scrollSpeed: 12,
                };
            }
            document.querySelectorAll('.collapsible-content').forEach(container => {
                const sortableOpts = {
                ...window._sortableConfigTemplate,
                scroll: document.getElementById('main-content'),
                onStart: function(evt) {
                    _currentlyDraggedTodoId = evt.item.dataset.id;
                },
                onEnd: async function(evt) {
                        const targetHeaderType = _currentlyHoveredHeaderType;
                        // 清理全局拖拽状态与头部悬停高亮类
                        _currentlyDraggedTodoId = null;
                        _currentlyHoveredHeaderType = null;
                        document.querySelectorAll('.collapsible-header').forEach(el => el.classList.remove('drag-hover-header'));

                        const draggedId = evt.item.dataset.id;
                        const todoMap = new Map(appState.todoData.todos.map(t => [t.id, t]));
                        const t = todoMap.get(draggedId);

                        // 1. 如果拖动到了折叠头上方松手
                        if (targetHeaderType && t) {
                            let stateChanged = false;
                            if (targetHeaderType === 'today') {
                                if (appState.todayCollapsed) {
                                    appState.todayCollapsed = false;
                                    stateChanged = true;
                                }
                                t.task_type = 'normal';
                                t.recurring = 'none';
                                t.date = todayStr;
                            } else if (targetHeaderType === 'weekly') {
                                if (appState.weekCollapsed) {
                                    appState.weekCollapsed = false;
                                    stateChanged = true;
                                }
                                t.task_type = 'weekly_checkin';
                                t.recurring = 'none';
                                t.date = thisWeekStr;
                            } else if (targetHeaderType === 'monthly') {
                                if (appState.monthCollapsed) {
                                    appState.monthCollapsed = false;
                                    stateChanged = true;
                                }
                                t.task_type = 'monthly_checkin';
                                t.recurring = 'none';
                                t.date = thisMonthStr;
                            }
                            t.order = -Date.now();
                            t.updated_at = new Date().toISOString();
                            render();
                            await saveData();
                            return;
                        }

                        // 2. 正常拖动到展开的列表容器中
                        const toType = evt.to.dataset.groupType;
                        let stateChanged = false;
                        
                        if (t) {
                            if (toType === 'today') {
                                const allNodes = Array.from(evt.to.children);
                                const separatorIndex = allNodes.findIndex(n => n.classList.contains('list-separator'));
                                const nodeIndex = allNodes.indexOf(evt.item);
                                if (separatorIndex !== -1 && nodeIndex < separatorIndex) {
                                    // 拖到上半区：今日任务
                                    t.task_type = 'normal';
                                    t.recurring = 'none';
                                    if (!isOverdue(t, todayStr)) {
                                        if (t.date !== todayStr) {
                                            t.date = todayStr;
                                            stateChanged = true;
                                        }
                                    }
                                } else {
                                    // 拖到下半区：无日期任务
                                    // 保留周/月格式日期，避免丢失周期标识
                                    if (t.date && !isWeekDate(t.date) && !isMonthDate(t.date)) {
                                        t.task_type = 'normal';
                                        t.recurring = 'none';
                                        t.date = '';
                                        stateChanged = true;
                                    } else if (isWeekDate(t.date)) {
                                        t.task_type = 'weekly_checkin';
                                        t.recurring = 'none';
                                    } else if (isMonthDate(t.date)) {
                                        t.task_type = 'monthly_checkin';
                                        t.recurring = 'none';
                                    }
                                }
                            } else if (toType === 'weekly') {
                                t.task_type = 'weekly_checkin';
                                t.recurring = 'none';
                                if (t.date !== thisWeekStr) {
                                    t.date = thisWeekStr;
                                    stateChanged = true;
                                }
                            } else if (toType === 'monthly') {
                                t.task_type = 'monthly_checkin';
                                t.recurring = 'none';
                                if (t.date !== thisMonthStr) {
                                    t.date = thisMonthStr;
                                    stateChanged = true;
                                }
                            }
                        }
                        
                        // 重新更新源容器和目标容器的 order（复用上方 todoMap，O(N²)→O(N)）
                        const updateOrderForContainer = (c) => {
                            const items = Array.from(c.querySelectorAll('.todo-item'));
                            items.forEach((el, index) => {
                                const td = todoMap.get(el.dataset.id);
                                if (td) {
                                    if (td.order !== index) {
                                        td.order = index;
                                        td.updated_at = new Date().toISOString();
                                        stateChanged = true;
                                    }
                                }
                            });
                        };
                        
                        updateOrderForContainer(evt.to);
                        if (evt.from !== evt.to) {
                            updateOrderForContainer(evt.from);
                        }
                        
                        if (stateChanged) {
                            render();
                            await saveData();
                        }
                    }
                };
                container._sortableInstance = new Sortable(container, sortableOpts);
            });
        }

        // Initialize SortableJS — 全部待办 -> 待完成分组内拖动排序
        if (appState.dateFilter === 'all' && appState.allTabMode === 'uncompleted' && window.Sortable) {
            document.querySelectorAll('.pending-timeline-items').forEach(el => {
                if (el._sortableInstance) {
                    el._sortableInstance.destroy();
                    el._sortableInstance = null;
                }
            });

            document.querySelectorAll('.pending-timeline-items').forEach(container => {
                const groupType = container.dataset.groupType;
                const sortableOpts = {
                    group: `pending-${groupType}-group`, // 隔离不同分组
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
                    scrollSensitivity: 50,
                    scrollSpeed: 12,
                    scroll: document.getElementById('main-content'),
                    onStart: function(evt) {
                        _currentlyDraggedTodoId = evt.item.dataset.id;
                    },
                    onEnd: async function(evt) {
                        _currentlyDraggedTodoId = null;
                        const todoMap = new Map(appState.todoData.todos.map(t => [t.id, t]));
                        let stateChanged = false;
                        
                        const items = Array.from(container.querySelectorAll('.todo-item'));
                        items.forEach((el, index) => {
                            const td = todoMap.get(el.dataset.id);
                            if (td) {
                                if (td.order !== index) {
                                    td.order = index;
                                    td.updated_at = new Date().toISOString();
                                    stateChanged = true;
                                }
                            }
                        });
                        
                        if (stateChanged) {
                            render();
                            await saveData();
                        }
                    }
                };
                container._sortableInstance = new Sortable(container, sortableOpts);
            });
        }
    }
}

// ====== Import Modal ======
window.openImportModal = function(type) {
    appState.currentImportType = type;
    const importListEl = document.getElementById('import-tasks-list');
    const titleEl = document.getElementById('import-modal-title');
    importListEl.innerHTML = '';
    const targetDateStr = type === 'weekly' ? getLastWeekString() : getLastMonthString();
    titleEl.textContent = type === 'weekly' ? '从上周导入' : '从上月导入';
    const currentPeriodStr = type === 'weekly' ? getThisWeekString() : getThisMonthString();
    const existingTitles = new Set(
        appState.todoData.todos
            .filter(t => !t.deleted && t.date === currentPeriodStr)
            .map(t => t.content)
    );
    appState.currentImportCandidates = appState.todoData.todos.filter(t => 
        !t.deleted &&
        (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') &&
        t.date === targetDateStr &&
        !existingTitles.has(t.content)
    );
    if (appState.currentImportCandidates.length === 0) {
        importListEl.innerHTML = '<li style="text-align:center;color:var(--text-secondary);padding:24px 10px;">上个周期没有可导入的任务</li>';
    } else {
        appState.currentImportCandidates.forEach((todo, idx) => {
            const li = document.createElement('li');
            li.className = 'subtask-item';
            li.setAttribute('data-selected', 'true');

            const box = document.createElement('div');
            box.className = 'import-checkbox';
            box.innerHTML = `
                <svg class="import-checkbox-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;

            const span = document.createElement('span');
            span.className = 'import-task-content';
            span.textContent = todo.content;

            li.appendChild(box);
            li.appendChild(span);

            li.addEventListener('click', () => {
                const isSelected = li.getAttribute('data-selected') === 'true';
                li.setAttribute('data-selected', isSelected ? 'false' : 'true');
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

    // 绑定智能输入联想
    const todoAutocompleteList = document.getElementById('todo-autocomplete-list');
    bindAutocomplete(inputEl, todoAutocompleteList);

    // 置顶按钮
    const pinBtn = document.getElementById('pin-btn');
    if (pinBtn) {
        pinBtn.addEventListener('click', async () => {
            appState.isPinned = !appState.isPinned;
            try {
                await invoke('set_always_on_top', { alwaysOnTop: appState.isPinned });
                pinBtn.classList.toggle('active', appState.isPinned);
                pinBtn.title = appState.isPinned ? "取消置顶" : "固定置顶";
            } catch (e) {
                console.error("Failed to set always on top:", e);
                appState.isPinned = !appState.isPinned;
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
            appState.appConfig = await invoke("get_app_config");
            settingSyncMode.value = appState.appConfig.sync_mode || 'local';
            settingSyncPath.value = appState.appConfig.sync_path || '';
            settingWebdavUrl.value = appState.appConfig.webdav_url || 'https://dav.jianguoyun.com/dav/';
            settingWebdavUser.value = appState.appConfig.webdav_username || '';
            settingWebdavPass.value = appState.appConfig.webdav_password || '';
            settingWebdavFilepath.value = appState.appConfig.webdav_filepath || '我的坚果云/to-do/todo_data.json';
            
            // 获取并显示当前版本号
            try {
                const currentVersion = await invoke('get_app_version');
                const versionTextEl = document.getElementById('current-version-text');
                if (versionTextEl) {
                    versionTextEl.textContent = `当前版本: v${currentVersion}`;
                }
            } catch (e) {
                console.error("Failed to fetch app version:", e);
            }

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
            appState.appConfig = newConfig;
            
            settingsModal.classList.remove('active');
            await loadData();
        });
    }
    // 版本号比较函数 (例如比较 "1.0.1" 和 "1.0.0")
    function compareVersions(v1, v2) {
        // 防御性检查：任意一个无效则视为相等
        if (v1 == null || v2 == null || typeof v1 === 'object' || typeof v2 === 'object') return 0;
        const parts1 = String(v1).trim().split('.').map(s => parseInt(s, 10) || 0);
        const parts2 = String(v2).trim().split('.').map(s => parseInt(s, 10) || 0);
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }


    // 检查更新按钮事件
    const checkUpdateBtn = document.getElementById('check-update-btn');
    if (checkUpdateBtn) {
        checkUpdateBtn.addEventListener('click', async () => {
            const oldText = checkUpdateBtn.textContent;
            checkUpdateBtn.textContent = '正在检查更新...';
            checkUpdateBtn.disabled = true;
            try {
                // 1. 获取当前程序版本号
                let currentVersion;
                try {
                    currentVersion = await invoke('get_app_version');
                } catch (e) {
                    throw new Error("获取当前应用版本失败(get_app_version): " + String(e));
                }

                // 2. 请求 GitHub API 获取最新发布版本
                let releaseJson;
                try {
                    releaseJson = await invoke('get_latest_release');
                } catch (networkErr) {
                    const errMsg = String(networkErr);
                    if (errMsg.includes("403") || errMsg.includes("429")) {
                        throw new Error('GitHub API 请求过于频繁，请稍后再试（未认证限制：60次/小时）。');
                    }
                    throw new Error('网络连接失败或拉取失败(get_latest_release): ' + errMsg);
                }

                // 3. 解析 JSON
                let release;
                try {
                    release = JSON.parse(releaseJson);
                } catch (e) {
                    throw new Error('服务器返回的数据格式异常(JSON.parse): ' + String(e));
                }

                const latestTagName = release.tag_name || '';
                const latestVersion = latestTagName.startsWith('v') ? latestTagName.substring(1) : latestTagName;

                // 4. 对比版本
                if (compareVersions(latestVersion, currentVersion) > 0) {
                    let userConfirmed = false;
                    try {
                        userConfirmed = confirm(`发现新版本 v${latestVersion}！\n\n更新日志：\n${release.body || '无'}\n\n是否立即前往下载页面下载最新安装包？`);
                    } catch (confirmErr) {
                        // 兼容 WebView2 在透明无边框模式下可能导致的 confirm 崩溃
                        showToast(`发现新版本 v${latestVersion}！即将尝试打开下载页面。`);
                        userConfirmed = true;
                    }

                    if (userConfirmed) {
                        try {
                            await invoke('plugin:opener|open_url', { url: release.html_url });
                        } catch (openErr) {
                            throw new Error(`系统浏览器拉起失败 (plugin:opener|open_url)。\n原始报错: ${String(openErr)}\n\n请手动访问此链接下载最新版: \n${release.html_url}`);
                        }
                    }
                } else {
                    showToast('当前已是最新版本！');
                }
            } catch (err) {
                console.error('检查更新失败:', err);
                showToast(`检查更新失败: ${err.message || String(err) || '未知错误'}`);
            } finally {
                checkUpdateBtn.textContent = oldText;
                checkUpdateBtn.disabled = false;
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
                                    showToast('恢复成功！');
                                    backupModal.classList.remove('active');
                                    loadData();
                                } catch (e) {
                                    showToast('恢复失败: ' + e);
                                }
                            }
                        });
                        backupList.appendChild(li);
                    });
                }
            } catch (e) {
                backupList.textContent = '获取备份失败: ' + (e.message || e);
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
            appState.currentView = 'stats';
            appState.statsTargetDate = new Date();
            appState.statsSubTab = 'insights';
            document.querySelectorAll('.stats-sub-tabs .tab-btn').forEach(btn => {
                if (btn.dataset.subtab === 'insights') btn.classList.add('active');
                else btn.classList.remove('active');
            });
            document.getElementById('todo-list').classList.add('hidden');
            if (tabsContainerEl) tabsContainerEl.classList.add('hidden');
            if (appFooterEl) appFooterEl.classList.add('hidden');
            statsContainerEl.classList.remove('hidden');
            statsBtn.classList.add('active');

            // 隐藏搜索栏和二级页签，防止在统计（回顾）界面产生冗余
            const searchBar = document.getElementById('search-bar');
            if (searchBar) searchBar.style.display = 'none';
            const allSubTabs = document.getElementById('all-sub-tabs');
            if (allSubTabs) allSubTabs.classList.add('hidden');
        } else {
            appState.currentView = 'list';
            document.getElementById('todo-list').classList.remove('hidden');
            mainContentEl.className = 'list-view';
            if (tabsContainerEl) tabsContainerEl.classList.remove('hidden');
            if (appFooterEl) appFooterEl.classList.remove('hidden');
            statsContainerEl.classList.add('hidden');
            statsBtn.classList.remove('active');

            // 返回主列表时，如果是在“全部待办”选项卡，恢复显示二级页签
            const allSubTabs = document.getElementById('all-sub-tabs');
            if (allSubTabs && appState.dateFilter === 'all') {
                allSubTabs.classList.remove('hidden');
            }
            // 如果处于搜索状态，恢复显示搜索栏
            const searchBar = document.getElementById('search-bar');
            if (searchBar && appState.searchQuery) {
                searchBar.style.display = 'block';
            }
        }
        render();
    };

    if (statsBtn) {
        statsBtn.addEventListener('click', () => {
            toggleStatsView(appState.currentView !== 'stats');
        });
    }

    // 统计二级子页签切换
    document.querySelectorAll('.stats-sub-tabs .tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            appState.statsSubTab = btn.dataset.subtab;
            document.querySelectorAll('.stats-sub-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            render();
        });
    });

    // 吞吐量对比周期选择
    const throughputSelect = document.getElementById('throughput-period-select');
    if (throughputSelect) {
        throughputSelect.addEventListener('change', (e) => {
            appState.healthThroughputDays = parseInt(e.target.value, 10);
            render();
        });
    }

    // 沉睡待办列表操作事件委托
    const sleepingListEl = document.getElementById('sleeping-list');
    if (sleepingListEl) {
        sleepingListEl.addEventListener('click', async (e) => {
            const btn = e.target;
            if (!btn.classList.contains('sleeping-action-btn')) return;
            const id = btn.getAttribute('data-id');
            const todo = appState.todoData.todos.find(t => t.id === id);
            if (!todo) return;

            if (btn.classList.contains('btn-postpone')) {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                todo.date = formatDate(tomorrow);
                todo.updated_at = new Date().toISOString();
                showToast('已延期至明天');
            } else if (btn.classList.contains('btn-delete')) {
                todo.deleted = true;
                todo.updated_at = new Date().toISOString();
                showToast('已删除任务');
            }
            render();
            await saveData();
        });
    }

    // 统计周期切换（统一事件绑定）
    document.querySelectorAll('.stats-period-tabs .tab-btn[data-period]').forEach(btn => {
        btn.addEventListener('click', () => {
            appState.statsPeriod = btn.dataset.period;
            document.querySelectorAll('.stats-period-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            render();
        });
    });

    document.getElementById('stats-prev-btn').addEventListener('click', () => {
        if (appState.statsPeriod === 'day') appState.statsTargetDate.setDate(appState.statsTargetDate.getDate() - 1);
        else if (appState.statsPeriod === 'week') appState.statsTargetDate.setDate(appState.statsTargetDate.getDate() - 7);
        else appState.statsTargetDate.setMonth(appState.statsTargetDate.getMonth() - 1);
        render();
    });

    document.getElementById('stats-next-btn').addEventListener('click', () => {
        if (appState.statsPeriod === 'day') appState.statsTargetDate.setDate(appState.statsTargetDate.getDate() + 1);
        else if (appState.statsPeriod === 'week') appState.statsTargetDate.setDate(appState.statsTargetDate.getDate() + 7);
        else appState.statsTargetDate.setMonth(appState.statsTargetDate.getMonth() + 1);
        render();
    });

    // 统计筛选下拉菜单事件绑定
    const filterToggleBtn = document.getElementById('stats-filter-toggle-btn');
    const filterDropdown = document.getElementById('stats-filter-dropdown');
    if (filterToggleBtn && filterDropdown) {
        filterToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            filterDropdown.classList.toggle('hidden');
        });
        document.addEventListener('click', (e) => {
            if (!filterDropdown.classList.contains('hidden') && !e.target.closest('#stats-filter-dropdown') && e.target !== filterToggleBtn) {
                filterDropdown.classList.add('hidden');
            }
        });
    }

    ['normal', 'daily', 'weekly', 'monthly'].forEach(key => {
        const cb = document.getElementById(`filter-${key}`);
        if (cb) {
            cb.checked = appState.statsFilters[key];
            cb.addEventListener('change', () => {
                appState.statsFilters[key] = cb.checked;
                render();
            });
        }
    });

    // 统计列表展开折叠事件绑定
    const toggleListBtn = document.getElementById('toggle-stats-list-btn');
    if (toggleListBtn) {
        toggleListBtn.addEventListener('click', () => {
            appState.showStatsList = !appState.showStatsList;
            render();
        });
    }

    // 今天/全部过滤标签
    const tabToday = document.getElementById('tab-today');
    const tabAll = document.getElementById('tab-all');
    const allSubTabs = document.getElementById('all-sub-tabs');
    const subTabUncompleted = document.getElementById('sub-tab-uncompleted');
    const subTabCompleted = document.getElementById('sub-tab-completed');
    const searchBtn = document.getElementById('search-btn');
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const clearSearchBtn = document.getElementById('clear-search-btn');

    tabToday.addEventListener('click', () => {
        appState.dateFilter = 'today';
        tabToday.classList.add('active');
        tabAll.classList.remove('active');
        if (allSubTabs) allSubTabs.classList.add('hidden');
        render();
    });

    tabAll.addEventListener('click', () => {
        appState.dateFilter = 'all';
        tabAll.classList.add('active');
        tabToday.classList.remove('active');
        if (allSubTabs) {
            allSubTabs.classList.remove('hidden');
            // 同步选中样式
            if (appState.allTabMode === 'uncompleted') {
                subTabUncompleted.classList.add('active');
                subTabCompleted.classList.remove('active');
            } else {
                subTabCompleted.classList.add('active');
                subTabUncompleted.classList.remove('active');
            }
        }
        render();
    });

    // 搜索按钮切换显隐
    if (searchBtn && searchBar) {
        searchBtn.addEventListener('click', () => {
            if (searchBar.style.display === 'none') {
                searchBar.style.display = 'block';
                if (searchInput) searchInput.focus();
            } else {
                searchBar.style.display = 'none';
                if (searchInput) searchInput.value = '';
                appState.searchQuery = '';
                if (clearSearchBtn) clearSearchBtn.style.display = 'none';
                render();
            }
        });
    }

    // 搜索输入过滤（150ms 防抖，避免每次击键触发全量 DOM 重建）
    if (searchInput) {
        const debouncedSearch = debounce(() => {
            appState.searchQuery = searchInput.value.trim();
            if (clearSearchBtn) {
                clearSearchBtn.style.display = appState.searchQuery ? 'block' : 'none';
            }
            render();
        }, 150);
        searchInput.addEventListener('input', debouncedSearch);
    }

    // 清除搜索
    if (clearSearchBtn && searchInput) {
        clearSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            appState.searchQuery = '';
            clearSearchBtn.style.display = 'none';
            render();
            searchInput.focus();
        });
    }

    // 全部待办子选项卡切换
    if (subTabUncompleted && subTabCompleted) {
        subTabUncompleted.addEventListener('click', () => {
            appState.allTabMode = 'uncompleted';
            subTabUncompleted.classList.add('active');
            subTabCompleted.classList.remove('active');
            render();
        });

        subTabCompleted.addEventListener('click', () => {
            appState.allTabMode = 'completed';
            subTabCompleted.classList.add('active');
            subTabUncompleted.classList.remove('active');
            render();
        });
    }

    // 添加子步骤
    document.getElementById('add-subtask-btn').addEventListener('click', () => {
        const input = document.getElementById('add-subtask-input');
        if (!input) return;
        const content = input.value.trim();
        if (content && appState.currentEditingTodo) {
            appState.currentEditingSubtasks.unshift({ id: crypto.randomUUID(), content, completed: false });
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
        const targetDateStr = appState.currentImportType === 'weekly' ? getThisWeekString() : getThisMonthString();
        let imported = false;
        listItems.forEach((li, idx) => {
            if (li.getAttribute('data-selected') === 'true') {
                const orig = appState.currentImportCandidates[idx];
                const newTodo = createTodo(orig.content, targetDateStr);
                newTodo.task_type = orig.task_type;
                newTodo.target_count = orig.target_count || null;
                newTodo.time = orig.time || null;
                newTodo.recurring = orig.recurring || 'none';
                newTodo.subtasks = orig.subtasks ? deepClone(orig.subtasks).map(s => {
                    s.id = crypto.randomUUID();
                    s.completed = false;
                    s.completed_at = null;
                    return s;
                }) : [];
                appState.todoData.todos.push(newTodo);
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
    ['edit-content', 'edit-date', 'edit-has-date-switch', 'edit-task-type', 'edit-target-count', 'edit-completed-date', 'edit-completed-time'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', autoSaveEdit);
            el.addEventListener('blur', autoSaveEdit);
            el.addEventListener('input', autoSaveEdit); // input 事件能在输入时实时进行 debounced 保存
        }
    });

    const taskTypeSelect = document.getElementById('edit-task-type');
    if (taskTypeSelect) {
        taskTypeSelect.addEventListener('change', () => {
            updateEditModalFields(taskTypeSelect.value);
            if (appState.currentEditingTodo) {
                // 如果是“每天重复”，底层映射为 normal + recurring = daily_repeat
                if (taskTypeSelect.value === 'daily_repeat') {
                    appState.currentEditingTodo.task_type = 'normal';
                    appState.currentEditingTodo.recurring = 'daily_repeat';
                } else {
                    appState.currentEditingTodo.task_type = taskTypeSelect.value;
                    appState.currentEditingTodo.recurring = 'none';
                    if (taskTypeSelect.value === 'normal') {
                        if (isWeekDate(appState.currentEditingTodo.date) || isMonthDate(appState.currentEditingTodo.date)) {
                            appState.currentEditingTodo.date = getTodayString();
                            const dateInput = document.getElementById('edit-date');
                            if (dateInput) {
                                dateInput.value = appState.currentEditingTodo.date;
                                dateInput.type = 'date';
                                const typeBtn = document.getElementById('edit-date-type-btn');
                                if (typeBtn) typeBtn.textContent = '文本格式';
                            }
                        }
                    }
                }
                renderEditCheckinGrid(appState.currentEditingTodo);
            }
        });
    }

    const dateInput = document.getElementById('edit-date');
    const hasDateSwitch = document.getElementById('edit-has-date-switch');
    const dateContainer = document.getElementById('edit-date-container');

    if (hasDateSwitch && dateInput && dateContainer) {
        hasDateSwitch.addEventListener('change', () => {
            if (hasDateSwitch.checked) {
                dateContainer.style.display = 'flex';
                dateInput.value = appState.editCachedDate || getTodayString();
            } else {
                dateContainer.style.display = 'none';
                dateInput.value = '';
            }
            autoSaveEdit();
        });

        dateInput.addEventListener('input', () => {
            if (dateInput.value) {
                appState.editCachedDate = dateInput.value;
            }
        });
    }

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
        if (!appState.currentEditingTodo) return;
        const confirmModal = document.getElementById('delete-confirm-modal');
        confirmModal.classList.add('active');
    });

    document.getElementById('delete-cancel-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('delete-confirm-modal').classList.remove('active');
    });

    document.getElementById('delete-confirm-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!appState.currentEditingTodo) return;
        const index = appState.todoData.todos.findIndex(t => t.id === appState.currentEditingTodo.id);
        if (index !== -1) {
            appState.todoData.todos[index].deleted = true;
            appState.todoData.todos[index].updated_at = new Date().toISOString();
            render();
            await saveData();
        }
        document.getElementById('delete-confirm-modal').classList.remove('active');
        closeEditModal();
    });

    document.getElementById('modal-tomorrow-btn').addEventListener('click', async () => {
        if (!appState.currentEditingTodo) return;
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
    document.getElementById('sort-subtasks-btn').addEventListener('click', () => {
        if (!appState.currentEditingSubtasks || appState.currentEditingSubtasks.length === 0) return;
        appState.currentEditingSubtasks.sort((a, b) => {
            if (a.completed !== b.completed) {
                return a.completed ? 1 : -1;
            }
            if (a.completed) {
                const timeA = a.completed_at || '';
                const timeB = b.completed_at || '';
                return timeB.localeCompare(timeA);
            }
            return 0;
        });
        renderEditSubtasks();
        autoSaveEdit();
    });

    document.getElementById('copy-subtasks-btn').addEventListener('click', () => {
        if (!appState.currentEditingSubtasks || appState.currentEditingSubtasks.length === 0) {
            showToast('没有子步骤可复制');
            return;
        }
        copyModal.style.display = 'flex';
        // Force reflow
        void copyModal.offsetWidth;
        copyModal.classList.add('active');
    });

    const performCopy = async (format) => {
        const copyOnlyUncompleted = document.getElementById('copy-only-uncompleted-switch').checked;
        let textToCopy = '';
        let indexForNumberedList = 1;
        appState.currentEditingSubtasks.forEach((sub, i) => {
            if (copyOnlyUncompleted && sub.completed) {
                return;
            }
            if (format === '2') {
                textToCopy += '- ' + sub.content + '\n';
            } else if (format === '3') {
                textToCopy += indexForNumberedList + '. ' + sub.content + '\n';
                indexForNumberedList++;
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


// ====== 创建并添加待办的统一逻辑 ======
async function createAndAddTodo(raw) {
    const { content, taskDate, taskType, targetCount } = parseInputSyntax(raw);
    if (!content) return false;

    const finalDate = taskDate || null;
    let minOrder = Date.now();
    appState.todoData.todos.forEach(t => {
        if (!t.deleted && !t.completed && typeof t.order === 'number' && t.order < minOrder) {
            minOrder = t.order;
        }
    });
    const todo = createTodo(content, finalDate);
    todo.order = minOrder - 1;
    applyTaskType(todo, taskType, targetCount);

    appState.todoData.todos.push(todo);
    render();
    await saveData();
    return true;
}
    // 添加新待办表单
    formEl.addEventListener("submit", async (e) => {
        e.preventDefault();
        const raw = inputEl.value;
        const ok = await createAndAddTodo(raw);
        if (ok) inputEl.value = '';
    });

    // Watch file changes
    listen("todo_data_changed", () => {
        if (appState.saveVersion > 0) {
            appState.saveVersion--; // 消耗掉自身写入产生的文件变更事件
            return;
        }
        if (appState.appConfig.sync_mode === 'webdav') return; // WebDAV 模式下避免死循环
        loadData();
    });

    // 闪电录入逻辑
    const quickAddModal = document.getElementById('quick-add-modal');
    const quickAddInput = document.getElementById('quick-add-input');
    const quickAddAutocompleteList = document.getElementById('quick-add-autocomplete-list');
    bindAutocomplete(quickAddInput, quickAddAutocompleteList);
    
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
            const raw = quickAddInput.value.trim();
            const ok = await createAndAddTodo(raw);
            if (ok) quickAddModal.classList.remove('active');
        }
    });

    quickAddModal.addEventListener('mousedown', (e) => {
        if (e.target === quickAddModal) {
            quickAddModal.classList.remove('active');
        }
    });

    // 初始加载
    loadData();

    // 启动 24 点自动刷新
    scheduleMidnightRefresh();

    // 窗口聚焦时主动检测跨天
    let lastRenderDate = getTodayString();
    window.addEventListener('focus', () => {
        const today = getTodayString();
        if (today !== lastRenderDate) {
            lastRenderDate = today;
            if (!_pendingMidnightRefresh) {
                render();
            }
        }
    });

    // 全局拖动支持
    document.addEventListener('mousedown', (e) => {
        const isInteractive = e.target.closest('button, input, select, .checkbox, .edit-btn, .tab-btn, .todo-item, .collapsible-header, .reminder-bar, .reminder-btn, .clear-search-btn');
        const modalActive = document.getElementById('edit-modal').classList.contains('active');
        const isScrollbar = e.offsetX > e.target.clientWidth || e.offsetY > e.target.clientHeight;

        if (!isInteractive && !modalActive && !isScrollbar) {
            invoke('start_drag').catch(err => console.error('Failed to drag:', err));
        }
    });
});

function scheduleMidnightRefresh() {
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
        const editModal = document.getElementById('edit-modal');
        const isEditing = editModal && (editModal.classList.contains('active') 
            || document.activeElement === document.getElementById('todo-input'));

        if (isEditing) {
            _pendingMidnightRefresh = true;
        } else {
            render();
        }
        scheduleMidnightRefresh();
    }, msUntilMidnight + 100);
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
