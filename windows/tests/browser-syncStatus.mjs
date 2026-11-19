import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

// 使用真实页面验证：冷启动直接同步，以及失败后的重试与草稿保留。
const bootstrap = `
window.fixtureReady = false;
window.failPlanningOpen = true;
window.planningOpenCalls = 0;
window.failPlanningCloud = true;
window.cloudCalls = 0;
const data = { version: 1, last_updated: '2026-11-15T00:00:00Z', todos: [] };
window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args) => {
    switch (command) {
    case 'get_app_config': return { sync_mode: 'webdav', webdav_url: 'https://example.test/dav/',
        webdav_username: 'example', webdav_password: 'fake', webdav_filepath: 'synthetic/todo_data.json' };
    case 'fetch_from_cloud': return JSON.stringify(data);
    case 'read_personal_target': return { target: 'fixture', data: JSON.stringify(data) };
    case 'read_collaborations_data':
    case 'fetch_collaborations_from_cloud': return '{"collaborations":[]}';
    case 'get_collaborations': window.fixtureReady = true; return [];
    case 'open_personal_planning_target':
        window.planningOpenCalls++;
        if (window.failPlanningOpen) throw new Error('模拟计划文件读取失败');
        return { datasetId: 'ec000000-0000-4000-8000-000000000001',
            actorId: 'ec000000-0000-4000-8000-000000000002', at: '1970-01-01T00:00:00Z' };
    case 'prepare_record_recovery_commit': return { receipt: { previous_sha256: null }, preview: {
        operation_set: 'planning/1', baseline: atob(args.request.baseline), records: [],
        journal: { records: [], pending: [], unread: [] }, dependencies: { missing: [] } } };
    case 'request_record_webdav':
        window.cloudCalls++;
        if (window.pausePlanningCloud) await new Promise(resolve => {
            window.releasePlanningCloud = () => { window.pausePlanningCloud = false; resolve(); };
        });
        if (window.failPlanningCloud) throw new Error('模拟计划云端不可达');
        if (args.action === 'read_capabilities') return null;
        return '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/synthetic/' +
            args.binding.pin.namespace + 'records/</d:href></d:response></d:multistatus>';
    default: return null;
    }
} } };
`;

// 尚未进入统计页时，也必须建立计划会话并等待云端同步完成。
for (const cloudUnavailable of [false, true]) {
    const coldBrowser = await browserHarness(bootstrap + `window.failPlanningOpen = false;
        window.failPlanningCloud = ${cloudUnavailable}; window.pausePlanningCloud = true;`);
    try {
        await waitFor(coldBrowser, 'window.fixtureReady');
        assert.equal(await coldBrowser.evaluate('window.planningOpenCalls'), 0);
        await coldBrowser.evaluate(`document.querySelector('#manual-sync-btn').click()`);
        await waitFor(coldBrowser, 'Boolean(window.releasePlanningCloud)');
        assert.ok(await coldBrowser.evaluate(`document.querySelector('#manual-sync-btn').disabled`),
            '待办同步完成后仍须等待计划与评分同步');
        assert.equal(await coldBrowser.evaluate(`document.querySelector('#manual-sync-btn').classList.contains('sync-success')`), false);
        await coldBrowser.evaluate('window.releasePlanningCloud()');
        await waitFor(coldBrowser, `!document.querySelector('#manual-sync-btn').disabled`);
        assert.equal(await coldBrowser.evaluate('window.planningOpenCalls'), 1,
            '冷启动直接同步必须加载计划与评分，不能依赖进入统计页');
        assert.ok(await coldBrowser.evaluate('window.cloudCalls > 0'), '同步成功前必须实际访问计划云端');
        assert.equal(await coldBrowser.evaluate(`document.querySelector('#manual-sync-btn').classList.contains('sync-success')`), !cloudUnavailable);
        assert.equal(await coldBrowser.evaluate(`document.querySelector('#sync-status').classList.contains('error')`), cloudUnavailable);
        if (cloudUnavailable) assert.ok(await coldBrowser.evaluate(`document.querySelector('#sync-status').title.includes('计划与评分云端目录读取失败')`));
        console.log(`冷启动未进入统计页，手动同步等待计划与评分，并正确显示${cloudUnavailable ? '失败' : '成功'}`);
    } finally {
        await coldBrowser.close();
    }
}

