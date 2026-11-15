import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mergeReminderSettings,mergeCollaborations,resolveCheckinConflict } from '../../windows/src/dataMerge.js';

// 只复现尚未获准修改的现有平局规则，不实现或启用新策略。
export function inspectRemainingTies() {
    const time='2026-11-05T00:00:00.000Z';
    const settings=enabled=>({last_updated:time,reminder_settings:{updated_at:time,enabled,privacy_mode:false,global_rules:[]}});
    const a=settings(true),b=settings(false);
    const reminderForward=mergeReminderSettings(a,b),reminderReverse=mergeReminderSettings(b,a);
    assert.equal(reminderForward.enabled,true);assert.equal(reminderReverse.enabled,false);
    const source=name=>({version:1,last_updated:time,collaborations:[{id:'10000000-0000-4000-8000-000000000001',name,
        webdav_url:'https://example.invalid/dav/',webdav_username:'synthetic',webdav_password:'',webdav_filepath:'synthetic/todo_data.json',updated_at:time,deleted:false}]});
    const first=mergeCollaborations(source('甲备注'),source('乙备注')).data.collaborations[0];
    const second=mergeCollaborations(source('乙备注'),source('甲备注')).data.collaborations[0];
    assert.equal(first.name,'甲备注');assert.equal(second.name,'乙备注');
    const checkinA='2026-11-05T10:00:00+08:00',checkinB='2026-11-05T11:00:00+08:00';
    assert.equal(checkinA.length,checkinB.length);
    const markForward=resolveCheckinConflict(checkinA,checkinB,Date.parse(time),Date.parse(time));
    const markReverse=resolveCheckinConflict(checkinB,checkinA,Date.parse(time),Date.parse(time));
    assert.equal(markForward,checkinA);assert.equal(markReverse,checkinB);
    return {outcome:'reproduced',testedAt:new Date().toISOString(),scope:'synthetic-current-rule-counterexamples-only',
        reminders:{forwardEnabled:reminderForward.enabled,reverseEnabled:reminderReverse.enabled},
        collaborationConfig:{forwardName:first.name,reverseName:second.name,passwordsUsed:false,networkRequests:0},
        equalLengthCheckin:{forward:markForward,reverse:markReverse},
        proposedChange:'只在各类原有规则完全打平时统一固定排序；仍保留其余现有优先级、补销卡与凭据隔离规则。',
        decision:'需要明确同意后才扩展到这些数据类别，不由普通Todo批准自动覆盖。'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    const report=inspectRemainingTies();
    if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(report,null,2));
}
