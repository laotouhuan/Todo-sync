import {
    formatDate, getISOWeekString,
    getTodayString, getTomorrowString, getThisWeekString, getLastWeekString,
    getThisMonthString, getLastMonthString,
    isWeekDate, isMonthDate, isOverdue, getDateLabel, getCompletionStatusLabel,
    sortFunc, parseInputSyntax, createTodo, groupTodosByDate
} from './dateUtils.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
let searchQuery = '';
let allTabMode = 'uncompleted'; // 'uncompleted' | 'completed'
let showAllHistory = false;
let currentEditingSubtasks = [];
let currentImportType = null;
let currentImportCandidates = [];
let expandedTaskIds = new Set();
let completedCollapsed = {};
let futureCollapsed = true;
let noDateCollapsed = true;
let pastCollapsed = true;

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
                merged = JSON.parse(JSON.stringify(cTodo));
                changed = true;
            } else {
                merged = JSON.parse(JSON.stringify(lTodo));
            }
            // completed_dates 合并取并集去重
            const mergedDates = [...new Set([
                ...(lTodo.completed_dates || []),
                ...(cTodo.completed_dates || [])
            ])].sort();
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
                // migrateAndNormalize 已在 mergeTodoData 内部对所有 todo 调用，无需重复
                render();

                if (changed || JSON.stringify(mergedData.todos) !== JSON.stringify(localData.todos)) {
                    await saveData();
                    showToast('检测到云端更新，已自动同步完成');
                }
            } catch (e) {
                console.error("WebDAV pull failed, using local cache:", e);
                if (localData && localData.todos) {
                    todoData = localData;
                    todoData.todos.forEach(migrateAndNormalize);
                    render();
                }
                setSyncStatus(SyncState.ERROR);
            }
        } else {
            if (localData && localData.todos) {
                todoData = localData;
                todoData.todos.forEach(migrateAndNormalize);
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

// ====== 方案二：定期物理清理过期（已删除超 7 天）的任务 ======
function purgeOldDeletedTodos() {
    if (!todoData || !todoData.todos) return;
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - PURGE_DELETED_AFTER_DAYS);
    
    const originalCount = todoData.todos.length;
    todoData.todos = todoData.todos.filter(t => {
        if (t.deleted) {
            const updateTime = t.updated_at ? new Date(t.updated_at) : new Date(t.created_at);
            if (isNaN(updateTime.getTime()) || updateTime < sevenDaysAgo) {
                // 已经删除超过 7 天，执行物理抹除
                return false;
            }
        }
        return true;
    });
    
    const purgedCount = originalCount - todoData.todos.length;
    if (purgedCount > 0) {
        console.log(`[Purge] 自动物理清理了 ${purgedCount} 个已删除超过 7 天的旧任务记录。`);
    }
}

async function saveData() {
    // Promise 锁：防止多个 saveData 并发执行
    if (_savingPromise) await _savingPromise;
    _savingPromise = _doSaveData();
    try { await _savingPromise; } finally { _savingPromise = null; }
}

async function _doSaveData() {
    try {
        setSyncStatus(SyncState.SYNCING);
        // 执行物理清理，将删除超 7 天的旧任务彻底抹除，维持 JSON 大小
        purgeOldDeletedTodos();
        
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

        // 已完成和未完成任务都显示截止日期，确保已完成历史中保留原始截止信息
        html += `<span class="meta-item date ${dateClass}">📅 ${escapeHtml(dateLabel)}</span>`;
    }
    if (todo.time) {
        html += `<span class="meta-item time">🕐 ${escapeHtml(todo.time)}</span>`;
    }
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
        && todo.completed_dates && todo.completed_dates.includes(todayStr);
    const isVisualCompleted = checkinDate !== null ? true : (todo.completed || isCheckinCompletedToday);
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
            cell.className = `checkin-grid-cell compact-cell${completedDates.includes(dateStr) ? ' checked' : ''}${dateStr === todayStr ? ' today-cell' : ''}`;
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
        monthCalendarGrid.style.display = expandedTaskIds.has(todo.id) ? 'grid' : 'none';
        monthCalendarGrid.style.marginTop = '6px';

        renderMonthCalendar(monthCalendarGrid, todo, false, todayStr);

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
            const index = todoData.todos.findIndex(t => t.id === todo.id);
            if (index !== -1) {
                const t = todoData.todos[index];
                const dateIdx = t.completed_dates.indexOf(checkinDate);
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
        const index = todoData.todos.findIndex(t => t.id === todo.id);
        if (index !== -1) {
            const t = todoData.todos[index];

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
                if (t.completed_dates.includes(todayISO)) {
                    showToast('今天已打卡！如需消卡，请点击文本进入编辑弹窗。');
                    return;
                }

                // 3. 执行打卡
                t.completed_dates.push(todayISO);
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
                const existsClone = todoData.todos.some(
                    x => x.content === t.content && x.date === tomorrowStr 
                         && x.recurring === 'daily_repeat' && !x.deleted
                );
                if (!existsClone) {
                    const clone = createTodo(t.content, tomorrowStr);
                    clone.recurring = 'daily_repeat';
                    clone.order = -Date.now(); // 负数确保排在最前面
                    clone.subtasks = t.subtasks
                        ? JSON.parse(JSON.stringify(t.subtasks)).map(s => {
                            s.id = crypto.randomUUID();
                            s.completed = false;
                            s.completed_at = null;
                            return s;
                        })
                        : [];
                    todoData.todos.push(clone);
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
            if (expandedTaskIds.has(todo.id)) {
                expandedTaskIds.delete(todo.id);
                subtasksList.style.display = 'none';
                if (monthGrid) monthGrid.style.display = 'none';
            } else {
                expandedTaskIds.add(todo.id);
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

    if (dateFilter === 'today') {
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
        const isChecked = completedDates.includes(dateStr);
        const isToday = dateStr === todayStr;
        
        if (isInteractive) {
            cell.className = `checkin-grid-cell${isChecked ? ' checked' : ''}${isToday ? ' today-cell' : ''}`;
            cell.addEventListener('click', () => {
                toggleCheckinDate(todo, dateStr);
            });
        } else {
            cell.className = `checkin-grid-cell compact-cell${isChecked ? ' checked' : ''}${isToday ? ' today-cell' : ''}`;
        }
        cell.textContent = d;
        cell.title = dateStr;
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

// ====== Edit Checkin Grid ======
function toggleCheckinDate(todo, dateStr) {
    const index = todo.completed_dates.indexOf(dateStr);
    if (index > -1) {
        // 消卡
        todo.completed_dates.splice(index, 1);
    } else {
        // 补卡
        todo.completed_dates.push(dateStr);
    }
    todo.completed_dates.sort();

    // 根据目标次数重新判定是否完成
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
    
    renderEditCheckinGrid(todo);
    render();
    saveData();
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

            const cell = document.createElement('div');
            cell.className = `checkin-grid-cell${completedDates.includes(dateStr) ? ' checked' : ''}${dateStr === todayStr ? ' today-cell' : ''}`;
            cell.textContent = labels[i];
            cell.title = dateStr;
            cell.addEventListener('click', () => {
                toggleCheckinDate(todo, dateStr);
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

        const taskTypeSelect = document.getElementById('edit-task-type');
        if (taskTypeSelect) {
            const taskTypeVal = taskTypeSelect.value;
            if (taskTypeVal === 'daily_repeat') {
                todoData.todos[index].task_type = 'normal';
                todoData.todos[index].recurring = 'daily_repeat';
                todoData.todos[index].time = null;
                // 确保每天重复任务拥有有效的今日/现有日期
                const existingDate = todoData.todos[index].date;
                if (!existingDate || isWeekDate(existingDate) || isMonthDate(existingDate)) {
                    todoData.todos[index].date = getTodayString();
                }
            } else {
                todoData.todos[index].task_type = taskTypeVal;
                todoData.todos[index].recurring = 'none';

                if (taskTypeVal === 'normal') {
                    let dateVal = document.getElementById('edit-date').value || null;
                    if (dateVal) {
                        dateVal = dateVal.trim();
                        const isDay = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
                        const isWeek = isWeekDate(dateVal);
                        const isMonth = isMonthDate(dateVal);
                        if (!isDay && !isWeek && !isMonth) {
                            // 格式不合规时，恢复为上一合法值或空
                            dateVal = currentEditingTodo.date || null;
                            document.getElementById('edit-date').value = dateVal || '';
                        } else if (isWeek) {
                            // 强转为周打卡任务
                            todoData.todos[index].task_type = 'weekly_checkin';
                            if (taskTypeSelect) taskTypeSelect.value = 'weekly_checkin';
                            updateEditModalFields('weekly_checkin');
                        } else if (isMonth) {
                            // 强转为月打卡任务
                            todoData.todos[index].task_type = 'monthly_checkin';
                            if (taskTypeSelect) taskTypeSelect.value = 'monthly_checkin';
                            updateEditModalFields('monthly_checkin');
                        }
                    }
                    todoData.todos[index].date = dateVal;
                    todoData.todos[index].time = document.getElementById('edit-time').value || null;
                } else {
                    todoData.todos[index].time = null;
                    if (taskTypeVal === 'weekly_checkin') {
                        if (!isWeekDate(todoData.todos[index].date)) {
                            todoData.todos[index].date = getThisWeekString();
                        }
                    } else if (taskTypeVal === 'monthly_checkin') {
                        if (!isMonthDate(todoData.todos[index].date)) {
                            todoData.todos[index].date = getThisMonthString();
                        }
                    }
                }
            }
        }

        const targetCountInput = document.getElementById('edit-target-count');
        if (targetCountInput) {
            const val = parseInt(targetCountInput.value, 10);
            todoData.todos[index].target_count = (isNaN(val) || val <= 0) ? null : val;
        }
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

function updateEditModalFields(taskTypeVal) {
    const dateTimeRow = document.getElementById('edit-date-time-row');
    const targetCountGroup = document.getElementById('target-count-group');
    const checkinGridGroup = document.getElementById('edit-checkin-grid-group');
    
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
}

function openEditModal(todo) {
    currentEditingTodo = todo;

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

    document.getElementById('edit-time').value = todo.time || '';

    // 日期格式自动检测并切换模式
    const dateInput = document.getElementById('edit-date');
    const typeBtn = document.getElementById('edit-date-type-btn');
    const dateVal = todo.date || '';

    if (isWeekDate(dateVal) || isMonthDate(dateVal)) {
        dateInput.type = 'text';
        if (typeBtn) typeBtn.textContent = '日历格式';
        dateInput.placeholder = 'YYYY-MM-DD, YYYY-Wxx, YYYY-MM';
    } else {
        dateInput.type = 'date';
        if (typeBtn) typeBtn.textContent = '文本格式';
    }
    dateInput.value = dateVal;

    const targetCountInput = document.getElementById('edit-target-count');
    if (targetCountInput) {
        targetCountInput.value = todo.target_count || '';
    }

    currentEditingSubtasks = todo.subtasks ? JSON.parse(JSON.stringify(todo.subtasks)) : [];
    renderEditSubtasks();
    renderEditCheckinGrid(todo);

    modal.classList.add('active');
    setTimeout(() => input.focus(), 80);
}

function closeEditModal() {
    autoSaveEditImmediate().finally(() => {
        document.getElementById('edit-modal').classList.remove('active');
        currentEditingTodo = null;
        if (window._pendingMidnightRefresh) {
            window._pendingMidnightRefresh = false;
            render();
        }
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

    const activeTodos = todoData.todos.filter(t => !t.deleted);
    let periodTodos = [];
    if (statsPeriod === 'day') {
        labelEl.textContent = targetDayStr;
        periodTodos = activeTodos.filter(t => {
            if (t.date === targetDayStr) return true;
            if (!t.date && t.completed && t.completed_at) {
                return t.completed_at.substring(0, 10) === targetDayStr;
            }
            return false;
        });
    } else if (statsPeriod === 'week') {
        const parts = targetWeekStr.split('-W');
        labelEl.textContent = `${parts[0]}年 第${parts[1]}周`;
        periodTodos = activeTodos.filter(t => {
            if (!t.date) {
                if (t.completed && t.completed_at) {
                    const compDate = new Date(t.completed_at);
                    if (!isNaN(compDate.getTime())) {
                        return getISOWeekString(compDate) === targetWeekStr;
                    }
                }
                return false;
            }
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
        periodTodos = activeTodos.filter(t => {
            if (!t.date) {
                if (t.completed && t.completed_at) {
                    return t.completed_at.substring(0, 7) === targetMonthStr;
                }
                return false;
            }
            if (t.date === targetMonthStr) return true;
            if (t.date.length === 10) return t.date.startsWith(targetMonthStr);
            return false;
        });
    }

    let totalCountSum = 0;
    let completedCountSum = 0;
    let overdueCount = 0;

    periodTodos.forEach(t => {
        totalCountSum += 1.0;
        
        if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
            let periodCheckinCount = 0;
            const completedDates = t.completed_dates || [];
            completedDates.forEach(dStr => {
                if (statsPeriod === 'day') {
                    if (dStr === targetDayStr) periodCheckinCount++;
                } else if (statsPeriod === 'week') {
                    const checkDate = new Date(dStr);
                    if (!isNaN(checkDate.getTime()) && getISOWeekString(checkDate) === targetWeekStr) {
                        periodCheckinCount++;
                    }
                } else {
                    if (dStr.startsWith(targetMonthStr)) periodCheckinCount++;
                }
            });

            if (t.target_count) {
                completedCountSum += Math.min(1.0, periodCheckinCount / t.target_count);
            } else {
                completedCountSum += (periodCheckinCount >= 1 ? 1.0 : 0.0);
            }
        } else {
            if (t.completed) completedCountSum += 1.0;
            if (isOverdue(t, todayStr)) overdueCount++;
        }
    });

    const formatVal = val => val % 1 === 0 ? val : val.toFixed(1);
    const progress = totalCountSum === 0 ? 0 : Math.round((completedCountSum / totalCountSum) * 100);

    document.getElementById('stats-summary-text').textContent = `共 ${formatVal(totalCountSum)} 项，已完成 ${formatVal(completedCountSum)} 项，其中逾期 ${overdueCount} 项`;
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
        if (window.currentlyDraggedTodoId && (type === 'today' || type === 'weekly' || type === 'monthly')) {
            window.currentlyHoveredHeaderType = type;
            header.classList.add('drag-hover-header');
        }
    });

    header.addEventListener('mouseleave', () => {
        if (window.currentlyHoveredHeaderType === type) {
            window.currentlyHoveredHeaderType = null;
        }
        header.classList.remove('drag-hover-header');
    });

    header.addEventListener('click', () => {
        // 折叠状态 Map 映射：type 前缀 → 对应的状态变量访问器
        const collapseMap = {
            today: () => { todayCollapsed = !todayCollapsed; },
            weekly: () => { weekCollapsed = !weekCollapsed; },
            monthly: () => { monthCollapsed = !monthCollapsed; },
            future: () => { futureCollapsed = !futureCollapsed; },
            nodate: () => { noDateCollapsed = !noDateCollapsed; },
            past: () => { pastCollapsed = !pastCollapsed; },
        };
        const baseType = type.replace('_uncompleted', '');
        if (type.startsWith('completed_')) {
            completedCollapsed[type] = !completedCollapsed[type];
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
function renderFlatPendingGroup(group, label, themeColor, todayStr, tomorrowStr) {
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
    group.forEach(todo => {
        itemsContainer.appendChild(createTodoItemElement(todo, todayStr, tomorrowStr));
    });
    listEl.appendChild(itemsContainer);
}

// ====== Main Render Function ======
function render() {
    const todayStr = getTodayString();
    const tomorrowStr = getTomorrowString();
    const thisWeekStr = getThisWeekString();
    const thisMonthStr = getThisMonthString();

    // 根据 dateFilter 过滤数据
    let filteredTodos = [...todoData.todos].filter(t => !t.deleted);
    if (searchQuery) {
        const queryLower = searchQuery.toLowerCase();
        filteredTodos = filteredTodos.filter(t => t.content.toLowerCase().includes(queryLower));
    }

    if (dateFilter === 'today') {
        filteredTodos = filteredTodos.filter(t => {
            const completedToday = t.completed && t.completed_at && t.completed_at.substring(0, 10) === todayStr;
            const wasOverdue = t.date && t.date < todayStr && !isWeekDate(t.date) && !isMonthDate(t.date);
            const isOverdueCompletedToday = completedToday && wasOverdue;

            return t.date === todayStr 
                || isOverdue(t, todayStr) 
                || !t.date 
                || t.date === thisWeekStr 
                || t.date === thisMonthStr
                || isOverdueCompletedToday;
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
            const weekGroup = filteredTodos.filter(t => t.date === thisWeekStr && !monthGroup.includes(t)).sort(sortFunc);
            const todayGroup = filteredTodos.filter(t => !monthGroup.includes(t) && !weekGroup.includes(t)).sort(sortFunc);

            renderCollapsibleGroup(todayGroup, '今日任务', todayCollapsed, 'today', 'var(--accent-color)', todayStr, tomorrowStr);
            renderCollapsibleGroup(weekGroup, '本周任务', weekCollapsed, 'weekly', '#fadb14', todayStr, tomorrowStr);
            renderCollapsibleGroup(monthGroup, '本月任务', monthCollapsed, 'monthly', '#ff7a45', todayStr, tomorrowStr);
        } else {
            if (allTabMode === 'uncompleted') {
                // 1. 过滤未完成任务（未达标的打卡任务 + 未完成的普通任务）
                const uncompletedTodos = filteredTodos.filter(t => !t.completed);
                const groups = groupTodosByDate(uncompletedTodos, todayStr);
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

                renderFlatPendingGroup(todayGroup, '今日/逾期', 'var(--accent-color)', todayStr, tomorrowStr);
                renderFlatPendingGroup(weekGroup, '本周', '#fadb14', todayStr, tomorrowStr);
                renderFlatPendingGroup(monthGroup, '本月', '#ff7a45', todayStr, tomorrowStr);
                renderFlatPendingGroup(futureGroup, '以后', '#1890ff', todayStr, tomorrowStr);
                renderFlatPendingGroup(noDateGroup, '无日期', '#8c8c8c', todayStr, tomorrowStr);
                renderFlatPendingGroup(pastGroup, '已过期', '#ff4d4f', todayStr, tomorrowStr);
            } else {
                // 2. 收集已完成任务（含打卡任务拆分）
                const completedGroupsMap = {};
                
                filteredTodos.forEach(t => {
                    if (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') {
                        (t.completed_dates || []).forEach(dStr => {
                            if (!completedGroupsMap[dStr]) completedGroupsMap[dStr] = [];
                            const clone = JSON.parse(JSON.stringify(t));
                            clone.checkinDate = dStr;
                            clone.completed = true;
                            completedGroupsMap[dStr].push(clone);
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
                const showDates = showAllHistory ? sortedCompletionDates : sortedCompletionDates.slice(0, DEFAULT_HISTORY_VISIBLE_DAYS);
                
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
                    btn.textContent = showAllHistory ? '收起历史归档' : `展开历史归档 (共 ${sortedCompletionDates.length} 天)`;
                    btn.addEventListener('click', () => {
                        showAllHistory = !showAllHistory;
                        render();
                    });
                    wrapper.appendChild(btn);
                    listEl.appendChild(wrapper);
                }
            }
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
                    window.currentlyDraggedTodoId = evt.item.dataset.id;
                },
                onEnd: async function(evt) {
                        const targetHeaderType = window.currentlyHoveredHeaderType;
                        // 清理全局拖拽状态与头部悬停高亮类
                        window.currentlyDraggedTodoId = null;
                        window.currentlyHoveredHeaderType = null;
                        document.querySelectorAll('.collapsible-header').forEach(el => el.classList.remove('drag-hover-header'));

                        const draggedId = evt.item.dataset.id;
                        const todoMap = new Map(todoData.todos.map(t => [t.id, t]));
                        const t = todoMap.get(draggedId);

                        // 1. 如果拖动到了折叠头上方松手
                        if (targetHeaderType && t) {
                            let stateChanged = false;
                            if (targetHeaderType === 'today') {
                                if (todayCollapsed) {
                                    todayCollapsed = false;
                                    stateChanged = true;
                                }
                                t.task_type = 'normal';
                                t.recurring = 'none';
                                t.date = todayStr;
                            } else if (targetHeaderType === 'weekly') {
                                if (weekCollapsed) {
                                    weekCollapsed = false;
                                    stateChanged = true;
                                }
                                t.task_type = 'weekly_checkin';
                                t.recurring = 'none';
                                t.date = thisWeekStr;
                            } else if (targetHeaderType === 'monthly') {
                                if (monthCollapsed) {
                                    monthCollapsed = false;
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
                                    if (t.date !== todayStr) {
                                        t.date = todayStr;
                                        stateChanged = true;
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
    const currentPeriodStr = type === 'weekly' ? getThisWeekString() : getThisMonthString();
    const existingTitles = new Set(
        todoData.todos
            .filter(t => !t.deleted && t.date === currentPeriodStr)
            .map(t => t.content)
    );
    currentImportCandidates = todoData.todos.filter(t => 
        !t.deleted &&
        (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') &&
        t.date === targetDateStr &&
        !existingTitles.has(t.content)
    );
    if (currentImportCandidates.length === 0) {
        importListEl.innerHTML = '<li style="text-align:center;color:var(--text-secondary);padding:24px 10px;">上个周期没有可导入的任务</li>';
    } else {
        currentImportCandidates.forEach((todo, idx) => {
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
                const currentVersion = await invoke('get_app_version');

                // 2. 请求 GitHub API 获取最新发布版本
                let releaseJson;
                try {
                    releaseJson = await invoke('get_latest_release');
                } catch (networkErr) {
                    const errMsg = String(networkErr);
                    if (errMsg.includes("403") || errMsg.includes("429")) {
                        throw new Error('GitHub API 请求过于频繁，请稍后再试（未认证限制：60次/小时）。');
                    }
                    throw new Error('网络连接失败，请确认是否可以访问 GitHub。');
                }

                // 3. 解析 JSON
                let release;
                try {
                    release = JSON.parse(releaseJson);
                } catch {
                    throw new Error('服务器返回的数据格式异常，请稍后重试。');
                }

                const latestTagName = release.tag_name || '';
                const latestVersion = latestTagName.startsWith('v') ? latestTagName.substring(1) : latestTagName;

                // 4. 对比版本
                if (compareVersions(latestVersion, currentVersion) > 0) {
                    const userConfirmed = confirm(`发现新版本 v${latestVersion}！\n\n更新日志：\n${release.body || '无'}\n\n是否立即前往下载页面下载最新安装包？`);
                    if (userConfirmed) {
                        // 使用 Tauri 官方的 opener 插件在浏览器中打开链接
                        await invoke('plugin:opener|open', { path: release.html_url });
                    }
                } else {
                    alert('当前已是最新版本！');
                }
            } catch (err) {
                console.error('检查更新失败:', err);
                alert(`检查更新失败。\n\n${err.message || '未知错误，请稍后重试。'}`);
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
            currentView = 'stats';
            statsTargetDate = new Date();
            mainContentEl.classList.add('hidden');
            if (tabsContainerEl) tabsContainerEl.classList.add('hidden');
            if (appFooterEl) appFooterEl.classList.add('hidden');
            statsContainerEl.classList.remove('hidden');
            statsBtn.classList.add('active');

            // 隐藏搜索栏和二级页签，防止在统计（回顾）界面产生冗余
            const searchBar = document.getElementById('search-bar');
            if (searchBar) searchBar.style.display = 'none';
            const allSubTabs = document.getElementById('all-sub-tabs');
            if (allSubTabs) allSubTabs.style.display = 'none';
        } else {
            currentView = 'list';
            mainContentEl.classList.remove('hidden');
            mainContentEl.className = 'list-view';
            if (tabsContainerEl) tabsContainerEl.classList.remove('hidden');
            if (appFooterEl) appFooterEl.classList.remove('hidden');
            statsContainerEl.classList.add('hidden');
            statsBtn.classList.remove('active');

            // 返回主列表时，如果是在“全部待办”选项卡，恢复显示二级页签
            const allSubTabs = document.getElementById('all-sub-tabs');
            if (allSubTabs && dateFilter === 'all') {
                allSubTabs.style.display = 'flex';
            }
            // 如果处于搜索状态，恢复显示搜索栏
            const searchBar = document.getElementById('search-bar');
            if (searchBar && searchQuery) {
                searchBar.style.display = 'block';
            }
        }
        render();
    };

    if (statsBtn) {
        statsBtn.addEventListener('click', () => {
            toggleStatsView(currentView !== 'stats');
        });
    }

    // 统计周期切换（统一事件绑定）
    document.querySelectorAll('.stats-period-tabs .tab-btn[data-period]').forEach(btn => {
        btn.addEventListener('click', () => {
            statsPeriod = btn.dataset.period;
            document.querySelectorAll('.stats-period-tabs .tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            render();
        });
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
    const allSubTabs = document.getElementById('all-sub-tabs');
    const subTabUncompleted = document.getElementById('sub-tab-uncompleted');
    const subTabCompleted = document.getElementById('sub-tab-completed');
    const searchBtn = document.getElementById('search-btn');
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const clearSearchBtn = document.getElementById('clear-search-btn');

    tabToday.addEventListener('click', () => {
        dateFilter = 'today';
        tabToday.classList.add('active');
        tabAll.classList.remove('active');
        if (allSubTabs) allSubTabs.style.display = 'none';
        render();
    });

    tabAll.addEventListener('click', () => {
        dateFilter = 'all';
        tabAll.classList.add('active');
        tabToday.classList.remove('active');
        if (allSubTabs) {
            allSubTabs.style.display = 'flex';
            // 同步选中样式
            if (allTabMode === 'uncompleted') {
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
                searchQuery = '';
                if (clearSearchBtn) clearSearchBtn.style.display = 'none';
                render();
            }
        });
    }

    // 搜索输入过滤（150ms 防抖，避免每次击键触发全量 DOM 重建）
    if (searchInput) {
        const debouncedSearch = debounce(() => {
            searchQuery = searchInput.value.trim();
            if (clearSearchBtn) {
                clearSearchBtn.style.display = searchQuery ? 'block' : 'none';
            }
            render();
        }, 150);
        searchInput.addEventListener('input', debouncedSearch);
    }

    // 清除搜索
    if (clearSearchBtn && searchInput) {
        clearSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchQuery = '';
            clearSearchBtn.style.display = 'none';
            render();
            searchInput.focus();
        });
    }

    // 全部待办子选项卡切换
    if (subTabUncompleted && subTabCompleted) {
        subTabUncompleted.addEventListener('click', () => {
            allTabMode = 'uncompleted';
            subTabUncompleted.classList.add('active');
            subTabCompleted.classList.remove('active');
            render();
        });

        subTabCompleted.addEventListener('click', () => {
            allTabMode = 'completed';
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
    ['edit-content', 'edit-date', 'edit-time', 'edit-task-type', 'edit-target-count'].forEach(id => {
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
            if (currentEditingTodo) {
                // 如果是“每天重复”，底层映射为 normal + recurring = daily_repeat
                if (taskTypeSelect.value === 'daily_repeat') {
                    currentEditingTodo.task_type = 'normal';
                    currentEditingTodo.recurring = 'daily_repeat';
                } else {
                    currentEditingTodo.task_type = taskTypeSelect.value;
                    currentEditingTodo.recurring = 'none';
                    if (taskTypeSelect.value === 'normal') {
                        if (isWeekDate(currentEditingTodo.date) || isMonthDate(currentEditingTodo.date)) {
                            currentEditingTodo.date = getTodayString();
                            const dateInput = document.getElementById('edit-date');
                            if (dateInput) {
                                dateInput.value = currentEditingTodo.date;
                                dateInput.type = 'date';
                                const typeBtn = document.getElementById('edit-date-type-btn');
                                if (typeBtn) typeBtn.textContent = '文本格式';
                            }
                        }
                    }
                }
                renderEditCheckinGrid(currentEditingTodo);
            }
        });
    }

    const dateInput = document.getElementById('edit-date');
    const typeBtn = document.getElementById('edit-date-type-btn');
    if (typeBtn && dateInput) {
        typeBtn.addEventListener('click', () => {
            const oldVal = dateInput.value;
            if (dateInput.type === 'date') {
                dateInput.type = 'text';
                typeBtn.textContent = '日历格式';
                dateInput.placeholder = 'YYYY-MM-DD, YYYY-Wxx, YYYY-MM';
                dateInput.value = oldVal;
            } else {
                dateInput.type = 'date';
                typeBtn.textContent = '文本格式';
                if (/^\d{4}-\d{2}-\d{2}$/.test(oldVal)) {
                    dateInput.value = oldVal;
                } else {
                    dateInput.value = '';
                }
            }
            autoSaveEdit();
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
        const { content, taskDate, taskType, targetCount } = parseInputSyntax(raw);
        if (!content) return;

        const finalDate = taskDate || getTodayString();
        const todo = createTodo(content, finalDate);
        applyTaskType(todo, taskType, targetCount);

        todoData.todos.push(todo);
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
            const raw = quickAddInput.value.trim();
            const { content, taskDate, taskType, targetCount } = parseInputSyntax(raw);
            if (!content) return;

            const finalDate = taskDate || getTodayString();
            const todo = createTodo(content, finalDate);
            applyTaskType(todo, taskType, targetCount);

            todoData.todos.push(todo);
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

    // 启动 24 点自动刷新
    scheduleMidnightRefresh();

    // 窗口聚焦时主动检测跨天
    let lastRenderDate = getTodayString();
    window.addEventListener('focus', () => {
        const today = getTodayString();
        if (today !== lastRenderDate) {
            lastRenderDate = today;
            if (!window._pendingMidnightRefresh) {
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
            window._pendingMidnightRefresh = true;
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

async function importFromLastPeriod(type) {
    const todayStr = getTodayString();
    const thisWeekStr = getThisWeekString();
    const thisMonthStr = getThisMonthString();

    let sourcePeriodStr = '';
    let targetPeriodStr = '';

    if (type === 'weekly') {
        sourcePeriodStr = getLastWeekString();
        targetPeriodStr = thisWeekStr;
    } else {
        sourcePeriodStr = getLastMonthString();
        targetPeriodStr = thisMonthStr;
    }

    // 找出上一周期所有未完成或被标记为完成的打卡计划
    const candidates = todoData.todos.filter(t => 
        !t.deleted && 
        (t.task_type === 'weekly_checkin' || t.task_type === 'monthly_checkin') &&
        t.date === sourcePeriodStr
    );

    if (candidates.length === 0) {
        showToast('上一周期没有打卡任务可供导入');
        return;
    }

    // 检查是否已经在目标周期内有同名任务
    const existingTitles = new Set(
        todoData.todos
            .filter(t => !t.deleted && t.date === targetPeriodStr)
            .map(t => t.content)
    );

    let importCount = 0;
    candidates.forEach(src => {
        if (existingTitles.has(src.content)) return; // 避免重复导入

        const clone = createTodo(src.content, targetPeriodStr);
        clone.task_type = src.task_type;
        clone.target_count = src.target_count;
        clone.completed = false;
        clone.completed_at = null;
        clone.completed_dates = [];

        // 深度复制并重置子步骤
        clone.subtasks = src.subtasks 
            ? JSON.parse(JSON.stringify(src.subtasks)).map(sub => {
                sub.id = crypto.randomUUID();
                sub.completed = false;
                sub.completed_at = null;
                return sub;
              })
            : [];

        todoData.todos.push(clone);
        importCount++;
    });

    if (importCount > 0) {
        showToast(`成功导入 ${importCount} 个打卡任务`);
        render();
        await saveData();
    } else {
        showToast('任务已存在，无需重复导入');
    }
}