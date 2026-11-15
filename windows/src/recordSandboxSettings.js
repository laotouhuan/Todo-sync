import { generateUUID, getTodayString } from './dateUtils.js';
import { makeRecordSandboxBinding, openRecordSandbox, planningCloudTarget, retainsLocalPlanning } from './recordSandbox.js';
import { openRecordJournal } from './recordRecovery.js';
import { comparePlanText, mondayForDate, planningCalendar, ratingSummary, weeklyPlanState } from './weeklyPlanning.js';
import { exportReviews } from './reviewUtils.js';

const targetKey = 'todo-record-sandbox-target-v1';

export function bindRecordSandbox(document, invoke, panel = document.getElementById('record-sandbox'), onPlanningSync = () => {}) {
    if (!panel) return;
    const get = name => panel.querySelector(`[data-${name}]`);
    const status = get('status'), task = get('task'), date = get('date'), form = get('content');
    const tasks = get('tasks'), planning = get('planning'), start = get('start'), stop = get('stop');
    const selector = get('target');
    const retry = get('retry');
    date.value = getTodayString();
    const personal = panel.id === 'stats-planning';
    let session, state, shownView, shownPlan, busy = false, reportError = false, closeRequested = false, month = false;
    let sourceKey = null, connectedKey, statsPeriod = 'day';
    let config, connectedConfig, cloudActive = false, cloudState = 'syncing', visible = false;
    const drafts = new Map();
    const listeners = new Set();
    let loadError = '', ratingDate, weekDraft, opening = false, onWriteSaved;
    const isCurrent = () => Boolean(sourceKey && connectedKey === sourceKey && connectedConfig === config);
    const notify = () => listeners.forEach(listener => listener());

    function element(tag, text, parent) {
        const node = document.createElement(tag);
        if (text !== null) node.textContent = text;
        parent.append(node);
        return node;
    }
    function button(text, parent, action, style = '') {
        const node = element('button', text, parent);
        node.type = 'button';
        if (personal) node.className = ['learning-button', style].filter(Boolean).join(' ');
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
            onPlanningSync('error');
            notify();
            return;
        }
        state = next;
        if (cloudActive) {
            if (next.journal.fault || next.listFailed || next.readFailures?.length || next.uploadFailures?.length) cloudState = 'error';
            else if (next.listFailed !== undefined) cloudState = 'idle';
            if (connectedKey === sourceKey && connectedConfig === config) {
                onPlanningSync(cloudState === 'idle' && next.journal.pending.length ? 'syncing' : cloudState);
            }
        }
        if (personal) {
            loadError = next.view ? '' : '无法读取本机计划与评分';
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
            button('删除', item, () => change({ kind: 'remove', todoId: todo.id }, state.revision));
        }
        const planContent = JSON.stringify(next.view && [next.view.weekly_plan_versions, next.view.weekly_plan_selections, next.view.daily_ratings]);
        if (planContent !== shownPlan) {
            shownPlan = planContent;
            renderPlanning();
        }
    }

    function renderPlanning() {
        weekDraft = null;
        planning.replaceChildren();
        if (!state?.view || !date.value || closeRequested || (personal && (!isCurrent() || statsPeriod === 'day'))) return;
        const view = state.view, day = date.value, week = mondayForDate(day);
        const plan = weeklyPlanState(view, week);
        const action = (details, onSaved) => change({ week, tips: plan.tips, ...details }, state.revision, onSaved);
        const showPlan = !personal || statsPeriod === 'week';
        const weekCells = planningCalendar(day, false).cells;
        const dayLabel = index => {
            const [, month, day] = weekCells[index].date.split('-').map(Number);
            return `周${'一二三四五六日'[index]} · ${month}月${day}日`;
        };
        if (personal && showPlan && plan.current) {
            const overview = element('div', null, planning);
            overview.className = 'planning-week-days';
            weekCells.forEach((cell, index) => {
                const row = element('div', null, overview);
                element('strong', dayLabel(index), row);
                element('p', plan.current.days[index] || '当天未安排', row).className = 'learning-text';
                button('查看当日回顾', row, () => panel.dispatchEvent(new CustomEvent('planning-day', { detail: cell.date })));
            });
        }
        const editor = personal ? showPlan && element('details', null, planning) : planning;
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
                version.days.forEach((value, index) => element('p', `周${'一二三四五六日'[index]} ${value}`, details));
                button('采用此版', details, () => action({ kind: 'resolve', versionId: version.id }));
            }
            if (plan.state !== 'conflict') {
                const fields = personal ? element('div', null, editor) : editor;
                if (personal) fields.className = 'planning-fields';
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
                    if (reason.value || days.some((value, index) => value !== baseline[index])) {
                        drafts.set(draftKey, { days, reason: reason.value, tips: draft?.tips ?? plan.tips });
                    } else drafts.delete(draftKey);
                };
                [...inputs, reason].forEach(input => input.addEventListener('input', rememberDraft));
                const save = () => action({ kind: 'save', versionId: generateUUID(), days: inputs.map(input => input.value),
                    reason: reason.value, tips: drafts.get(draftKey)?.tips ?? plan.tips }, () => {
                        drafts.delete(draftKey);
                        if (personal) renderPlanning();
                    });
                if (personal) weekDraft = { key: draftKey, save };
                button('保存计划', editor, save, 'planning-primary');
            }
            const history = element('details', null, editor);
            element('summary', '历史版本', history);
            for (const version of plan.history) {
                const item = element('details', null, history);
                element('summary', version.created_at, item);
                if (version.change_reason) element('p', version.change_reason, item).className = 'learning-text';
                version.days.forEach((value, index) => element('p', `周${'一二三四五六日'[index]} ${value}`, item));
                if (!plan.candidates.some(candidate => candidate.id === version.id)) {
                    button('删除历史版本', item, () => {
                        if (window.confirm('删除此历史版本？')) action({ kind: 'delete', versionId: version.id });
                    });
                }
            }
            if (plan.history.length > 1) renderComparison(plan.history, editor);
        }
        const rating = view.daily_ratings.find(item => item.date === day && !item.deleted)?.score;
        const monthly = personal ? statsPeriod === 'month' : month;
        const calendar = planningCalendar(day, monthly);
        const { average, count, days } = ratingSummary(view, calendar.start, calendar.last);
        const scoreSummary = element('p',
            (average == null ? '暂无评分' : `${monthly ? '月' : '周'}平均 ${average}`) +
            (personal ? ` · 已评分 ${count}/${days} 天` : ` · 当日评分 ${rating ?? '未评分'}`), planning);
        if (personal) scoreSummary.className = 'planning-score-summary';
        if (!personal) button(month ? '查看本周评分' : '查看本月评分', planning, () => { month = !month; renderPlanning(); });
        const grid = element('div', null, planning);
        grid.className = 'record-rating-grid';
        for (const value of '一二三四五六日') element('span', value, grid);
        for (const cell of calendar.cells) {
            const score = view.daily_ratings.find(item => item.date === cell.date && !item.deleted)?.score;
            const tile = element('button', cell.date.slice(-2) + (score == null ? '' : ' · ' + score), grid);
            tile.type = 'button';
            tile.dataset.score = score ?? '';
            tile.dataset.inRange = cell.inRange;
            tile.dataset.today = cell.date === getTodayString();
            tile.setAttribute('aria-pressed', String(cell.date === day));
            tile.setAttribute('aria-label', `${cell.date} ${score == null ? '未评分' : score + ' 分'}`);
            tile.addEventListener('click', () => {
                if (personal) panel.dispatchEvent(new CustomEvent('planning-day', { detail: cell.date }));
                else { date.value = cell.date; renderPlanning(); }
            });
        }
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
        }), 'planning-primary');
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
            for (let index = 0; index < 7; index++) {
                const row = element('tr', null, table);
                element('th', `周${'一二三四五六日'[index]}`, row);
                const diff = comparePlanText(old.days[index], next.days[index]);
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

    function change(action, revision, onSaved) {
        if (busy || !session || (personal && !isCurrent())) return false;
        ratingDate = action.kind === 'rate' ? action.date : null;
        onWriteSaved = onSaved;
        return run(async () => {
            await session.change(action, revision);
            if (!personal || isCurrent()) onWriteSaved?.();
            onWriteSaved = undefined;
        }, true);
    }
    function retryWrite() {
        if (personal && !isCurrent()) return false;
        return run(async () => {
            const saved = await session.retry();
            if (saved && (!personal || isCurrent())) onWriteSaved?.();
            onWriteSaved = undefined;
        }, true);
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
        cloudState = 'syncing';
        if (personal && connectedKey === sourceKey && connectedConfig === config) {
            onPlanningSync(cloudActive ? 'syncing' : retainedLocal ? 'error' : 'idle');
        }
        session = await openRecordSandbox(invoke, cloud?.target ?? target, next => {
            if (!personal || (key === sourceKey && connection === config)) update(next);
        }, error => {
            if (personal && (key !== sourceKey || connection !== config)) return;
            if (cloudActive) {
                cloudState = 'error';
                if (connectedKey === sourceKey && connectedConfig === config) onPlanningSync('error');
                notify();
            } else if (!reportError) report(`同步未完成（${error?.message ?? error}）`, 'error');
        }, cloud ? 15000 : 5000, { localOnly: personal, webDav: cloud?.webDav });
        form.hidden = false;
        if (start) start.hidden = true;
        if (stop) stop.hidden = false;
        if (selector) selector.disabled = true;
    }
    start?.addEventListener('click', () => run(() => connect(`${targetKey}-${selector.value}`)));
    function close() {
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
    async function refresh() {
        if (busy || !sourceKey || session || !visible) return;
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
            loadError = '无法读取本机计划与评分';
            report(loadError, 'retry');
            retry.textContent = '重试读取';
            onPlanningSync('error');
        }
        notify();
        if (sourceKey && (sourceKey !== key || config !== connection)) void refresh();
    }
    if (personal) {
        const setContext = (key, period, day, savedConfig, show) => {
            const changed = date.value !== day || statsPeriod !== period;
            const previousKey = sourceKey, previousConfig = config;
            sourceKey = key;
            visible = show;
            if (!config || ['sync_mode', 'webdav_url', 'webdav_username', 'webdav_password', 'webdav_filepath']
                .some(field => config[field] !== savedConfig?.[field])) config = savedConfig;
            statsPeriod = period;
            date.value = day;
            panel.hidden = !key || !visible || period === 'day';
            const title = panel.querySelector('h3');
            if (title) title.textContent = period === 'month' ? '月评分' : '周计划与评分';
            if (key !== previousKey || config !== previousConfig) {
                loadError = '';
                onPlanningSync('idle');
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
            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            day(day) {
                const view = snapshot();
                const week = mondayForDate(day);
                const plan = view && weeklyPlanState(view, week);
                const index = planningCalendar(day, false).cells.findIndex(cell => cell.date === day);
                return { plan: plan?.state, text: plan?.current?.days[index],
                    score: view?.daily_ratings.find(item => item.date === day && !item.deleted)?.score,
                    busy, loadError, syncFailed: isCurrent() && cloudActive && cloudState === 'error',
                    saving: busy && !opening && ratingDate === day,
                    saveError: isCurrent() && ratingDate === day && reportError ? status.textContent : '' };
            },
            rate: (day, score) => change({ kind: 'rate', date: day, score }, state?.revision),
            retryRating: retryWrite,
            reload: () => isCurrent() && session ? close() : refresh(),
            async beforeLeave(choose) {
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
        };
    }
    const settings = document.getElementById('settings-modal');
    new MutationObserver(() => { if (!settings.classList.contains('active')) void close(); })
        .observe(settings, { attributes: true, attributeFilter: ['class'] });
}
