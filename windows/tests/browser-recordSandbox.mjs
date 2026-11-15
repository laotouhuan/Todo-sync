import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { browserHarness, waitFor } from './browserHarness.mjs';

const bootstrap = `
const cloud = ${Boolean(process.env.TODO_PLANNING_CLOUD_TEST)};
const journals = new Map(), objects = new Map();
const legacyId = 'ec000000-0000-4000-8000-000000000001';
const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
if (cloud) {
    const ratingId = 'ec000000-0000-4000-8000-000000000011';
    const records = [5, null].map((score, index) => {
        const id = index === 0 ? ratingId : 'ec000000-0000-4000-8000-000000000012';
        const created_at = '2026-11-14T01:00:00Z', updated_at = '2026-11-14T01:00:0'+index+'Z';
        const record = { id, created_at: updated_at, parents: index ? [{ id: ratingId }] : [],
            operations: [{ type:'planning.rating.put', rating:{ id:ratingId,date:today,score,created_at,updated_at,deleted:false } }] };
        return { record, artifact:{ name:'records/'+id+'.'+'1'.repeat(64)+'.json', content:JSON.stringify(record) } };
    });
    journals.set(legacyId, {revision:'legacy',records,pending:records.map(({artifact})=>artifact.name)});
}
window.calls = [];
window.fixtureReady = false;
const original = {version:1,last_updated:'2026-11-09T00:00:00Z',todos:[]};
window.__TAURI__ = {event:{listen:async()=>()=>{}},core:{invoke:async (command,args)=>{
    window.calls.push(command);
    const target = args?.request?.pin?.dataset_id ?? args?.binding?.pin?.dataset_id ?? args?.pin?.dataset_id;
    const stored = journals.get(target) ?? {revision:null,records:[],pending:[]};
    const files = objects.get(target) ?? new Map();
    switch(command){
    case 'get_app_config':return cloud ? {sync_mode:'webdav',webdav_url:'https://example.test/dav/',
        webdav_username:'example',webdav_password:'fake',webdav_filepath:'synthetic/todo_data.json'} : {sync_mode:'local'};
    case 'fetch_from_cloud':return JSON.stringify(original);
    case 'read_personal_target':return {target:'A',data:JSON.stringify(original)};
    case 'get_collaborations':window.fixtureReady=true;return [];
    case 'read_collaborations_data':return '{"collaborations":[]}';
    case 'open_personal_planning_target': {
        if (window.failPlanningOpen) { window.failPlanningOpen = false; throw new Error('模拟读取失败'); }
        return {datasetId:legacyId,
        actorId:'ec000000-0000-4000-8000-000000000002',at:'1970-01-01T00:00:00Z'};
    }
    case 'export_review_markdown':window.exported=args.content;return true;
    case 'prepare_record_sandbox_folder':objects.set(target,files);return 'private-root-'+target;
    case 'initialize_planning_webdav': {
        window.planningPin=args.binding.pin;
        if (!files.size) {
            const id='ec000000-0000-4000-8000-000000000013', created_at='2026-11-14T02:00:00Z';
            const rating={id,date:today,score:2,created_at,updated_at:created_at,deleted:false};
            files.set('records/'+id+'.'+'2'.repeat(64)+'.json',
                JSON.stringify({id,created_at,parents:[],operations:[{type:'planning.rating.put',rating}]}));
        }
        objects.set(target,files);
        return;
    }
    case 'request_record_webdav': {
        if(args.action==='list') {
            const root='/dav/synthetic/'+args.binding.pin.namespace+'records/';
            return '<d:multistatus xmlns:d="DAV:">'+[root,...[...files.keys()].map(name=>root+name.slice(8))]
                .map(name=>'<d:response><d:href>'+name+'</d:href></d:response>').join('')+'</d:multistatus>';
        }
        if(args.action==='read') return files.get(args.name) ?? null;
        if(args.action==='write_planning') { files.set(args.name,args.content); return; }
        throw new Error('unexpected cloud action');
    }
    case 'list_record_folder':return {names:[...files.keys()],aliases:[]};
    case 'read_record_folder':return files.get(args.name) ?? null;
    case 'write_record_folder':files.set(args.name,args.content);return;
    case 'prepare_record_recovery_commit': {
        const {request} = args, records = structuredClone(stored.records), pending = [...stored.pending];
        let submitted = null;
        if(request.intent){
            const intent = request.intent;
            if(intent.observed_sha256 !== stored.revision) throw new Error('RECORD_WRITE_STALE');
            const record = {...intent, parents:records.map(({record})=>({id:record.id}))};
            const name = 'records/'+record.id+'.'+'0'.repeat(64)+'.json';
            submitted = {name,content:JSON.stringify(record)};
            records.push({record,artifact:submitted});
            pending.push(name);
        }
        if(request.observation?.confirm) pending.splice(pending.indexOf(request.observation.artifact.name),1);
        if(request.observation && !request.observation.confirm) {
            const artifact = request.observation.artifact;
            records.push({record:JSON.parse(artifact.content),artifact});
        }
        const revision = (request.intent || request.observation) ? crypto.randomUUID() : stored.revision;
        const unread = [...new Set([...(stored.unread ?? []), ...(request.discovered ?? [])])]
            .filter(name => !records.some(({artifact}) => artifact.name === name));
        const candidate = {revision,records,pending,unread};
        const receipt = {previous_sha256:stored.revision,candidate_sha256:revision};
        window.prepared = candidate;
        return {receipt,preview:{operation_set:request.pin.dataset_id===window.planningPin?.dataset_id?'planning/1':'lab-planning/1',baseline:atob(request.baseline),submitted,
            journal:{records:records.map(({artifact})=>artifact),pending,unread},dependencies:{missing:[]},
            records:records.map(({record})=>JSON.stringify(record))}};
    }
    case 'commit_record_recovery':
        if (window.failPlanningSave) { window.failPlanningSave = false; throw new Error('模拟保存失败'); }
        journals.set(target,window.prepared);return;
    default:return null;
    }
}}};
`;

