import { spawnSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveCheckinConflict } from '../../windows/src/dataMerge.js';
import { checkinCases } from './checkin-cases.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function windowsCheckin(input) {
    const localTime=Date.parse(input.local_updated),cloudTime=Date.parse(input.cloud_updated);
    const days=[...new Set([...input.local_dates,...input.cloud_dates].map(value=>value.split('T')[0]))];
    return days.map(day=>resolveCheckinConflict(input.local_dates.find(value=>value.startsWith(day)),input.cloud_dates.find(value=>value.startsWith(day)),localTime,cloudTime)).filter(value=>value!==null);
}

/** 比较现有两端源码的纯额外归并，不修改任何规则，不代表完整打卡功能验收。 */
export async function validateCheckin() {
    const cases=checkinCases(),launch=JSON.parse(await readFile(resolve(root,'checkin-probe/build/launch.json'),'utf8'));
    const source=JSON.parse(await readFile(resolve(root,'checkin-probe/build/source-manifest.json'),'utf8'));
    if(typeof launch.mainClass!=='string'||!Array.isArray(launch.classpath))throw new Error('INVALID_CHECKIN_PROBE');
    const actualSource=await readFile(resolve(root,'../../android/app/src/main/java/com/todo/app/data/model/MergeUtils.kt'));
    if(source.sourceSha256!==createHash('sha256').update(actualSource).digest('hex'))throw new Error('CHECKIN_PROBE_SOURCE_CHANGED_REBUILD');
    const requests=cases.map(({expected,...request})=>request);
    const child=spawnSync('D:/android studio/jbr/bin/java.exe',['-cp',launch.classpath.join(';'),launch.mainClass],
        {input:requests.map(value=>JSON.stringify(value)).join('\n')+'\n',encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
    if(child.error||child.status!==0)throw new Error('CHECKIN_PROBE_EXECUTION_FAILED');
    const replies=child.stdout.trimEnd().split(/\r?\n/).map(line=>JSON.parse(line));
    if(replies.length!==cases.length||replies.some((reply,index)=>reply.id!==cases[index].id||reply.ok!==true||!Array.isArray(reply.dates)))throw new Error('CHECKIN_PROBE_REPLY_INVALID');
    const checks=cases.map((input,index)=>{
        const windows=windowsCheckin(input),kotlin=replies[index].dates;
        return {id:input.id,windows,kotlin,exactAgreement:same(windows,kotlin),
            dateContentAgreement:same([...windows].sort(),[...kotlin].sort()),
            expectedCurrentRule:input.expected,expectedConfirmed:input.expected===null?null:same(windows,input.expected)&&same(kotlin,input.expected)};
    });
    const ordinary=checks.filter(item=>item.expectedCurrentRule!==null);
    const knownDirectional=checks.filter(item=>item.id.startsWith('equal-length-local-'));
    const differences=checks.filter(item=>!item.exactAgreement);
    const outcome=ordinary.some(item=>!item.expectedConfirmed)?'unexpected-result':differences.length?'differences-found':'agreed-in-samples';
    return {outcome,testedAt:new Date().toISOString(),scope:'current-checkin-extra-merge-source-only',rulesModified:false,
        cases:cases.length,ordinaryCasesConfirmed:ordinary.filter(item=>item.expectedConfirmed).length,
        differences: differences.map(item=>item.id),
        sameRecordsDifferentLocalRole:{first:knownDirectional[0].windows,reverse:knownDirectional[1].windows,convergent:same(knownDirectional[0].windows,knownDirectional[1].windows)},
        source,windowsSourceSha256:createHash('sha256').update(await readFile(resolve(root,'../../windows/src/dataMerge.js'))).digest('hex'),checks,
        limitations:['只验证现有额外归并函数，不验证整个Repository或完成状态派生','没有采用普通Todo新平局规则','没有网络或真实数据','发现差异不自动批准改变打卡规则']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    const report=await validateCheckin();
    if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(report,null,2));
    process.exitCode=report.outcome==='agreed-in-samples'?0:1;
}
