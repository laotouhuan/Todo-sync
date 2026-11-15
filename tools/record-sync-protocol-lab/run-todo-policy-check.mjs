import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mergeTodoData } from '../../windows/src/dataMerge.js';
import { canonicalLearning } from '../../windows/src/timeTracking.js';

// 只复现现有规则与候选的差异，不是新业务实现，不回写原型或应用。
export async function runTodoPolicyCheck() {
    const fixture=JSON.parse(await readFile(new URL('../record-sync-prototype/fixture.json',import.meta.url),'utf8'));
    const baseline={...fixture.data.todos[0],content:'原任务',label:'学习',updated_at:'2026-11-05T00:00:00.000Z'};
    const a={...structuredClone(baseline),content:'甲端修改'},b={...structuredClone(baseline),content:'乙端修改'};
    const full=todo=>({version:1,last_updated:todo.updated_at,todos:[structuredClone(todo)]});
    const left=mergeTodoData(full(a),full(b)).data.todos[0];
    const right=mergeTodoData(full(b),full(a)).data.todos[0];
    assert.equal(left.content,a.content);assert.equal(right.content,b.content);assert.notEqual(left.content,right.content);
    function fixedWhole(first,second) {
        const aTime=Date.parse(first.updated_at||first.created_at)||0,bTime=Date.parse(second.updated_at||second.created_at)||0;
        if(aTime!==bTime)return structuredClone(aTime>bTime?first:second);
        return structuredClone(canonicalLearning(first)>canonicalLearning(second)?first:second);
    }
    assert.deepEqual(fixedWhole(a,b),fixedWhole(b,a));
    const aEdit={...structuredClone(baseline),content:'新内容',updated_at:'2026-11-05T00:01:00.000Z'};
    const bEdit={...structuredClone(baseline),label:'课程',updated_at:'2026-11-05T00:02:00.000Z'};
    const whole=fixedWhole(aEdit,bEdit);
    assert.equal(whole.content,'原任务');assert.equal(whole.label,'课程');
    return {outcome:'passed',testedAt:new Date().toISOString(),scope:'synthetic-existing-rule-reproduction-and-unapproved-candidate',
        sameTimestamp:{a:a.content,b:b.content,existingAFirst:left.content,existingBFirst:right.content,
            deterministicWholeCandidate:fixedWhole(a,b).content},
        differentFieldEdits:{existingWholeRule:{content:whole.content,label:whole.label},fieldDeltaAlternative:{content:aEdit.content,label:bEdit.label}},
        decisionRequired:'普通待办同时间保留本地不能同时满足相同记录集的统一投影；第一版采用整条时间优先加固定平局，还是采用字段增量新语义。',
        limitations:['仅人工合成任务','固定平局是待确认候选，未写入应用或同步原型','未批准普通待办因果裁决或删除语义变更']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    const report=await runTodoPolicyCheck();
    if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(report,null,2));
}