const browser = await browserHarness(bootstrap);
const click = selector => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const mouseClick = async selector => {
    const { x, y } = await browser.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
        await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
};
const set = (selector, value) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
const open = async () => {
    await click('#record-sandbox [data-start]');
    await waitFor(browser, `!document.querySelector('#record-sandbox [data-content]').hidden`);
};
const close = async () => {
    await click('#record-sandbox [data-stop]');
    await waitFor(browser, `document.querySelector('#record-sandbox [data-content]').hidden`);
};
try {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 680, deviceScaleFactor: 1, mobile: false });
    await waitFor(browser, 'window.fixtureReady');
    await click('#settings-btn');
    await click('.settings-tab-btn[data-target="panel-sync"]');
    await click('#record-sandbox summary');
    await open();
    await set('#record-sandbox [data-task]', '浏览器合成任务');
    await click('#record-sandbox [data-add]');
    await waitFor(browser, `document.querySelector('#record-sandbox [data-tasks] input')?.value==='浏览器合成任务'`);
    await set('#record-sandbox [data-tasks] input', '改名后的任务');
    await click('#record-sandbox [data-tasks] button:first-of-type');
    await waitFor(browser, `document.querySelector('#record-sandbox [data-tasks] input')?.value==='改名后的任务' && !document.querySelector('#record-sandbox [data-content]').disabled`);
    await close();
    await set('#record-sandbox [data-target]', '2');
    await open();
    assert.equal(await browser.evaluate(`document.querySelectorAll('#record-sandbox [data-tasks] li').length`), 0);
    await close();
    await set('#record-sandbox [data-target]', '1');
    await open();
    assert.equal(await browser.evaluate(`document.querySelector('#record-sandbox [data-tasks] input').value`), '改名后的任务');
    await click('#record-sandbox [data-tasks] button:last-of-type');
    await waitFor(browser, `!document.querySelector('#record-sandbox [data-tasks] li')`);
    await set('#record-sandbox textarea', '浏览器合成计划');
    const clickText = label => browser.evaluate(`[...document.querySelectorAll('#record-sandbox button')].find(node=>node.textContent===${JSON.stringify(label)}).click()`);
    await clickText('保存计划');
    await waitFor(browser, `document.querySelector('#record-sandbox [data-planning]').textContent.includes('已有计划')`);
    await set('#record-sandbox textarea', '浏览器合成计划二');
    await clickText('保存计划');
    await waitFor(browser, `[...document.querySelectorAll('#record-sandbox summary')].some(node=>node.textContent==='对比版本')`);
    assert.equal(await browser.evaluate(`document.querySelector('#record-sandbox td ins').textContent`), '二');
    await clickText('5 分');
    await waitFor(browser, `document.querySelector('#record-sandbox [data-planning]').textContent.includes('当日评分 5')`);
    await clickText('清除评分');
    await waitFor(browser, `document.querySelector('#record-sandbox [data-planning]').textContent.includes('当日评分 未评分')`);
    await clickText('查看本月评分');
    assert.ok(await browser.evaluate(`document.querySelectorAll('#record-sandbox .record-rating-grid button').length >= 28`));
    await click('#record-sandbox [data-planning] input[type=checkbox]');
    await clickText('导出 Markdown');
    await waitFor(browser, `window.exported?.includes('浏览器合成计划二') || window.exported?.includes('未安排')`);
    await close();
    await click('#settings-cancel-btn');
    await browser.evaluate('window.failPlanningOpen = true');
    await click('#stats-btn');

    const stats = '#stats-planning';
    const review = '#daily-review-card';
    const buttonText = (scope, label) => browser.evaluate(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})]
        .find(node => node.textContent === ${JSON.stringify(label)}).click()`);
    const textIncludes = (scope, value) => waitFor(browser, `document.querySelector(${JSON.stringify(scope)})?.textContent.includes(${JSON.stringify(value)})`);
    await textIncludes(review, '无法读取本机计划与评分');
    await buttonText(review, '重试读取');
    await textIncludes(review, '本周尚未制定计划');
    assert.equal(await browser.evaluate(`document.querySelector('#stats-planning').hidden`), true);
    assert.match(await browser.evaluate(`document.querySelector('#stats-date-label').textContent`), /^\d{4}-\d{2}-\d{2} · 周[一二三四五六日]$/);
    if (process.env.TODO_PLANNING_CLOUD_TEST) {
        await textIncludes(review, '当日评分 · 2 分');
        assert.equal(await browser.evaluate(`journals.get(legacyId).records.length`), 2);
    }
    await buttonText(review, '去制定周计划');
    await waitFor(browser, `!document.querySelector('#stats-planning [data-content]').hidden`);
    const drags = () => browser.evaluate(`calls.filter(command => command === 'start_drag').length`);
    const initialDrags = await drags();
    await mouseClick(stats + ' .planning-editor > summary');
    assert.equal(await drags(), initialDrags, '点击制定周计划不得触发窗口拖动');
    await waitFor(browser, `document.querySelector('#stats-planning .planning-editor').open`);
    await browser.evaluate(`[...document.querySelectorAll('#stats-planning textarea')].forEach(input => {
        input.value = '统计页自己的计划'; input.dispatchEvent(new Event('input'));
    })`);
    await buttonText(stats, '保存计划');
    await textIncludes(stats, '查看当日回顾');
    await click(stats + ' .planning-editor > summary');
    await browser.evaluate(`(() => {
        const input = document.querySelector('#stats-planning textarea');
        input.value = '周计划草稿'; input.dispatchEvent(new Event('input'));
    })()`);
    await buttonText(stats, '查看当日回顾');
    await buttonText('dialog[open]', '继续编辑');
    assert.equal(await browser.evaluate(`document.querySelector('#stats-planning textarea').value`), '周计划草稿');
    await buttonText(stats, '查看当日回顾');
    await buttonText('dialog[open]', '放弃修改');
    await textIncludes(review, '统计页自己的计划');
    await browser.evaluate('window.failPlanningSave = true');
    await buttonText(review, '4 分');
    await textIncludes(review, '模拟保存失败');
    await buttonText(review, '重试保存评分');
    await textIncludes(review, '当日评分 · 4 分');
    assert.equal(await browser.evaluate(`document.querySelector('#daily-review-card [aria-pressed="true"]').textContent`), '4 分');
    assert.ok(await browser.evaluate(`(() => { const card = document.querySelector('#daily-review-card'); return card.scrollWidth <= card.clientWidth; })()`));
    await buttonText(review, '写复盘');
    await textIncludes('dialog[open]', '统计页自己的计划');
    await set('dialog[open] textarea', '尚未保存的复盘草稿');
    if (process.env.TODO_PLANNING_CLOUD_TEST) {
        await browser.evaluate(`(async () => {
            const input = document.querySelector('dialog[open] textarea');
            input.focus();
            input.setSelectionRange(2, 4);
            const { planningChange, weeklyPlanState, mondayForDate } = await import('/weeklyPlanning.js');
            const { replayPersonalRecords, CLOUD_PLANNING_OPERATION_SET } = await import('/recordReplay.js');
            const stored = journals.get(window.planningPin.dataset_id);
            const records = stored.records.map(({record}) => record);
            const view = replayPersonalRecords(original, records, CLOUD_PLANNING_OPERATION_SET);
            const week = mondayForDate(document.querySelector('#stats-planning [data-date]').value);
            const id = crypto.randomUUID(), at = new Date().toISOString();
            const operation = planningChange(view, { kind: 'save', week, tips: weeklyPlanState(view, week).tips,
                versionId: crypto.randomUUID(), days: Array(7).fill('同步更新后的周计划'), reason: '模拟另一端修订' }, { id, at });
            const record = { id, created_at: at, parents: records.map(({id}) => ({id})), operations: [operation] };
            objects.get(window.planningPin.dataset_id).set('records/'+id+'.'+'3'.repeat(64)+'.json', JSON.stringify(record));
        })()`);
        await waitFor(browser, `document.querySelector('dialog[open]').textContent.includes('同步更新后的周计划')`, 700);
        assert.deepEqual(await browser.evaluate(`(() => {
            const input = document.querySelector('dialog[open] textarea');
            return [input.value, input.selectionStart, input.selectionEnd, document.activeElement === input];
        })()`), ['尚未保存的复盘草稿', 2, 4, true]);
        await textIncludes(review, '同步更新后的周计划');
    }
    await click('#stats-next-btn');
    await buttonText('dialog[open]', '继续编辑');
    assert.equal(await browser.evaluate(`document.querySelector('dialog[open] textarea').value`), '尚未保存的复盘草稿');
    await buttonText('dialog[open]', '取消');
    await buttonText('dialog[open]', '放弃修改');
    await waitFor(browser, `!document.querySelector('dialog[open]')`);
    await click('#stats-period-month');
    await textIncludes(stats, '已评分');
    const coverage = process.env.TODO_PLANNING_CLOUD_TEST ? '[12]' : '1';
    assert.match(await browser.evaluate(`document.querySelector('#stats-planning .planning-score-summary').textContent`),
        new RegExp('已评分 ' + coverage + '/(28|29|30|31) 天'));
    await click('#stats-planning .record-rating-grid button[data-score="4"]');
    await textIncludes(review, '当日评分 · 4 分');
    await buttonText(review, '导出 Markdown');
    assert.equal(await browser.evaluate(`document.querySelector('#stats-planning select[aria-label="导出范围"]')`), null);
    await browser.evaluate(`[...document.querySelectorAll('dialog[open] label')].find(label => label.textContent === '评分').querySelector('input').click()`);
    await buttonText('dialog[open]', '导出文件');
    await waitFor(browser, `window.exported?.includes('4 / 5')`);
    if (process.env.TODO_PLANNING_SCREENSHOT) {
        const result = await browser.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(process.env.TODO_PLANNING_SCREENSHOT, Buffer.from(result.data, 'base64'));
    }
    assert.equal(await browser.evaluate(`calls.includes('write_todo_data')`), false);
    assert.equal(await browser.evaluate(`calls.includes('request_record_webdav')`), Boolean(process.env.TODO_PLANNING_CLOUD_TEST));
    if (process.env.TODO_PLANNING_CLOUD_TEST) {
        await waitFor(browser, `!document.querySelector('#sync-status').matches('.syncing, .error')`, 800);
        assert.equal(await browser.evaluate(`document.querySelector('#stats-planning').textContent.includes('坚果云已同步')`), false);
    }
    console.log('PASS 独立试用、统计页计划和评分、月评分格跳转与 Markdown 导出');
} catch (error) {
    console.error(await browser.evaluate(`({ date:document.querySelector('#stats-planning [data-date]').value,
        status:document.querySelector('#stats-planning [data-status]').textContent, pin:!!window.planningPin })`));
    throw error;
} finally {
    await browser.close();
}
