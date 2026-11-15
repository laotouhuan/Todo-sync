import { spawn } from 'node:child_process';
import { readFile, open, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorpus } from './interop-corpus.mjs';
import { encode, hash } from './codec.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const same=(a,b)=>encode(a).equals(encode(b));

export function compareResponses(cases,replies) {
    const failures=[];
    if(replies.length!==cases.length)failures.push({id:null,reason:'response-count',expected:cases.length,actual:replies.length});
    for(let i=0;i<cases.length;i++) {
        const {request,expected,group}=cases[i],actual=replies[i];
        if(!actual||typeof actual!=='object'||Array.isArray(actual)||actual.id!==request.id||typeof actual.ok!=='boolean') {
            failures.push({id:request.id,group,reason:'invalid-response-or-order'});continue;
        }
        for(const [field,value]of Object.entries(expected)) {
            let equal=false;
            try{equal=Object.hasOwn(actual,field)&&same(actual[field],value);}catch{/* 错误回复不能通过缺字段或非法JSON值绕过比较。 */}
            if(!equal)failures.push({id:request.id,group,reason:'value-mismatch',field,
                expected:JSON.stringify(value).slice(0,240),actual:JSON.stringify(actual[field])?.slice(0,240)??'<missing>'});
        }
    }
    return failures;
}

function invoke({command,args},input) {
    return new Promise((resolveRun,reject)=>{
        const child=spawn(command,args,{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let stdout='',stderr='',ended=false;
        const timer=setTimeout(()=>{child.kill();reject(new Error('INTEROP_PROCESS_TIMEOUT'));},45000);
        const fail=code=>{if(!ended){ended=true;clearTimeout(timer);child.kill();reject(new Error(code));}};
        child.on('error',()=>fail('INTEROP_PROCESS_UNAVAILABLE'));
        child.stdin.on('error',()=>fail('INTEROP_INPUT_FAILED'));
        child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
        child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>4*1024*1024)fail('INTEROP_OUTPUT_LIMIT');});
        child.stderr.on('data',chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>64*1024)fail('INTEROP_STDERR_LIMIT');});
        child.on('close',code=>{
            if(ended)return;ended=true;clearTimeout(timer);
            if(code!==0){reject(new Error('INTEROP_PROCESS_FAILED'));return;}
            try{
                const lines=stdout.trimEnd().split(/\r?\n/);
                resolveRun(lines.map(line=>JSON.parse(line)));
            }catch{reject(new Error('INTEROP_INVALID_NDJSON'));}
        });
        child.stdin.end(input,'utf8');
    });
}

export async function runInterop({launches}={}) {
    const corpus=buildCorpus(),input=corpus.cases.map(item=>JSON.stringify(item.request)).join('\n')+'\n';
    if(!launches) {
        const kotlin=JSON.parse(await readFile(resolve(directory,'kotlin/build/launch.json'),'utf8'));
        if(typeof kotlin.mainClass!=='string'||!Array.isArray(kotlin.classpath)||!kotlin.classpath.length||kotlin.classpath.some(item=>typeof item!=='string'))throw new Error('INVALID_KOTLIN_LAUNCH');
        launches={node:{command:process.execPath,args:[resolve(directory,'interop-node.mjs')]},
            rust:{command:resolve(directory,'rust/target/debug/record-sync-codec-lab.exe'),args:[]},
            kotlin:{command:'D:/android studio/jbr/bin/java.exe',args:['-cp',kotlin.classpath.join(';'),kotlin.mainClass]}};
    }
    if(!launches.node||!launches.rust||!launches.kotlin)throw new Error('THREE_LANGUAGES_REQUIRED');
    const groups={};for(const item of corpus.cases)groups[item.group]=(groups[item.group]??0)+1;
    const backends=await Promise.all(Object.entries(launches).map(async([language,launch])=>{
        try{
            const replies=await invoke(launch,input),failures=compareResponses(corpus.cases,replies);
            return {language,outcome:failures.length?'failed':'passed',cases:corpus.cases.length,failures};
        }catch(error){return {language,outcome:'inconclusive',cases:corpus.cases.length,failures:[{reason:error.message}]};}
    }));
    const sources=['codec.mjs','envelope.mjs','operation-profile.mjs','interop-node.mjs','interop-corpus.mjs','business-vectors.mjs','normal-todo.mjs','normal-todo-vectors.mjs','run-interop.mjs',
        'vectors.json','wire-vectors.json','rust/Cargo.toml','rust/Cargo.lock','rust/src/lib.rs','rust/src/main.rs','kotlin/Main.kt','kotlin/build.ps1',
        'business-e2e-worker.mjs','collaboration-record-profile.mjs','series-workflow-profile.mjs','../../windows/src/taskSeries.js',
        '../../windows/src/recordCheckins.js','../../windows/src/recordLearning.js','../../windows/src/recordPeriods.js',
        '../../windows/src/recordCollaboration.js','../../windows/src/recordSeries.js',
        '../../android/app/src/main/java/com/todo/app/data/recordsync/CanonicalRecordJson.kt'];
    const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async name=>[name,hash(await readFile(resolve(directory,name)))])));
    async function classes(parent,prefix='') {
        const files=[];
        for(const item of await readdir(parent,{withFileTypes:true})) {
            if(item.isDirectory())files.push(...await classes(resolve(parent,item.name),prefix+item.name+'/'));
            else if(item.isFile())files.push({path:prefix+item.name,sha256:hash(await readFile(resolve(parent,item.name)))});
        }
        return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    }
    const artifacts={rustExecutableSha256:hash(await readFile(resolve(directory,'rust/target/debug/record-sync-codec-lab.exe'))),
        kotlinClassesSha256:hash(encode(await classes(resolve(directory,'kotlin/build/classes'))))};
    return {outcome:backends.every(item=>item.outcome==='passed')?'passed':'failed',testedAt:new Date().toISOString(),
        scope:'isolated-codec-envelope-and-first-release-business-samples',casesPerLanguage:corpus.cases.length,
        corpusSha256:hash(encode(corpus)),groups,backends,sourceHashes,artifacts,
        limitations:['独立命令行实验，不是Windows或Android应用接入','未验证真实WebDAV、新协议磁盘事务或进程退出',
            '未覆盖完整业务操作目录、计划投影、协作权限与迁移','数值差分是有限样本，不构成所有binary64穷举证明']};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    let reportFile;
    try{
        if(process.argv.length>3)throw new Error('USE_OPTIONAL_NEW_REPORT_PATH');
        if(process.argv[2])reportFile=await open(resolve(process.argv[2]),'wx');
        const report=await runInterop();
        if(reportFile)await reportFile.writeFile(JSON.stringify(report,null,2)+'\n','utf8');
        console.log(JSON.stringify(report,null,2));process.exitCode=report.outcome==='passed'?0:1;
    }catch(error){
        const report={outcome:'inconclusive',reason:error.code==='EEXIST'?'REPORT_ALREADY_EXISTS':error.message};
        if(reportFile)await reportFile.writeFile(JSON.stringify(report,null,2)+'\n','utf8');
        console.error(JSON.stringify(report));process.exitCode=1;
    }finally{await reportFile?.close();}
}
