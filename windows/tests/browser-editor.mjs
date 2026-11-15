import assert from 'node:assert/strict';
import { browserHarness, waitFor } from './browserHarness.mjs';

const bootstrap = `
window.testErrors=[]; window.addEventListener('error',e=>testErrors.push(e.message)); window.addEventListener('unhandledrejection',e=>testErrors.push(String(e.reason)));
const now = new Date().toISOString();
window.fixture = { config: {sync_mode:'local'}, writes: [], listeners: {}, data: {version:1, todos:[{
id:'parent', content:'编辑测试', date:new Date().toLocaleDateString('sv-SE'), time:null, completed:true, completed_at:now,
created_at:now,updated_at:now,order:0,deleted:false,recurring:'none',task_type:'normal',
completed_dates:[],target_count:null,label:null,reminder:null,subtasks:[]}]}};
for(let i=0;i<299;i++) fixture.data.todos.push({...fixture.data.todos[0],id:'history-'+i,date:'2025-01-01',completed_at:'2025-01-01T00:00:00Z'});
fixture.data.time_entries=Array.from({length:300},(_,i)=>({id:'timer-'+i,created_at:now,updated_at:now,task_ref:{todo_id:i===0?'parent':'history-'+(i-1),source_type:'personal',source_id:null},started_at:new Date(Date.UTC(2026,0,1,0,i*2)).toISOString(),ended_at:new Date(Date.UTC(2026,0,1,0,i*2+1)).toISOString(),deleted:false}));
window.__TAURI__ = {core:{invoke:async (cmd,args)=>{
if (fixture.hook) { const result = await fixture.hook(cmd,args); if(result?.handled) return result.value; }
switch(cmd){
case 'get_app_config': return structuredClone(fixture.config);
case 'read_personal_target': return {target:args.config.sync_path || 'A',data:JSON.stringify(fixture.data)};
case 'activate_personal_target': fixture.config=structuredClone(args.config);fixture.data=JSON.parse(args.data);return;
case 'read_todo_data': return JSON.stringify(fixture.data);
case 'write_todo_data': fixture.data=JSON.parse(args.data);fixture.writes.push(structuredClone(fixture.data));return;
case 'read_collaborations_data': return '{"collaborations":[]}';
case 'get_collaborations': return [];
case 'get_app_version': return 'test';
default:return null;
}}},event:{listen:async(name,fn)=>{fixture.listeners[name]=fn; return ()=>{};}}};
`;
const browser = await browserHarness(bootstrap);
try {
    await waitFor(browser, `!!document.querySelector('.edit-btn')`);
    const originalTime = await browser.evaluate('fixture.data.todos[0].completed_at');
    await browser.evaluate(`document.querySelector('.edit-btn').click();document.getElementById('modal-save-btn').click();`);
    await waitFor(browser, `!document.getElementById('edit-modal').classList.contains('active')`);
    assert.equal(await browser.evaluate('fixture.data.todos[0].completed_at'), originalTime);
    await browser.evaluate(`document.querySelector('.edit-btn').click(); document.getElementById('edit-completed-date').value='2026-10-28'; document.getElementById('edit-completed-time').value='18:45'; document.getElementById('modal-save-btn').click();`);
    await waitFor(browser, `!document.getElementById('edit-modal').classList.contains('active')`);
    assert.equal(await browser.evaluate(`fixture.data.todos[0].completed_at`), '2026-10-28T10:45:00.000Z', '显式修改父任务完成时间必须持久化');
    console.log('PASS 父任务完成时间通过实际编辑界面保存');
    const precision = await browser.evaluate(`(async()=>{
        const { editTimelineSubtask }=await import('/timelineEditor.js');
        let patch;
        editTimelineSubtask({content:'任务'}, {content:'子步骤',completed_at:'2026-10-29T01:00:00.123Z'}, async value=>{patch=value;});
        await [...document.querySelector('dialog[open]').querySelectorAll('button')].find(b=>b.textContent==='保存').onclick();
        return patch.completed_at;
    })()`);
    assert.equal(precision, '2026-10-29T01:00:00.123Z', '原生控件未修改时必须保留毫秒');
    console.log('PASS 原生 datetime-local 精度');
    for (const original of [null, '2026-10-29T01:00:27.456Z', '2026-10-29T09:00:00.123+08:00']) {
        const actual = await browser.evaluate(`(async()=>{
            const {editTimelineSubtask}=await import('/timelineEditor.js');let patch;
            editTimelineSubtask({content:'任务'},{content:'子步骤',completed_at:${JSON.stringify(original)}},async value=>{patch=value;});
            await [...document.querySelector('dialog[open]').querySelectorAll('button')].find(b=>b.textContent==='保存').onclick();
            return patch.completed_at;
        })()`);
        assert.equal(actual, original);
    }
    const ime = await browser.evaluate(`(()=>{
        document.querySelector('.edit-btn').click();
        const input=document.getElementById('add-subtask-input');input.value='中文候选';
        const event=new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true});
        input.dispatchEvent(event);
        return {value:input.value,prevented:event.defaultPrevented};
    })()`);
    assert.deepEqual(ime, {value:'中文候选',prevented:false});
    console.log('PASS 中文组合输入确认');
    const clones = await browser.evaluate(`(()=>{
        const original=window.structuredClone;let count=0;
        window.structuredClone=(...args)=>{count++;return original(...args);};
        try {document.getElementById('add-subtask-input').dispatchEvent(new InputEvent('input',{bubbles:true,data:'字'}));}
        finally {window.structuredClone=original;}
        return count;
    })()`);
    assert.equal(clones, 0, '子步骤文字输入不应复制全量数据或重算计时');
    console.log('PASS 文字输入不触发全量快照');
    const typing = await browser.evaluate(`(()=>{
        const input=document.getElementById('add-subtask-input');
        const times=[];
        for(let i=0;i<20;i++){const start=performance.now();input.value+='字';input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'字'}));times.push(performance.now()-start);}
        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        const summary=document.querySelector('#edit-subtasks-section summary').textContent;
        document.querySelector('#edit-subtasks-list .subtask-checkbox').click();
        const completed=document.querySelector('#edit-subtasks-section summary').textContent;
        document.querySelector('#edit-subtasks-list .edit-subtask').click();
        const textarea=document.querySelector('#edit-subtasks-list textarea');
        const ime=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true,cancelable:true});textarea.dispatchEvent(ime);
        const composingVisible=textarea.style.display==='block'&&!ime.defaultPrevented;
        const shift=new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true});textarea.dispatchEvent(shift);
        const shiftVisible=textarea.style.display==='block'&&!shift.defaultPrevented;
        textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        document.querySelector('#edit-subtasks-list .delete-subtask').click();
        return {max:Math.max(...times),summary,completed,composingVisible,shiftVisible,empty:document.querySelector('#edit-subtasks-section summary').textContent};
    })()`);
    assert.equal(typing.summary,'子步骤／备注：0/1'); assert.equal(typing.completed,'子步骤／备注：1/1');
    assert.ok(typing.composingVisible && typing.shiftVisible);assert.equal(typing.empty,'添加子步骤／备注');
    console.log(`PASS 300 任务 / 300 计时，20 次输入最大耗时 ${typing.max.toFixed(2)} ms；摘要与行内输入法行为正常`);
    const beforeWrites=await browser.evaluate('fixture.writes.length');
    await browser.evaluate(`document.getElementById('modal-save-btn').click()`);
    await waitFor(browser, `!document.getElementById('edit-modal').classList.contains('active')`);
    assert.equal(await browser.evaluate('fixture.writes.length'),beforeWrites,'无变化保存不应重复写入');
    console.log('PASS 无变化保存不写入');
    await browser.evaluate(`document.getElementById('settings-btn').click()`);
    await waitFor(browser, `document.getElementById('setting-sync-mode').value==='local'`);
    await browser.evaluate(`
        fixture.nextData={version:1,todos:[{...fixture.data.todos[0],id:'B',content:'B原任务',completed:false,completed_at:null}],reminder_settings:{updated_at:null,enabled:true,privacy_mode:false,global_rules:[]}};
        fixture.hook=async(cmd,args)=>{
            if(cmd==='read_personal_target'&&args.config.sync_path==='B')return {handled:true,value:{target:'B',data:JSON.stringify(fixture.nextData)}};
            if(cmd==='activate_personal_target'&&args.config.sync_path==='B'){
                fixture.oldData=structuredClone(fixture.data);fixture.config=structuredClone(args.config);fixture.data=structuredClone(fixture.nextData);return {handled:true};
            }
        };
        document.getElementById('setting-sync-path').value='B';
        document.getElementById('setting-privacy-mode').value='true';
        document.getElementById('settings-save-btn').click();
    `);
    await waitFor(browser, `fixture.config.sync_path==='B' && !document.getElementById('settings-save-btn').disabled`);
    assert.deepEqual(await browser.evaluate(`fixture.data.todos.map(t=>t.content)`), ['B原任务']);
    assert.equal(await browser.evaluate('fixture.oldData.reminder_settings.privacy_mode'),true);
    assert.equal(await browser.evaluate('fixture.data.reminder_settings.privacy_mode'),false);
    console.log('PASS 实际设置保存先交接目标，提醒修改属于旧清单');
    await browser.evaluate(`fixture.hook=async cmd=>{if(cmd==='write_todo_data')throw new Error('模拟磁盘失败');};document.getElementById('todo-input').value='失败后保留的输入';document.getElementById('add-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await waitFor(browser, `document.body.innerText.includes('新增失败')`);
    assert.equal(await browser.evaluate(`document.getElementById('todo-input').value`),'失败后保留的输入');
    assert.deepEqual(await browser.evaluate(`fixture.data.todos.map(t=>t.content)`),['B原任务']);
    console.log('PASS 实际新增失败保留输入');
} catch(error) { console.error(await browser.evaluate(`({url:location.href,errors:window.testErrors,text:document.body?.innerText.slice(0,500)})`)); throw error; }
finally { await browser.close(); }

