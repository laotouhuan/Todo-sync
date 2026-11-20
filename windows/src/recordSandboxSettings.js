import { generateUUID, getTodayString } from './dateUtils.js';
import { makeRecordSandboxBinding, openRecordSandbox, planningCloudTarget, retainsLocalPlanning } from './recordSandbox.js';
import { openRecordJournal } from './recordRecovery.js';
import { comparePlanText, mondayForDate, planningCalendar, ratingSummary, weeklyPlanState } from './weeklyPlanning.js';
import { exportReviews } from './reviewUtils.js';

const targetKey = 'todo-record-sandbox-target-v1';

export function bindRecordSandbox(document, invoke, panel = document.getElementById('record-sandbox'),
    onPlanningSync = () => {}, chooseWeekLeave = () => 'cancel') {
    if (!panel) return;
    const get = name => panel.querySelector(`[data-${name}]`);
    const status = get('status'), task = get('task'), date = get('date'), form = get('content');
    const tasks = get('tasks'), planning = get('planning'), start = get('start'), stop = get('stop');
    const selector = get('target');
    const retry = get('retry');
    const enableFocus = document.getElementById('enable-planning-focus');
    const retryFocus = document.getElementById('retry-planning-focus');
    const focusStatus = document.getElementById('planning-focus-status');
    date.value = getTodayString();
    const personal = panel.id === 'stats-planning';
    let session, state, shownView, shownPlan, busy = false, reportError = false, closeRequested = false, month = false;
    let sourceKey = null, connectedKey, statsPeriod = 'day';
    let config, connectedConfig, cloudActive = false, cloudState = 'syncing', visible = false;
    let planningStatus = 'idle', planningError = '', retainedLocalPlanning = false;
    let weekDetails = null;
    let weekReviewList;
    let confirmation;
    const drafts = new Map();
    const listeners = new Set();
    let loadError = '', lastOperationError = '', ratingDate, weekDraft, opening = false, onWriteSaved;
    const isCurrent = () => Boolean(sourceKey && connectedKey === sourceKey && connectedConfig === config);
    const notify = () => listeners.forEach(listener => listener());

    function publishSync(state, message = '') {
        planningStatus = state;
        planningError = state === 'error' ? message || planningError || '计划与评分同步失败，请重试' : '';
        onPlanningSync(state, planningError);
    }

    function element(tag, text, parent) {
        const node = document.createElement(tag);
        if (text !== null) node.textContent = text;
        parent.append(node);
        return node;
    }
    function button(text, parent, action, style = '') {
        const node = element('button', text, parent);
        node.type = 'button';
        node.className = ['ui-button', style].filter(Boolean).join(' ');
        node.addEventListener('click', action);
        return node;
    }
    function report(message, kind = '') {
        status.textContent = message;
        if (personal) {
            status.hidden = !message || Boolean(ratingDate);
            status.classList.toggle('learning-error', kind === 'error');
            retry.hidden = kind !== 'retry' || Boolean(ratingDate);
        }
    }
    function update(next) {
        if (personal && !next.view && state?.view) {
            cloudState = 'error';
            publishSync('error', '计划与评分暂不可用，本机已有内容已保留，请重试读取');
            notify();
            return;
        }
        state = next;
        if (cloudActive) {
            if (next.journal.fault || next.listFailed || next.readFailures?.length || next.uploadFailures?.length) cloudState = 'error';
            else if (next.listFailed !== undefined) cloudState = 'idle';
            if (connectedKey === sourceKey && connectedConfig === config) {
                let reason = '';
                if (next.journal.fault) reason = '计划与评分同步已暂停，需要核对数据完整性';
                else if (next.listFailed) reason = '计划与评分云端目录读取失败，请检查网络或同步配置';
                else if (next.readFailures?.length) reason = '部分云端计划与评分读取失败，请重试';
                else if (next.uploadFailures?.length) reason = '部分计划与评分尚未上传，请重试';
                if (next.transportError && reason) reason += `（${next.transportError}）`;
                publishSync(cloudState === 'idle' && next.journal.pending.length ? 'syncing' : cloudState, reason);
            }
        }
        if (personal) {
            if (enableFocus && focusStatus) {
                const needsRead = cloudActive && ['unknown', 'invalid'].includes(next.focusStatus);
                enableFocus.parentElement.hidden = !cloudActive;
                if (retryFocus) retryFocus.hidden = !needsRead;
                enableFocus.disabled = !next.canEnableFocus;
                if (next.focusEnabled) focusStatus.textContent = '当前计划数据集已启用本周重点';
                else if (needsRead) focusStatus.textContent = '本周重点启用状态待核对';
                else if (next.canEnableFocus) focusStatus.textContent = '也可在首次保存本周重点时启用';
                else focusStatus.textContent = cloudActive ? '云端本周重点尚不可启用' : '';
            }
            loadError = next.view ? '' : '无法读取本机计划与评分';
            if (!cloudActive && isCurrent()) {
                if (loadError) publishSync('error', loadError);
                else if (!retainedLocalPlanning) publishSync('idle');
            }
            if (loadError && !reportError) report(loadError, 'retry');
            notify();
        }
        if (!reportError && !loadError) report(personal ? '' : next.journal.fault ? '同步已暂停，请核对故障证据。' :
            `待上传 ${next.journal.pending.length} 条${next.uploadFailures?.length ? '，稍后重试' : ''}`);
        const content = JSON.stringify(next.view);
        if (content === shownView) return;
        shownView = content;
        tasks?.replaceChildren();
        if (tasks && next.view) for (const todo of next.view.todos.filter(todo => todo.task_type === 'normal' && !todo.deleted)) {
            const item = element('li', null, tasks);
            const name = element('input', null, item);
            name.value = todo.content;
            name.setAttribute('aria-label', '任务名称');
            button('改名', item, () => change({ kind: 'rename', todoId: todo.id, content: name.value }, state.revision));
            button('删除', item, () => change({ kind: 'remove', todoId: todo.id }, state.revision), 'danger');
        }
        const planContent = JSON.stringify(next.view && [next.view.weekly_plan_versions, next.view.weekly_plan_selections,
            next.view.daily_ratings, next.focusStatus]);
        if (planContent !== shownPlan) {
            shownPlan = planContent;
            renderPlanning();
        }
    }

    function renderRatingGrid(parent, calendar, ratings, showDates, onSelect) {
        const grid = element('div', null, parent);
        grid.className = 'checkin-grid-container record-rating-grid';
        const scores = new Map(ratings.filter(item => !item.deleted).map(item => [item.date, item.score]));
        const today = getTodayString();
        for (const weekday of '一二三四五六日') element('span', weekday, grid).className = 'checkin-grid-header ui-note';
        for (const cell of calendar.cells) {
            const score = scores.get(cell.date);
            const tile = element(onSelect ? 'button' : 'span', null, grid);
            tile.className = 'calendar-cell rating-calendar-cell rating-tone';
            tile.classList.toggle('today-cell', cell.date === today);
            if (score != null) tile.dataset.score = score;
            tile.dataset.inRange = cell.inRange;
            const label = `${cell.date} ${score == null ? '未评分' : score + ' 分'}`;
            tile.setAttribute('aria-label', label);
            tile.title = label;
            if (onSelect) {
                tile.type = 'button';
                tile.classList.add('ui-button');
                tile.setAttribute('aria-pressed', String(cell.date === date.value));
                tile.addEventListener('click', () => onSelect(cell.date));
            } else tile.setAttribute('role', 'img');
            if (showDates) element('span', String(Number(cell.date.slice(-2))), tile).className = 'rating-calendar-date';
            if (score != null) element('span', String(score), tile).className = 'rating-calendar-score';
        }
    }

    function renderPlanning() {
        weekDraft = null;
        weekReviewList = undefined;
        planning.replaceChildren();
        if (!state?.view || !date.value || closeRequested || (personal && (!isCurrent() || statsPeriod === 'day'))) return;
        const view = state.view, day = date.value, week = mondayForDate(day);
        const plan = weeklyPlanState(view, week);
        const action = (details, onSaved, activateFocus) =>
            change({ week, tips: plan.tips, ...details }, state.revision, onSaved, activateFocus);
        const personalWeek = personal && statsPeriod === 'week';
        const weekCalendar = planningCalendar(day, false);
        const weekCells = weekCalendar.cells;
        const dayLabel = index => {
            const [, month, day] = weekCells[index].date.split('-').map(Number);
            return `周${'一二三四五六日'[index]} · ${month}月${day}日`;
        };
        if (personalWeek) {
            element('h4', '本周重点', planning);
            const focus = element('p', plan.current?.focus?.trim() ? plan.current.focus : '未填写本周重点', planning);
            focus.className = 'learning-text insight-clipped insight-focus';
            const expand = button('展开', planning, () => {
                const expanded = focus.classList.toggle('insight-expanded');
                expand.textContent = expanded ? '收起' : '展开';
                expand.setAttribute('aria-expanded', String(expanded));
            });
            expand.hidden = true;
            expand.setAttribute('aria-expanded', 'false');
            requestAnimationFrame(() => { expand.hidden = focus.scrollHeight <= focus.clientHeight + 1; });
            if (plan.state === 'conflict') element('p', '周计划存在分歧', planning);
            element('h4', '每日评分', planning);
            renderRatingGrid(planning, weekCalendar, view.daily_ratings, false);
            if (weekDetails !== week) {
                button('查看本周详情', planning, () => { weekDetails = week; renderPlanning(); });
                return;
            }
        }
        const detail = personalWeek ? element('section', null, planning) : planning;
        if (personalWeek) {
            detail.className = 'planning-week-detail';
            element('h4', '本周详情', detail);
            button('关闭详情', detail, async () => {
                if (!await beforeLeave(chooseWeekLeave)) return;
                weekDetails = null;
                renderPlanning();
            });
        }
        if (personalWeek && plan.current) {
            const overview = element('div', null, detail);
            overview.className = 'planning-week-days';
            element('p', plan.current.focus || '未填写本周重点', overview).className = 'learning-text';
            weekCells.forEach((cell, index) => {
                const row = element('div', null, overview);
                element('strong', dayLabel(index), row);
                element('p', plan.current.days[index] || '当天未安排', row).className = 'learning-text';
            });
        }
        const editor = personal ? personalWeek && element('details', null, detail) : detail;
        const draftKey = personal ? week : `${week}:${plan.tips.join(',')}`;
        const draft = drafts.get(draftKey);
        if (personal && editor) {
            const title = { empty: '制定周计划', current: '查看或修订周计划', conflict: '计划存在分歧', restart: '重新制定周计划' }[plan.state];
            element('summary', title, editor);
            editor.className = 'planning-fold planning-editor';
            editor.open = Boolean(draft) || plan.state === 'conflict';
        }
        if (editor) {
            const planStatus = element('p', `${week} 当周计划 · ${{ empty: '未制定', current: '已有计划', conflict: '存在分歧', restart: '需重新制定' }[plan.state]}`, editor);
            if (personal) planStatus.className = 'planning-meta';
            if (plan.state === 'conflict') for (const version of plan.candidates.filter(item => !item.deleted)) {
                const details = element('details', null, editor);
                element('summary', `候选 · ${version.created_at}`, details);
                element('p', version.focus || '未填写本周重点', details).className = 'learning-text';
                version.days.forEach((value, index) => element('p', `周${'一二三四五六日'[index]} ${value}`, details));
                button('采用此版', details, () => action({ kind: 'resolve', versionId: version.id }));
            }
            if (plan.state !== 'conflict') {
                const fields = personal ? element('div', null, editor) : editor;
                if (personal) fields.className = 'planning-fields';
                const focus = document.createElement('textarea');
                focus.value = draft?.focus ?? plan.current?.focus ?? '';
                if (personal) {
                    focus.rows = 3;
                    element('label', '本周重点', fields).append(focus);
                }
                const inputs = Array.from({ length: 7 }, (_, index) => {
                    const label = element('label', personal ? dayLabel(index) : `周${'一二三四五六日'[index]} `, fields);
                    const input = element('textarea', null, label);
                    if (personal) input.rows = 2;
                    input.value = draft?.days[index] ?? plan.current?.days[index] ?? '';
                    return input;
                });
                const reason = element('input', null, element('label', '修订原因 ', fields));
                reason.value = draft?.reason ?? '';
                const rememberDraft = () => {
                    const days = inputs.map(input => input.value);
                    const baseline = plan.current?.days ?? Array(7).fill('');
                    if (reason.value || focus.value !== (plan.current?.focus ?? '') || days.some((value, index) => value !== baseline[index])) {
                        drafts.set(draftKey, { days, focus: focus.value, reason: reason.value, tips: draft?.tips ?? plan.tips });
                    } else drafts.delete(draftKey);
                };
                [...inputs, focus, reason].forEach(input => input.addEventListener('input', rememberDraft));
                const needsRead = ['unknown', 'invalid'].includes(state.focusStatus);
                const needsFocusUpgrade = () => cloudActive && state.focusStatus === 'legacy' && Boolean(focus.value.trim());
                const save = async () => {
                    if (busy || needsRead) return false;
                    const upgrade = needsFocusUpgrade();
                    if (upgrade) {
                        const selected = session;
                        if (!state.canEnableFocus || !await confirmFocusUpgrade()) return false;
                        if (session !== selected || !isCurrent() || date.value !== day) return false;
                    }
                    const submittedDraft = drafts.get(draftKey);
                    return action({ kind: 'save', versionId: generateUUID(), days: inputs.map(input => input.value),
                        ...(state.focusEnabled || upgrade ? { focus: focus.value } : {}),
                        reason: reason.value, tips: submittedDraft?.tips ?? plan.tips }, () => {
                            if (drafts.get(draftKey) === submittedDraft) drafts.delete(draftKey);
                            if (personal) renderPlanning();
                        }, upgrade);
                };
                if (personal) weekDraft = { key: draftKey, save };
                const saveButton = button('保存计划', editor, save, 'primary');
                const unavailable = personal && element('p', '当前云端暂不支持启用本周重点', editor);
                const updateSaveButton = () => {
                    const unsupported = needsFocusUpgrade() && !state.canEnableFocus;
                    saveButton.disabled = needsRead || unsupported;
                    if (unavailable) unavailable.hidden = !unsupported;
                };
                focus.addEventListener('input', updateSaveButton);
                updateSaveButton();
                if (needsRead) {
                    element('p', '本周重点启用状态待核对，请重试同步', editor);
                    button('重试读取', editor, () => void session.sync().catch(() => {}));
                }
            }
            const history = element('details', null, editor);
            element('summary', '历史版本', history);
            for (const version of plan.history) {
                const item = element('details', null, history);
                element('summary', version.created_at, item);
                if (version.change_reason) element('p', version.change_reason, item).className = 'learning-text';
                element('p', version.focus || '未填写本周重点', item).className = 'learning-text';
                version.days.forEach((value, index) => element('p', `周${'一二三四五六日'[index]} ${value}`, item));
                if (!plan.candidates.some(candidate => candidate.id === version.id)) {
                    button('删除历史版本', item, async () => {
                        const selected = session;
                        const confirmed = await confirmAction('删除此历史版本？', '', '删除', 'danger');
                        if (confirmed && session === selected && date.value === day) {
                            await action({ kind: 'delete', versionId: version.id });
                        }
                    }, 'danger');
                }
            }
            if (plan.history.length > 1) renderComparison(plan.history, editor);
        }
        const rating = view.daily_ratings.find(item => item.date === day && !item.deleted)?.score;
        const monthly = personal ? statsPeriod === 'month' : month;
        const calendar = monthly ? planningCalendar(day, true) : weekCalendar;
        const { average, count, days } = ratingSummary(view, calendar.start, calendar.last);
        if (personalWeek) {
            element('h4', '每日回顾', detail);
            weekReviewList = { host: element('div', null, detail), cells: weekCells };
            refreshWeekReviews();
            button('导出 Markdown', detail, () => panel.dispatchEvent(new CustomEvent('planning-export', { detail: day })));
        }
        const scoreSummary = element('p',
            (average == null ? '暂无评分' : `${monthly ? '月' : '周'}平均 ${average}`) +
            (personal ? ` · 已评分 ${count}/${days} 天` : ` · 当日评分 ${rating ?? '未评分'}`), detail);
        if (personal) scoreSummary.className = 'planning-score-summary';
        if (personalWeek) return;
        if (!personal) button(month ? '查看本周评分' : '查看本月评分', planning, () => { month = !month; renderPlanning(); });
        renderRatingGrid(planning, calendar, view.daily_ratings, true, selectedDay => {
            if (personal) panel.dispatchEvent(new CustomEvent('planning-day', { detail: selectedDay }));
            else { date.value = selectedDay; renderPlanning(); }
        });
        if (!personal) {
            for (const score of [1, 2, 3, 4, 5]) {
                const choice = button(`${score} 分`, planning, () => change({ kind: 'rate', date: day, score }, state.revision));
                choice.setAttribute('aria-pressed', String(rating === score));
            }
            button('清除评分', planning, () => change({ kind: 'rate', date: day, score: null }, state.revision));
        }
        if (personal) return;
        const exportOptions = planning;
        const options = Object.fromEntries([['includePlans', '计划'], ['includeRatings', '评分'], ['includePlanHistory', '计划历史']]
            .map(([key, title]) => {
                const label = element('label', title, exportOptions);
                const checkbox = element('input', null, label);
                checkbox.type = 'checkbox';
                return [key, checkbox];
            }));
        const exportActions = planning;
        const range = element('select', null, exportActions);
        range.setAttribute('aria-label', '导出范围');
        for (const [value, label] of [['day', '当天'], ['week', '本周'], ['month', '本月']]) {
            element('option', label, range).value = value;
        }
        button('导出 Markdown', exportActions, () => run(async () => {
            const flags = Object.fromEntries(Object.entries(options).map(([key, box]) => [key, box.checked]));
            const result = exportReviews(state.view, range.value, day + 'T12:00:00', false,
                undefined, undefined, undefined, flags);
            if (await invoke('export_review_markdown', result)) report('已保存 Markdown。');
        }), 'primary');
    }

    function refreshWeekReviews() {
        if (weekReviewList) panel.dispatchEvent(new CustomEvent('planning-reviews', { detail: weekReviewList }));
    }

    function renderComparison(versions, parent) {
        const details = element('details', null, parent);
        element('summary', '对比版本', details);
        const selectors = ['旧版', '新版'].map((label, index) => {
            const input = element('select', null, element('label', label, details));
            for (const version of versions) element('option', version.created_at + ' · ' + version.id.slice(-6), input).value = version.id;
            input.selectedIndex = index ? versions.length - 1 : versions.length - 2;
            return input;
        });
        element('p', '删除内容带删除线，新增内容带下划线。', details);
        const table = element('table', null, details);
        const render = () => {
            table.replaceChildren();
            const [old, next] = selectors.map(input => versions.find(version => version.id === input.value));
            for (let index = -1; index < 7; index++) {
                const row = element('tr', null, table);
                element('th', index < 0 ? '本周重点' : `周${'一二三四五六日'[index]}`, row);
                const diff = comparePlanText(index < 0 ? old.focus : old.days[index], index < 0 ? next.focus : next.days[index]);
                for (const [tag, text] of [['del', diff.removed], ['ins', diff.added]]) {
                    const cell = element('td', diff.before, row);
                    element(tag, text, cell);
                    cell.append(document.createTextNode(diff.after));
                }
            }
        };
        for (const input of selectors) input.addEventListener('change', render);
        render();
    }

    async function run(action, retrySave = false) {
        if (busy) return false;
        busy = true;
        form.disabled = true;
        retry.disabled = true;
        reportError = false;
        lastOperationError = '';
        if (personal) {
            report('');
            if (retrySave && !ratingDate) report('正在保存计划…');
            notify();
        }
        try {
            await action();
            if (personal && retrySave && !ratingDate) report('');
            return true;
        } catch (error) {
            reportError = true;
            lastOperationError = String(error?.message ?? error);
            report(`操作未确认（${error?.message ?? error}）`, retrySave ? 'retry' : 'error');
            return false;
        } finally {
            form.disabled = false;
            retry.disabled = false;
            busy = false;
            if (personal) notify();
            if (closeRequested) {
                closeRequested = false;
                void close();
            }
        }
    }

    function confirmAction(title, message, label, variant = 'primary') {
        if (confirmation) return Promise.resolve(false);
        const dialog = document.createElement('dialog');
        dialog.className = 'learning-dialog';
        dialog.setAttribute('aria-label', title);
        element('h3', title, dialog);
        if (message) element('p', message, dialog);
        const cancel = button('取消', dialog, () => dialog.close());
        cancel.classList.add('ui-button');
        cancel.autofocus = true;
        const accept = button(label, dialog, () => dialog.close('confirm'));
        accept.classList.add('ui-button', variant);
        dialog.addEventListener('keydown', event => event.stopPropagation());
        return new Promise(resolve => {
            dialog.addEventListener('close', () => {
                dialog.remove();
                confirmation = null;
                resolve(dialog.returnValue === 'confirm');
            }, { once: true });
            document.body.append(dialog);
            confirmation = dialog;
            dialog.showModal();
        });
    }

    function confirmFocusUpgrade() {
        return confirmAction('升级云端周计划格式', '请确认仍在使用此计划数据集的设备均已升级到兼容版本。', '确认升级');
    }
    function change(action, revision, onSaved, activateFocus = false) {
        if (busy || !session || (personal && !isCurrent())) return false;
        const selected = session;
        ratingDate = action.kind === 'rate' ? action.date : null;
        onWriteSaved = onSaved;
        return run(async () => {
            if (activateFocus) {
                const upgraded = await selected.enableFocus(() => isCurrent() && session === selected);
                if (!isCurrent() || session !== selected) throw new Error('个人清单已切换，请重试');
                revision = upgraded.revision;
            }
            await selected.change(action, revision);
            if (!personal || isCurrent()) onWriteSaved?.();
            onWriteSaved = undefined;
        }, true);
    }
    function retryWrite() {
        if (personal && !isCurrent() || !session?.hasPendingWrite()) return false;
        return run(async () => {
            const saved = await session.retry();
            if (saved && (!personal || isCurrent())) onWriteSaved?.();
            onWriteSaved = undefined;
        }, true);
    }
    async function beforeLeave(choose) {
        if (busy && !opening) return false;
        const key = mondayForDate(date.value);
        if (!drafts.has(key)) return true;
        const answer = await choose();
        if (answer === 'save') return weekDraft?.key === key && await weekDraft.save();
        if (answer !== 'discard') return false;
        drafts.delete(key);
        renderPlanning();
        return true;
    }
    get('add')?.addEventListener('click', async () => {
        if (await change({ kind: 'add', content: task.value }, state.revision)) task.value = '';
    });
    retry.addEventListener('click', () => loadError ? (session ? close() : refresh()) : retryWrite());
    date.addEventListener('change', renderPlanning);
    async function connect(key) {
        const connection = connectedConfig;
        let target = personal ? await invoke('open_personal_planning_target', { target: key }) :
            JSON.parse(localStorage.getItem(key));
        if (!target && !personal) {
            target = { datasetId: generateUUID(), actorId: generateUUID(), at: new Date().toISOString() };
            localStorage.setItem(key, JSON.stringify(target));
        }
        let cloud = personal ? planningCloudTarget(connectedConfig, target.actorId) : null;
        let retainedLocal = false;
        if (cloud) {
            const legacy = await openRecordJournal(invoke, makeRecordSandboxBinding(target.datasetId, target.at));
            retainedLocal = retainsLocalPlanning(legacy);
            if (retainedLocal) cloud = null;
        }
        if (personal && (key !== sourceKey || connection !== config)) return;
        cloudActive = Boolean(cloud);
        retainedLocalPlanning = retainedLocal;
        cloudState = 'syncing';
        if (personal && connectedKey === sourceKey && connectedConfig === config) {
            publishSync(cloudActive ? 'syncing' : retainedLocal ? 'error' : 'idle', retainedLocal ?
                '本机已有独立的计划与评分，已保留在本机，尚未接入云端计划同步' : '');
        }
        session = await openRecordSandbox(invoke, cloud?.target ?? target, next => {
            if (!personal || (key === sourceKey && connection === config)) update(next);
        }, error => {
            if (personal && (key !== sourceKey || connection !== config)) return;
            if (cloudActive) {
                cloudState = 'error';
                if (connectedKey === sourceKey && connectedConfig === config) publishSync('error',
                    `计划与评分同步失败（${error?.message ?? error}）`);
                notify();
            } else {
                publishSync('error', `计划与评分读取失败（${error?.message ?? error}）`);
                if (!reportError) report(`同步未完成（${error?.message ?? error}）`, 'error');
            }
        }, cloud ? 60000 : 5000, { localOnly: personal, webDav: cloud?.webDav });
        form.hidden = false;
        if (start) start.hidden = true;
        if (stop) stop.hidden = false;
        if (selector) selector.disabled = true;
    }
    start?.addEventListener('click', () => run(() => connect(`${targetKey}-${selector.value}`)));
    function close() {
        if (confirmation?.open) confirmation.close();
        if (busy) {
            closeRequested = true;
            return;
        }
        if (!session) return;
        return run(async () => {
            await session.close();
            session = null;
            state = null;
            shownView = null;
            shownPlan = null;
            drafts.clear();
            form.hidden = true;
            if (start) start.hidden = false;
            if (stop) stop.hidden = true;
            if (selector) selector.disabled = false;
            report(personal ? '' : '试用清单已关闭。');
        }).then(() => { if (personal && sourceKey) void refresh(); });
    }
    stop?.addEventListener('click', close);
    async function refresh(force = false) {
        if (busy || !sourceKey || session || (!visible && !force)) return;
        const key = sourceKey;
        const connection = config;
        opening = true;
        loadError = '';
        ratingDate = null;
        retry.textContent = '重试上次保存';
        const opened = await run(async () => {
            connectedKey = key;
            connectedConfig = config;
            await connect(key);
            if (sourceKey !== key || connectedConfig !== config) {
                form.hidden = true;
                closeRequested = true;
            }
        });
        opening = false;
        if ((!opened || !state?.view) && sourceKey === key && config === connection) {
            loadError = opened ? '无法读取本机计划与评分' : `计划与评分加载失败：${lastOperationError}`;
            report(loadError, 'retry');
            retry.textContent = '重试读取';
            publishSync('error', loadError);
        }
        notify();
        if (sourceKey && (sourceKey !== key || config !== connection)) void refresh();
    }
    if (personal) {
        retryFocus?.addEventListener('click', () => {
            if (session && isCurrent()) void session.sync().catch(() => {});
            else void refresh(true);
        });
        enableFocus?.addEventListener('click', async () => {
            if (!session) await refresh(true);
            if (!session || !isCurrent() || !state?.canEnableFocus) return;
            const selected = session;
            if (cloudActive && !await confirmFocusUpgrade()) return;
            if (session !== selected || !isCurrent()) return;
            const ok = await run(() => selected.enableFocus(() => isCurrent() && session === selected));
            if (!ok && focusStatus) focusStatus.textContent = lastOperationError || '启用失败，请重试';
        });
        const setContext = (key, period, day, savedConfig, show) => {
            const changed = date.value !== day || statsPeriod !== period;
            if (changed || key !== sourceKey) weekDetails = null;
            const previousKey = sourceKey, previousConfig = config;
            sourceKey = key;
            visible = show;
            if (!config || ['sync_mode', 'webdav_url', 'webdav_username', 'webdav_password', 'webdav_filepath']
                .some(field => config[field] !== savedConfig?.[field])) config = savedConfig;
            statsPeriod = period;
            date.value = day;
            panel.hidden = !key || !visible || period === 'day';
            const title = panel.querySelector('h3');
            if (title) title.textContent = period === 'month' ? '月评分' : '本周计划与回顾';
            if (key !== previousKey || config !== previousConfig) {
                loadError = '';
                publishSync('idle');
                notify();
            }
            if (session && (connectedKey !== key || connectedConfig !== config)) {
                form.hidden = true;
                planning.replaceChildren();
                void close();
            } else if (!session && key && !loadError) {
                void refresh();
            } else if (session && visible && changed) {
                renderPlanning();
            }
        };
        const snapshot = () => isCurrent() ? state?.view : undefined;
        return {
            setContext, snapshot,
            prepareFocusSetting: () => refresh(true),
            async sync() {
                if (busy || !sourceKey) return false;
                // 手动同步覆盖计划与评分，不以统计页是否打开作为前置条件。
                if (!session) {
                    await refresh(true);
                }
                if (session && isCurrent() && !loadError) {
                    try {
                        await session.sync();
                    } catch {
                        return false;
                    }
                } else return false;
                return planningStatus === 'idle';
            },
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            day(day) {
                const view = snapshot();
                const week = mondayForDate(day);
                const plan = view && weeklyPlanState(view, week);
                const index = planningCalendar(day, false).cells.findIndex(cell => cell.date === day);
                const rating = view ? view.daily_ratings.find(item => item.date === day) ?? null : undefined;
                return { plan: plan?.state, text: plan?.current?.days[index], rating,
                    score: rating?.deleted ? null : rating?.score ?? null,
                    busy, loadError, syncFailed: isCurrent() && cloudActive && cloudState === 'error',
                    saving: busy && !opening && ratingDate === day,
                    saveError: isCurrent() && ratingDate === day && reportError ? status.textContent : '' };
            },
            rate: (day, score, expectedRating) => expectedRating === undefined ? false :
                change({ kind: 'rate', date: day, score, expectedRating }, state?.revision),
            hasPendingWrite: day => Boolean(session?.hasPendingWrite(day)),
            retryRating: retryWrite,
            reload: () => isCurrent() && session ? close() : refresh(),
            openWeek() {
                weekDetails = mondayForDate(date.value);
                renderPlanning();
            },
            refreshWeekReviews,
            beforeLeave
        };
    }
    const settings = document.getElementById('settings-modal');
    new MutationObserver(() => { if (!settings.classList.contains('active')) void close(); })
        .observe(settings, { attributes: true, attributeFilter: ['class'] });
}
