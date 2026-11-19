import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

// 合成网络失败，使用真实页面、状态汇总和后台调度；不连接用户数据。
const bootstrap = `
window.ready = false;
window.failPlanning = false;
window.failTodos = false;
window.toasts = [];
window.polls = new Map();
let nextTimer = 1000000;
const nativeTimeout = window.setTimeout, nativeClear = window.clearTimeout;
window.setTimeout = (callback, ms, ...args) => {
    if (![60000, 120000, 240000, 480000, 900000].includes(ms)) return nativeTimeout(callback, ms, ...args);
    const id = nextTimer++; window.polls.set(id, { callback, ms }); return id;
};
window.clearTimeout = id => { window.polls.delete(id); nativeClear(id); };
window.tickPoll = () => {
    const [id, entry] = window.polls.entries().next().value;
    window.polls.delete(id); entry.callback();
};
new MutationObserver(items => { for (const item of items) for (const node of item.addedNodes)
    if (node.classList?.contains('toast-notification')) window.toasts.push(node.textContent);
}).observe(document, { childList: true, subtree: true });
const data = { version: 1, last_updated: '2026-11-15T00:00:00Z', todos: [] };
window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args) => {
    switch (command) {
    case 'get_app_config': return { sync_mode: 'webdav', webdav_url: 'https://example.test/dav/',
        webdav_username: 'example', webdav_password: 'fake', webdav_filepath: 'synthetic/todo_data.json' };
    case 'fetch_from_cloud':
        if (window.failTodos) throw 'HTTP 429'; return JSON.stringify(data);
    case 'read_personal_target': return { target: 'fixture', data: JSON.stringify(data) };
    case 'fetch_collaborations_from_cloud':
        if (window.failTodos) throw 'HTTP 429'; return '{"collaborations":[]}';
    case 'read_collaborations_data': return '{"collaborations":[]}';
    case 'get_collaborations': window.ready = true; return [];
    case 'open_personal_planning_target': return { datasetId: 'ec000000-0000-4000-8000-000000000001',
        actorId: 'ec000000-0000-4000-8000-000000000002', at: '1970-01-01T00:00:00Z' };
    case 'prepare_record_recovery_commit': return { receipt: {}, preview: {
        operation_set: 'planning/1', baseline: atob(args.request.baseline), records: [],
        journal: { records: [], pending: [], unread: [] }, dependencies: { missing: [] } } };
    case 'request_record_webdav':
        if (window.failPlanning) throw new Error('RECORD_DAV_HTTP_429');
        if (args.action === 'read_capabilities') return null;
        return '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/synthetic/' +
            args.binding.pin.namespace + 'records/</d:href></d:response></d:multistatus>';
    default: return null;
    }
} } };
`;
const browser = await browserHarness(bootstrap);
try {
    await waitFor(browser, 'window.ready');
    await browser.evaluate(`document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn').disabled && window.polls.size === 1 && document.querySelector('#sync-status').title === '同步正常'`);
    assert.equal(await browser.evaluate('[...window.polls.values()][0].ms'), 60000);
    await browser.evaluate('window.toasts = []; window.failPlanning = true; window.tickPoll()');
    await waitFor(browser, `document.querySelector('#sync-status').title.includes('HTTP_429') && window.polls.size === 1`);
    assert.equal(await browser.evaluate('[...window.polls.values()][0].ms'), 120000);
    assert.deepEqual(await browser.evaluate('window.toasts'), []);
    await browser.evaluate('window.failPlanning = false; window.tickPoll()');
    await waitFor(browser, `document.querySelector('#sync-status').title === '同步正常' && window.polls.size === 1`);
    assert.equal(await browser.evaluate('[...window.polls.values()][0].ms'), 60000);
    console.log('后台限流：显示黄灯并退避；服务恢复后自动变绿，恢复一分钟轮询');

    await browser.evaluate(`window.failPlanning = true; window.failTodos = true; document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn').disabled && window.toasts.length > 0`);
    const messages = await browser.evaluate('window.toasts');
    assert.equal(messages.length, 1);
    for (const expected of ['待办', '协作配置', '计划与评分', 'HTTP_429']) assert.ok(messages[0].includes(expected));
    assert.equal(await browser.evaluate(`document.querySelector('#manual-sync-btn').classList.contains('sync-success')`), false);
    await browser.evaluate(`window.failPlanning = false; window.failTodos = false; document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn').disabled && document.querySelector('#sync-status').title === '同步正常'`);
    console.log('手动同步多处失败仅显示一条汇总；再次同步成功后清除黄灯');
} finally { await browser.close(); }