const browser = await browserHarness(bootstrap);

try {
    await waitFor(browser, 'window.fixtureReady');
    await browser.evaluate(`document.querySelector('#stats-btn').click()`);
    await waitFor(browser, `document.querySelector('#sync-status').classList.contains('error')`);
    await browser.evaluate(`document.querySelector('#tab-today').click()`);
    await browser.evaluate(`document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn svg').classList.contains('sync-spin')`);
    assert.equal(await browser.evaluate(`document.querySelector('#manual-sync-btn').classList.contains('sync-success')`), false,
        '计划同步失败时，总同步按钮不能显示成功');
    assert.ok(await browser.evaluate(`document.querySelector('#sync-status').title.includes('计划')`),
        '持续黄灯必须说明失败的是计划与评分');
    assert.ok(await browser.evaluate(`document.querySelector('#sync-status').title.includes('模拟计划文件读取失败')`),
        '计划初始化失败必须保留原始错误，不能被笼统的读取失败覆盖');
    assert.ok(await browser.evaluate('window.planningOpenCalls > 1'), '手动同步应重试失败的计划读取');
    assert.ok(await browser.evaluate(`[...document.querySelectorAll('.toast-notification')].some(node => node.textContent.includes('计划'))`),
        '在待办列表手动同步必须说明失败原因');
    await browser.evaluate(`document.querySelector('#sync-status').click()`);
    assert.ok(await browser.evaluate(`[...document.querySelectorAll('.toast-notification')].some(node => node.textContent === document.querySelector('#sync-status').title)`));

    // 本机读取恢复后，继续覆盖云端同步失败与恢复。
    await browser.evaluate(`window.failPlanningOpen = false; document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `document.querySelector('#sync-status').title.includes('云端目录读取失败')`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn').disabled`);
    await browser.evaluate(`document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn').disabled`);
    assert.equal(await browser.evaluate(`document.querySelector('#manual-sync-btn').classList.contains('sync-success')`), false);
    await browser.evaluate(`window.failPlanningCloud = false; document.querySelector('#manual-sync-btn').click()`);
    await waitFor(browser, `document.querySelector('#manual-sync-btn').classList.contains('sync-success')`);
    await waitFor(browser, `document.querySelector('#sync-status').title === '同步正常'`);

    // 重试当前会话必须保留编辑草稿。
    await browser.evaluate(`document.querySelector('#stats-btn').click()`);
    await browser.evaluate(`document.querySelector('#stats-period-week').click()`);
    await waitFor(browser, `[...document.querySelectorAll('#stats-planning button')].some(node => node.textContent === '查看本周详情')`);
    await browser.evaluate(`[...document.querySelectorAll('#stats-planning button')].find(node => node.textContent === '查看本周详情').click()`);
    await waitFor(browser, `Boolean(document.querySelector('#stats-planning textarea:not(:disabled)'))`);
    await browser.evaluate(`(() => {
        const input = document.querySelector('#stats-planning textarea:not(:disabled)');
        input.value = '尚未保存的周计划'; input.dispatchEvent(new Event('input', { bubbles: true }));
        window.failPlanningCloud = true; document.querySelector('#manual-sync-btn').click();
    })()`);
    await waitFor(browser, `!document.querySelector('#manual-sync-btn').disabled`);
    assert.equal(await browser.evaluate(`document.querySelector('#stats-planning textarea:not(:disabled)').value`), '尚未保存的周计划');
    assert.equal(await browser.evaluate(`document.querySelector('#manual-sync-btn').classList.contains('sync-success')`), false);
    console.log('计划读取与云端失败有明确原因，手动重试恢复后清灯，且不丢失周计划草稿');
} finally {
    await browser.close();
}
