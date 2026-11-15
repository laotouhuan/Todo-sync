import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

// 独立浏览器配置和固定测试数据，不读取真实缓存或连接云端。
const bootstrap = `
window.testErrors = [];
window.addEventListener('error', event => testErrors.push(event.message));
window.addEventListener('unhandledrejection', event => testErrors.push(String(event.reason)));
const task = {id:'current',content:'当前清单的任务',date:null,time:null,completed:false,completed_at:null,
created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',order:0,deleted:false,
recurring:'none',task_type:'normal',completed_dates:[],target_count:null,label:null,reminder:null,subtasks:[]};
window.fixture = {
config:{sync_mode:'webdav',webdav_filepath:'测试目录/todo_data.json'},loaded:false,writes:[],
data:JSON.parse(localStorage.getItem('fixture-current') || JSON.stringify({version:1,todos:[task]})),
legacy:{version:1,todos:Array.from({length:20},(_,i)=>({...task,id:'old-'+i,
content:(localStorage.getItem('fixture-old-name') || '旧版测试任务')+i}))}
};
window.__TAURI__ = {core:{invoke:async (command,args)=>{
switch(command){
case 'get_app_config':return structuredClone(fixture.config);
case 'read_personal_target':return {target:'A',data:JSON.stringify(fixture.data),legacy_data:JSON.stringify(fixture.legacy)};
case 'fetch_from_cloud':return JSON.stringify(fixture.data);
case 'write_todo_data':fixture.data=JSON.parse(args.data);fixture.writes.push(args.data);localStorage.setItem('fixture-current',args.data);return;
case 'read_collaborations_data':case 'fetch_collaborations_from_cloud':return '{"collaborations":[]}';
case 'get_collaborations':fixture.loaded=true;return [];
case 'get_app_version':return 'test';
default:return null;
}}},event:{listen:async()=>()=>{}}};
`;

const browser = await browserHarness(bootstrap);
try {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 600, deviceScaleFactor: 1, mobile: false });
    await waitFor(browser, 'window.fixture?.loaded && !!document.getElementById("legacy-cache-notice")');
    await browser.evaluate(`document.querySelector('#legacy-cache-notice button:last-child').click()`);
    assert.equal(await browser.evaluate(`!!document.getElementById('legacy-cache-notice')`), false);
    await browser.send('Page.reload');
    await waitFor(browser, 'window.fixture?.loaded');
    assert.equal(await browser.evaluate(`!!document.getElementById('legacy-cache-notice')`), false, '实际页面重载后不能再次提醒');
    console.log('PASS 不再提醒的选择跨页面重载保留');

    await browser.evaluate(`document.getElementById('settings-btn').click()`);
    await waitFor(browser, `document.getElementById('setting-sync-mode').value==='webdav'`);
    await browser.evaluate(`document.querySelector('.settings-tab-btn[data-target="panel-sync"]').click();document.getElementById('legacy-cache-btn').click()`);
    await waitFor(browser, `!!document.querySelector('.legacy-cache-dialog[open]')`);
    const layout = await browser.evaluate(`(()=>{
        const dialog=document.querySelector('.legacy-cache-dialog');
        const bounds=dialog.getBoundingClientRect();
        return {count:dialog.querySelector('pre').textContent.split('\\n').length,
            fits:dialog.scrollWidth<=dialog.clientWidth,
            buttons:[...dialog.querySelectorAll('button')].every(button=>{
                const box=button.getBoundingClientRect();return box.left>=bounds.left && box.right<=bounds.right;
            })};
    })()`);
    assert.deepEqual(layout, { count: 20, fits: true, buttons: true }, '400px 窗口内预览及按钮不能横向溢出');
    await browser.evaluate(`document.querySelector('.legacy-cache-actions button:last-child').click();document.getElementById('settings-cancel-btn').click()`);
    assert.equal(await browser.evaluate('fixture.writes.length'), 0, '保留缓存不应写入当前清单');
    console.log('PASS 设置入口可重新查看，窄窗口中的预览和按钮正常');

    await browser.evaluate(`localStorage.setItem('fixture-old-name','旧缓存有更新')`);
    await browser.send('Page.reload');
    await waitFor(browser, 'window.fixture?.loaded && !!document.getElementById("legacy-cache-notice")');
    await browser.evaluate(`document.querySelector('#legacy-cache-notice button').click();document.querySelector('.legacy-cache-actions button').click()`);
    await waitFor(browser, `fixture.writes.length===1 && !document.querySelector('.legacy-cache-dialog[open]')`);
    assert.equal(await browser.evaluate(`fixture.data.todos.filter(task=>task.id.startsWith('old-')).length`), 20);
    await browser.send('Page.reload');
    await waitFor(browser, 'window.fixture?.loaded');
    assert.equal(await browser.evaluate(`!!document.getElementById('legacy-cache-notice')`), false);
    assert.deepEqual(await browser.evaluate('testErrors'), []);
    console.log('PASS 旧缓存变化会重新提示，合并成功后重载不再提示');
} catch (error) {
    console.error(await browser.evaluate(`({errors:window.testErrors,text:document.body?.innerText.slice(0,500)})`));
    throw error;
} finally { await browser.close(); }
