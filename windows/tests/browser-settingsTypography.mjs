import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

const browser = await browserHarness(`
    const now = new Date();
    const data = JSON.stringify({ version: 1, todos: [{
        id: 'fixture', content: '整理本周课程笔记 ' + 'LongTaskName'.repeat(8),
        date: now.toLocaleDateString('sv-SE'), completed: false, label: '学习',
        created_at: now.toISOString(), updated_at: now.toISOString(), subtasks: []
    }] });
    window.__TAURI__ = {
        core: { invoke: async command => {
            if (command === 'get_app_config') return { sync_mode: 'local' };
            if (command === 'read_personal_target') return { target: 'fixture', data };
            if (command === 'read_todo_data') return data;
            if (command === 'get_collaborations') return [];
            if (command === 'get_app_version') return 'test';
            return null;
        } },
        event: { listen: async () => () => {} }
    };
`);

try {
    await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: false });
    await waitFor(browser, '!!document.querySelector("#panel-labels h3")');
    await browser.evaluate('document.getElementById("settings-btn").click()');
    await waitFor(browser, 'document.getElementById("current-version-text").textContent.includes("vtest")');
    const mismatches = await browser.evaluate(`(async () => {
        const issues = [];
        const sample = document.createElement('p');
        document.body.append(sample);
        const defaultColor = getComputedStyle(sample).color;
        sample.style.color = 'var(--text-primary)';
        if (defaultColor !== getComputedStyle(sample).color) issues.push('新增正文未继承主题色');
        function check(selector, role, color = 'primary') {
            sample.style.font = 'var(--ui-' + role + ')';
            sample.style.color = 'var(--text-' + color + ')';
            const element = document.querySelector(selector);
            if (!element?.getClientRects().length) { issues.push(selector + ' 不可见'); return; }
            const actual = getComputedStyle(element), expected = getComputedStyle(sample);
            for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']) {
                if (actual[key] !== expected[key]) issues.push(selector + ' ' + key + ' = ' + actual[key]);
            }
        }
        function open(panel) {
            document.querySelector('.settings-tab-btn[data-target="panel-' + panel + '"]').click();
        }
        function appearance(selector, properties) {
            const style = getComputedStyle(document.querySelector(selector));
            return properties.map(key => style[key]).join('|');
        }
        const buttonPaint = ['backgroundColor', 'borderColor', 'borderRadius', 'color'];
        const cardPaint = ['backgroundColor', 'borderColor', 'borderWidth', 'borderRadius'];
        const popupPaint = [...cardPaint, 'boxShadow'];
        const fieldPaint = [...cardPaint, 'color'];
        const field = appearance('#setting-nickname', fieldPaint);
        const modalPaint = [...popupPaint, 'paddingTop'];
        const shell = appearance('#settings-modal .modal-content', modalPaint);
        function checkField(selector) {
            if (appearance(selector, fieldPaint) !== field) issues.push(selector + ' 表单外观不一致');
        }
        const primary = appearance('#settings-save-btn', buttonPaint);
        const secondary = appearance('#settings-cancel-btn', buttonPaint);
        if (primary === secondary) issues.push('设置主次操作无法区分');
        check('#settings-modal-title', 'title');
        check('#panel-about .setting-heading', 'heading');
        check('#current-version-text', 'note', 'secondary');
        open('reminder');
        document.querySelector('#add-global-rule-btn').click();
        document.querySelector('.rule-header').click();
        const card = appearance('.global-rule-card', cardPaint);
        checkField('.rule-body-input');
        checkField('.rule-condition-select');
        check('.rule-time-label', 'heading');
        check('.rule-detail span.setting-hint', 'note', 'secondary');
        open('pref');
        check('#setting-default-insertion', 'body');
        check('#panel-pref .setting-hint', 'note', 'secondary');
        open('labels');
        check('#panel-labels h3', 'heading');
        check('#panel-labels .label-actions button', 'body');
        check('#panel-labels p.setting-hint', 'note', 'secondary');
        if (appearance('#panel-labels button:disabled', ['opacity']) === '1') issues.push('未选择任务时禁用按钮缺少视觉反馈');
        const group = [...document.querySelectorAll('#panel-labels [aria-pressed]')].find(node => node.textContent.includes('学习'));
        group.click();
        await new Promise(requestAnimationFrame);
        if (appearance('#panel-labels [aria-pressed="true"]', ['borderColor']) === appearance('#backup-btn', ['borderColor']))
            issues.push('当前选中的标签缺少视觉反馈');
        open('collab');
        check('#panel-collab .divider-with-text', 'heading');
        check('#collab-list .setting-hint', 'note', 'secondary');
        open('sync');
        check('#panel-sync .divider-with-text', 'heading');
        check('#setting-sync-mode', 'body');
        check('#backup-btn', 'body');
        document.querySelector('#settings-cancel-btn').click();
        check('.todo-content', 'body');
        const task = document.querySelector('.todo-content');
        if (task.getBoundingClientRect().right > innerWidth || task.scrollWidth > task.clientWidth + 1)
            issues.push('窄窗口长任务名溢出');
        document.querySelector('.edit-btn').click();
        check('#edit-modal-title', 'title');
        check('#edit-content', 'body');
        document.querySelector('#edit-content').blur();
        checkField('#edit-content');
        checkField('#edit-task-type');
        if (appearance('#edit-modal .modal-content', modalPaint) !== shell) issues.push('编辑弹窗外观不一致');
        const body = document.querySelector('#edit-modal .modal-body');
        for (const section of body.querySelectorAll('details')) section.open = true;
        body.scrollTop = body.scrollHeight;
        if (!body.scrollTop || body.scrollWidth > body.clientWidth + 1) issues.push('窄窗口编辑区滚动异常');
        if (appearance('#modal-save-btn', buttonPaint) !== primary || appearance('#modal-back-btn', buttonPaint) !== secondary)
            issues.push('编辑和设置的主次操作样式不一致');
        if ([primary, secondary].includes(appearance('#modal-delete-btn', buttonPaint))) issues.push('编辑删除操作缺少危险色');
        const type = document.querySelector('#edit-task-type');
        type.value = 'weekly_checkin';
        type.dispatchEvent(new Event('change'));
        document.querySelector('#edit-checkin-grid .checkin-grid-cell').click();
        checkField('#dropdown-date');
        if (appearance('#dropdown-date', ['minHeight']) === appearance('#edit-content', ['minHeight'])) issues.push('打卡日期框应保留紧凑尺寸');
        if (appearance('#dropdown-save', buttonPaint) !== primary) issues.push('打卡主操作样式不一致');
        if (appearance('.checkin-dropdown', popupPaint) !== appearance('#clock-tooltip', popupPaint)) issues.push('打卡与钟面浮层外观不一致');
        document.querySelector('#dropdown-close').click();
        document.querySelector('#modal-back-btn').click();
        document.querySelector('#stats-btn').click();
        await new Promise(requestAnimationFrame);
        check('.stats-summary-bar h3', 'heading');
        check('#stats-learning-summary .ui-note', 'note', 'secondary');
        for (const selector of ['.stats-summary-bar', '.time-distribution-card', '.learning-card', '.health-grade-card', '.metric-card'])
            if (appearance(selector, cardPaint) !== card) issues.push(selector + ' 卡片底色、边框或圆角不一致');
        if (appearance('#stats-learning-summary button', buttonPaint) !== secondary) issues.push('学习详情入口次要按钮样式不一致');
        document.querySelector('#stats-learning-summary button').click();
        check('dialog[open] h3', 'title');
        if (appearance('dialog[open]', modalPaint) !== shell) issues.push('学习弹窗外观不一致');
        document.querySelector('dialog[open]').close();
        const { timeSlotColors } = await import('/statsTimeline.js');
        const palette = Object.values(timeSlotColors);
        const clock = document.querySelector('#efficiency-clock-group');
        if ([...clock.querySelectorAll('.clock-quadrant')].map(n => n.getAttribute('stroke')).join() !== palette.join() ||
            [...clock.querySelectorAll('text')].filter(n => n.textContent.includes('%')).map(n => n.getAttribute('fill')).join() !== palette.join())
            issues.push('钟面圆弧与时段标注的配色不一致');
        document.querySelector('#stats-period-week').click();
        await new Promise(requestAnimationFrame);
        document.querySelector('.timeline-toggle').click();
        const lines = [...document.querySelectorAll('.timeline-lines-scroll line')];
        if (lines.length !== 7 * 4 || lines.some((line, i) => line.getAttribute('stroke') !== palette[i % 4]))
            issues.push('周时间线的时段配色不一致');
        document.querySelector('[data-subtab="health"]').click();
        await new Promise(requestAnimationFrame);
        check('.throughput-title', 'heading');
        check('#stats-health .ui-note', 'note', 'secondary');
        const { createPeriodTaskView } = await import('/periodTaskView.js');
        createPeriodTaskView({ state: { todoData: { todos: [] } } }).openImport('week');
        check('dialog[open] h3', 'title');
        check('dialog[open] .period-help', 'note', 'secondary');
        const search = document.querySelector('dialog[open] input[type=search]');
        search.blur();
        checkField('dialog[open] input[type=search]');
        search.focus();
        const focus = getComputedStyle(search);
        if (!search.matches(':focus-visible') || focus.outlineStyle !== 'solid' || focus.outlineWidth === '0px')
            issues.push('周期弹窗的搜索框缺少焦点标记');
        if (getComputedStyle(search, '::placeholder').color !== getComputedStyle(document.querySelector('#setting-nickname'), '::placeholder').color)
            issues.push('动态搜索框的占位文字颜色不一致');
        document.querySelector('dialog[open]').close();
        sample.remove();
        return issues;
    })()`);
    assert.deepEqual(mismatches, []);
    // 使用实际的设置按钮，检查鼠标、键盘和按下状态。
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await browser.evaluate('document.querySelector("#settings-btn").click()');
    await waitFor(browser, `(() => {
        const button = document.querySelector('#settings-save-btn');
        const r = button.getBoundingClientRect();
        const panel = document.querySelector('#settings-modal.active .modal-content');
        return panel && new DOMMatrix(getComputedStyle(panel).transform).isIdentity &&
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button;
    })()`);
    const save = 'document.querySelector("#settings-save-btn")';
    const background = await browser.evaluate('getComputedStyle(' + save + ').backgroundColor');
    const point = await browser.evaluate('(() => { const r = ' + save + '.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await waitFor(browser, 'getComputedStyle(' + save + ').backgroundColor !== ' + JSON.stringify(background));
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
    assert.notEqual(await browser.evaluate('getComputedStyle(' + save + ').boxShadow'), 'none');
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', x: 0, y: 0 });
    await browser.evaluate('document.querySelector("#settings-cancel-btn").focus()');
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', windowsVirtualKeyCode: 9 });
    assert.ok(await browser.evaluate(save + '.matches(":focus-visible") && getComputedStyle(' + save + ').outlineStyle === "solid"'));
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', windowsVirtualKeyCode: 9 });
    console.log('PASS 窄窗表单与弹窗、滚动区域、钟面与纵向时间线时段配色');
    console.log('PASS 主次与危险按钮、交互状态、统计卡片与浮层');
    console.log('PASS 设置、列表、编辑、统计、计时与周期弹窗的文字层级及窄窗长任务名');
} finally {
    await browser.close();
}
