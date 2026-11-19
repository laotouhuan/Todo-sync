import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

const browser = await browserHarness(`
    const now = new Date();
    const day = now.toLocaleDateString('sv-SE');
    now.setHours(0, 30, 0, 0);
    const midnight = now.toISOString();
    const base = { date: day, completed: false, created_at: midnight, updated_at: midnight, target_count: null, subtasks: [] };
    let data = JSON.stringify({ version: 1, todos: [
        { ...base, id: 'one', content: '普通完成', completed: true, completed_at: midnight },
        { ...base, id: 'two', content: '凌晨周打卡', task_type: 'weekly_checkin', completed_dates: [midnight] },
        { ...base, id: 'three', content: '月打卡', task_type: 'monthly_checkin', completed_dates: [midnight] },
        { ...base, id: 'four', content: '补录日期', task_type: 'monthly_checkin', completed_dates: [day] }
    ] });
    window.__TAURI__ = { core: { invoke: async (command, args) => {
        if (command === 'get_app_config') return { sync_mode: 'local' };
        if (command === 'read_personal_target') return { target: 'fixture', data };
        if (command === 'read_todo_data') return data;
        if (command === 'write_todo_data') { data = args.data; return; }
        if (command === 'get_collaborations') return [];
        return null;
    } }, event: { listen: async () => () => {} } };
`);

try {
    const click = selector => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const marks = selector => browser.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(mark =>
        [mark.tagName, mark.getAttribute('fill'), mark.points?.numberOfItems ?? 0].join('/')).sort()`);
    await waitFor(browser, '!!document.querySelector("#todo-list .todo-item")');
    await click('#stats-btn');
    await waitFor(browser, 'document.querySelector(".timeline-undated summary")?.textContent === "无具体时间 · 1 条"');
    assert.equal(await browser.evaluate('document.querySelector(".timeline-undated").open'), false);
    assert.match(await browser.evaluate('document.querySelector("#stats-summary-text").textContent'), /已完成 4 项/);
    const expected = ['circle/#10B981/0', 'polygon/#6366F1/4', 'polygon/#F43F5E/10'];
    assert.deepEqual(await marks('[data-stats-mark] > *'), expected);
    assert.deepEqual(await marks('#efficiency-clock-group .task-dot'), expected);
    await click('.timeline-undated summary');
    await click('.timeline-undated button');
    assert.equal(await browser.evaluate('document.querySelector("#edit-content").value'), '补录日期');
    await click('#modal-back-btn');
    await click('#filter-monthly');
    await waitFor(browser, '!document.querySelector(".timeline-undated")');
    assert.equal((await marks('#efficiency-clock-group .task-dot')).length, 2);
    await click('#filter-monthly');
    await click('#stats-period-week');
    await waitFor(browser, '!!document.querySelector(".timeline-toggle")');
    await click('.timeline-toggle');
    await waitFor(browser, '!!document.querySelector(".timeline-lines-scroll")');
    assert.deepEqual(await marks('.timeline-lines-scroll [role=button]:is(circle,polygon)'), expected);
    assert.equal(await browser.evaluate('document.querySelectorAll(".timeline-undated button").length'), 1);
    await click('.timeline-undated button');
    await click('#edit-checkin-grid .checkin-grid-cell.checked');
    assert.equal(await browser.evaluate('document.querySelector("#dropdown-time").value'), '');
    await browser.evaluate('document.querySelector("#dropdown-time").value = "15:30"');
    await click('#dropdown-save');
    await click('#modal-save-btn');
    await waitFor(browser, '!document.querySelector("#edit-modal").classList.contains("active") && !document.querySelector(".timeline-undated")');
    assert.equal((await marks('.timeline-lines-scroll [role=button]:is(circle,polygon)')).length, 4);
    assert.match(await browser.evaluate('document.querySelector("#stats-summary-text").textContent'), /已完成 4 项/);
    console.log('PASS 跨午夜归属、纯日期计数与编辑、筛选及两种图表的任务标记');
} finally {
    await browser.close();
}
