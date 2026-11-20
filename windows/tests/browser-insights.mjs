import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

const browser = await browserHarness(`
window.__TAURI__ = { core: { invoke: async () => null }, event: { listen: async () => () => {} } };
`);
try {
    await waitFor(browser, '!!document.querySelector("#stats-learning-summary")');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate(`(async () => {
        const { createLearningView } = await import('/learningView.js');
        document.getElementById('learning-insights')?.remove();
        const state = { activeSource: { type: 'personal' }, personalTarget: '本机', appConfig: {},
            todoData: { todos: [], time_entries: [], daily_reviews: [] },
            statsPeriod: 'day', statsTargetDate: new Date('2026-01-01T12:00:00') };
        const listeners = new Set();
        const fixture = window.insightFixture = {
            state, rating: null, failRating: false, failReview: false, ratingWrites: 0, reviewWrites: 0,
            notify: () => listeners.forEach(listener => listener())
        };
        const controller = {
            day: () => ({ plan: 'current', text: '长计划 '.repeat(160), score: fixture.rating?.score,
                rating: fixture.rating, saveError: fixture.failRating ? '评分未保存' : '' }),
            subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
            hasPendingWrite: () => false,
            rate: async (date, score, expected) => {
                if (fixture.failRating || expected !== fixture.rating) return false;
                fixture.ratingWrites++;
                fixture.rating = { date, score };
                fixture.notify();
                return true;
            }
        };
        fixture.ui = createLearningView({
            state, planning: () => controller,
            commit: async change => {
                if (fixture.failReview) throw new Error('复盘保存失败');
                const candidate = structuredClone(state.todoData);
                change(candidate);
                fixture.reviewWrites++;
                state.todoData = candidate;
                fixture.ui.renderStats();
            },
            openWeek: date => { fixture.navigated = date; }
        });
        document.querySelector('main').hidden = false;
        document.getElementById('stats-container').classList.remove('hidden');
        fixture.ui.install();
        fixture.ui.renderStats();
        window.insightClick = (selector, name) => [...document.querySelectorAll(selector)]
            .find(node => node.textContent.trim() === name)?.click();
    })()`);
    assert.equal(await browser.evaluate('document.querySelectorAll("#stats-learning-summary button").length'), 1);
    assert.equal(await browser.evaluate('!!document.querySelector("#daily-review-card").textContent.includes("查看周计划")'), false);
    assert.equal(await browser.evaluate('document.querySelectorAll("#daily-review-card .planning-score-choices button").length'), 5);
    await browser.evaluate(`insightFixture.failRating = true; insightFixture.notify();
        insightClick('#daily-review-card button', '4 分');`);
    await waitFor(browser, 'document.querySelector("#daily-review-card").textContent.includes("评分未保存")');
    assert.equal(await browser.evaluate('insightFixture.ratingWrites'), 0);
    await browser.evaluate('insightFixture.failRating = false; insightFixture.notify()');
    await browser.evaluate('insightClick("#daily-review-card button", "4 分")');
    await waitFor(browser, 'document.querySelector("#daily-review-card .daily-rating-badge")?.textContent === "4"');
    const dailyFill = await browser.evaluate('getComputedStyle(document.querySelector(".daily-rating-badge")).backgroundColor');
    assert.equal(await browser.evaluate('document.querySelectorAll("#daily-review-card .planning-score-choices button").length'), 0);

    await browser.evaluate(`insightClick('#daily-review-card button', '编辑');
        insightClick('dialog[open] button', '清除评分');
        const field = document.querySelector('dialog[open] textarea');
        field.value = '保存草稿'; field.focus(); field.setSelectionRange(2, 2);
        insightFixture.notify();
        window.unchangedField = document.activeElement === field && field.selectionStart === 2;
        insightFixture.failReview = true;
        insightClick('dialog[open] button', '保存');`);
    await waitFor(browser, 'document.querySelector("dialog[open] .learning-error")?.textContent.includes("评分已保存。复盘保存失败")');
    assert.equal(await browser.evaluate('window.unchangedField'), true);
    assert.equal(await browser.evaluate('document.querySelector("dialog[open] textarea").value'), '保存草稿');
    assert.equal(await browser.evaluate('insightFixture.ratingWrites'), 2);
    await browser.evaluate(`insightFixture.failReview = false; insightClick('dialog[open] button', '查看周计划');`);
    await waitFor(browser, '[...document.querySelectorAll("dialog[open] button")].some(button => button.textContent === "保存并前往")');
    await browser.evaluate('insightClick("dialog[open] button", "保存并前往")');
    await waitFor(browser, 'insightFixture.navigated === "2026-01-01"');
    assert.equal(await browser.evaluate('insightFixture.ratingWrites'), 2, '重试不得重写成功的评分');
    assert.equal(await browser.evaluate('insightFixture.reviewWrites'), 1);
    await browser.evaluate(`(async () => {
        const { bindRecordSandbox } = await import('/recordSandboxSettings.js');
        const { planningChange } = await import('/weeklyPlanning.js');
        const week = '2025-12-29', at = week + 'T09:00:00Z';
        const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
        const record = { id: id(3), created_at: at, parents: [], operations: [planningChange({}, {
            kind: 'save', week, tips: [], versionId: id(4), focus: '短重点',
            days: ['周一全文', '', '', '', '', '', ''], reason: ''
        }, { id: id(3), at })] };
        const panel = document.getElementById('stats-planning');
        const saved = new Map([[id(1), [record]]]);
        const candidate = (current, intent) => [...current, { ...intent,
            parents: current.length ? [{ id: current.at(-1).id }] : [] }];
        for (const [index, date] of ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'].entries()) {
            const recordId = id(index + 10);
            const operation = planningChange({}, { kind: 'rate', date, score: index + 1 }, { id: recordId, at });
            saved.set(id(1), candidate(saved.get(id(1)), { id: recordId, created_at: at, operations: [operation] }));
        }
        window.focusFixture = { nativeConfirmError: '', capabilities: false, upgraded: false, cloudWrites: [] };
        const aclError = 'Command plugin:dialog|confirm not allowed by ACL';
        window.confirm = () => Promise.reject(new Error(aclError));
        window.addEventListener('unhandledrejection', event => {
            if (event.reason?.message === aclError) focusFixture.nativeConfirmError = aclError;
        });
        const invoke = async (command, args) => {
            if (command === 'open_personal_planning_target') return {
                datasetId: args.target === 'weekly-fixture' ? id(1) : id(5), actorId: id(2), at
            };
            if (command === 'prepare_record_recovery_commit') {
                const { pin, baseline, descriptor, intent } = args.request;
                const { operation_set } = JSON.parse(atob(descriptor));
                const current = saved.get(pin.dataset_id) ?? [];
                const records = intent ? candidate(current, intent) : current;
                return { receipt: { previous_sha256: String(current.length), candidate_sha256: String(records.length) }, preview: {
                    operation_set, baseline: atob(baseline), records: records.map(item => JSON.stringify(item)),
                    journal: { records: [], pending: [], unread: [] }, dependencies: { missing: [] }
                } };
            }
            if (command === 'commit_record_recovery') {
                const { pin, descriptor, intent } = args.request;
                if (intent) {
                    saved.set(pin.dataset_id, candidate(saved.get(pin.dataset_id) ?? [], intent));
                    if (JSON.parse(atob(descriptor)).operation_set === 'planning/1') focusFixture.cloudWrites.push(intent.operations[0]);
                }
                return;
            }
            if (command === 'initialize_planning_webdav') return;
            if (command === 'request_record_webdav') {
                const { action, binding } = args;
                const root = '/dav/fixture/' + binding.pin.namespace;
                const xml = path => '<d:multistatus xmlns:d="DAV:"><d:response><d:href>' + root + path +
                    '</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>' +
                    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
                if (action === 'list') return xml('records/');
                if (action === 'read_capabilities') return focusFixture.capabilities ? xml('capabilities/') : null;
                if (action === 'read_focus') return focusFixture.upgraded ?
                    xml('capabilities/weekly-plan-focus-v1.' + binding.pin.descriptor_sha256 + '/') : null;
                if (action === 'create_capabilities') { focusFixture.capabilities = true; return; }
                if (action === 'create_focus') { focusFixture.upgraded = true; return; }
            }
            throw new Error(command);
        };
        const controller = bindRecordSandbox(document, invoke, panel);
        focusFixture.controller = controller;
        window.weekFocus = () => document.querySelector('#stats-planning .planning-fields textarea');
        window.fillWeekFocus = value => { weekFocus().value = value; weekFocus().dispatchEvent(new Event('input')); };
        controller.setContext('weekly-fixture', 'week', '2026-01-01', { sync_mode: 'local' }, true);
    })()`);
    await waitFor(browser, 'document.querySelector("#stats-planning").textContent.includes("短重点")');
    assert.equal(await browser.evaluate('document.querySelector("#stats-planning").textContent.includes("周一全文")'), false);
    assert.equal(await browser.evaluate('document.querySelectorAll("#stats-planning .record-rating-grid button").length'), 0);
    const readWeekTiles = `(() => [...document.querySelectorAll('#stats-planning .rating-calendar-cell')].map(cell =>
        [cell.textContent, cell.dataset.score ?? null, getComputedStyle(cell).backgroundColor]))()`;
    const weekTiles = await browser.evaluate(readWeekTiles);
    assert.deepEqual(weekTiles.map(tile => tile.slice(0, 2)),
        [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['', null], ['', null]]);
    assert.equal(new Set(weekTiles.map(tile => tile[2])).size, 6);
    assert.equal(weekTiles[3][2], dailyFill);
    await browser.evaluate(`focusFixture.controller.setContext('weekly-fixture', 'month', '2026-01-01', { sync_mode: 'local' }, true);`);
    const monthTile = await browser.evaluate(`(() => {
        const cell = document.querySelector('#stats-planning button[aria-label="2026-01-01 4 分"]');
        return [cell.querySelector('.rating-calendar-date').textContent, cell.querySelector('.rating-calendar-score').textContent,
            getComputedStyle(cell).backgroundColor, cell.offsetWidth, cell.offsetHeight];
    })()`);
    assert.deepEqual(monthTile.slice(0, 3), ['1', '4', dailyFill]);
    assert.ok(Math.abs(monthTile[3] - monthTile[4]) <= 1, '窄窗口内保持方形');
    assert.equal(await browser.evaluate(`document.querySelector('#stats-planning button[aria-label="2026-01-03 未评分"]').dataset.score`), undefined);
    assert.equal(await browser.evaluate(`(() => {
        const panel = document.querySelector('#stats-planning');
        let selected;
        panel.addEventListener('planning-day', event => {
            selected = event.detail; event.stopImmediatePropagation();
        }, { capture: true, once: true });
        panel.querySelector('button[aria-label="2026-01-01 4 分"]').click();
        return selected;
    })()`), '2026-01-01');
    await browser.evaluate(`focusFixture.controller.setContext('weekly-fixture', 'week', '2026-01-01', { sync_mode: 'local' }, true);`);
    await browser.evaluate('insightClick("#stats-planning button", "查看本周详情")');
    await waitFor(browser, 'document.querySelector("#stats-planning").textContent.includes("周一全文")');
    assert.equal(await browser.evaluate('document.querySelector("#stats-planning details").open'), false);
    await browser.evaluate(`focusFixture.controller.setContext('weekly-fixture', 'week', '2026-01-05', { sync_mode: 'local' }, true);
        insightClick('#stats-planning button', '查看本周详情');`);
    assert.equal(await browser.evaluate('weekFocus().disabled'), false);
    await browser.evaluate(`fillWeekFocus('直接保存的重点'); insightClick('#stats-planning button', '保存计划');`);
    await waitFor(browser, 'document.querySelector(".insight-focus")?.textContent === "直接保存的重点"');
    assert.equal(await browser.evaluate('focusFixture.nativeConfirmError'), '');

    await browser.evaluate(`focusFixture.controller.setContext('cloud-fixture', 'week', '2026-01-12', { sync_mode: 'webdav',
        webdav_url: 'https://dav.jianguoyun.com/dav/', webdav_username: 'fixture', webdav_password: 'fake',
        webdav_filepath: 'fixture/todo_data.json' }, true);`);
    await waitFor(browser, 'document.querySelector("#enable-planning-focus").disabled === false');
    const upgradeDialog = `document.querySelector('dialog[aria-label="升级云端周计划格式"]')`;
    const upgradePrompt = `${upgradeDialog}?.open === true`;
    await browser.evaluate('document.getElementById("enable-planning-focus").click()');
    await waitFor(browser, upgradePrompt);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(browser, `!${upgradeDialog}`);
    assert.equal(await browser.evaluate('focusFixture.upgraded'), false);
    await browser.evaluate(`insightClick('#stats-planning button', '查看本周详情');
        const day = document.querySelectorAll('#stats-planning .planning-fields textarea')[1];
        day.value = '旧格式安排'; day.dispatchEvent(new Event('input'));
        insightClick('#stats-planning button', '保存计划');`);
    await waitFor(browser, 'focusFixture.cloudWrites.length === 1 && !document.querySelector("#stats-planning [data-content]").disabled');
    assert.equal(await browser.evaluate('Object.hasOwn(focusFixture.cloudWrites[0].version, "focus")'), false);
    await browser.evaluate(`fillWeekFocus('云端重点草稿'); insightClick('#stats-planning button', '保存计划');`);
    await waitFor(browser, `focusFixture.nativeConfirmError || ${upgradePrompt}`);
    assert.equal(await browser.evaluate('focusFixture.nativeConfirmError'), '');
    assert.equal(await browser.evaluate(upgradePrompt), true);
    assert.equal(await browser.evaluate('focusFixture.upgraded'), false);
    await browser.evaluate(`insightClick('dialog[open] button', '取消');`);
    await waitFor(browser, `!${upgradeDialog}`);
    assert.equal(await browser.evaluate('weekFocus().value'), '云端重点草稿');
    assert.equal(await browser.evaluate('focusFixture.cloudWrites.length'), 1);
    await browser.evaluate(`insightClick('#stats-planning button', '保存计划');`);
    await waitFor(browser, upgradePrompt);
    await browser.evaluate(`insightClick('dialog[open] button', '确认升级');`);
    await waitFor(browser, 'document.querySelector(".insight-focus")?.textContent === "云端重点草稿"');
    assert.equal(await browser.evaluate('focusFixture.nativeConfirmError'), '');
    assert.equal(await browser.evaluate('focusFixture.upgraded && focusFixture.cloudWrites[1].version.focus'), '云端重点草稿');
    await browser.evaluate(`insightClick('#stats-planning button', '删除历史版本');`);
    const deletePrompt = `!!document.querySelector('dialog[open][aria-label="删除此历史版本？"]')`;
    await waitFor(browser, deletePrompt);
    await browser.evaluate(`insightClick('dialog[open] button', '取消');`);
    await waitFor(browser, `!(${deletePrompt})`);
    assert.equal(await browser.evaluate('focusFixture.cloudWrites.length'), 2);
    console.log('PASS 首次评分只读、当日回顾草稿保留、部分保存重试和历史日期跳转');
    console.log('PASS 周摘要只显示重点和只读评分，完整安排在详情内');
    console.log('PASS 本机直接保存重点，旧云端按需确认，取消保留草稿');
    console.log('PASS 日评分仅显示数字，周月共用五档颜色及日历方格');
} finally {
    await browser.close();
}
