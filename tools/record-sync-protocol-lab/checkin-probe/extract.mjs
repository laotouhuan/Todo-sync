import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只抽取实际Android纯函数，不重写算法；生成物仅存本实验build目录。
const directory=dirname(fileURLToPath(import.meta.url));
const workspace=resolve(directory,'../../..');
const sourcePath='android/app/src/main/java/com/todo/app/data/model/MergeUtils.kt';
const sourceBytes=await readFile(join(workspace,sourcePath));
const source=new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes);
const declarations=[...source.matchAll(/^[\t ]*private\s+fun\s+mergeCompletedDates\s*\(/gm)];
if(declarations.length!==1)throw new Error('EXPECTED_SINGLE_MERGE_COMPLETED_DATES');
const start=declarations[0].index,body=source.indexOf('{',start);
if(body<0)throw new Error('FUNCTION_BODY_MISSING');
let depth=0,end=-1,state='code',commentDepth=0;
for(let i=body;i<source.length;i++){
    const next=source.slice(i,i+3),pair=source.slice(i,i+2),char=source[i];
    if(state==='line'){if(char==='\n')state='code';continue;}
    if(state==='block'){if(pair==='/*'){commentDepth++;i++;}else if(pair==='*/'){commentDepth--;i++;if(!commentDepth)state='code';}continue;}
    if(state==='triple'){if(next==='"""'){state='code';i+=2;}continue;}
    if(state==='string'||state==='char'){
        if(char==='\\'){i++;continue;}
        if(char===(state==='string'?'"':"'"))state='code';
        continue;
    }
    if(pair==='//'){state='line';i++;continue;}
    if(pair==='/*'){state='block';commentDepth=1;i++;continue;}
    if(next==='"""'){state='triple';i+=2;continue;}
    if(char==='"'){state='string';continue;}
    if(char==="'"){state='char';continue;}
    if(char==='{')depth++;
    if(char==='}'&&--depth===0){end=i+1;break;}
}
if(end<0)throw new Error('UNBALANCED_FUNCTION_BODY');
const extracted=source.slice(start,end);
const wrapper=await readFile(join(directory,'wrapper.kt.txt'),'utf8');
const output=join(directory,'build');
await mkdir(output,{recursive:true});
await writeFile(join(output,'Probe.kt'),'import java.time.OffsetDateTime\nimport java.io.PrintWriter\nimport java.io.OutputStreamWriter\nimport kotlinx.serialization.json.*\n\n'+extracted+'\n\n'+wrapper,'utf8');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
await writeFile(join(output,'source-manifest.json'),JSON.stringify({sourcePath,functionName:'mergeCompletedDates',sourceSha256:sha(sourceBytes),functionSha256:sha(Buffer.from(extracted,'utf8')),extraction:'verbatim-source-function',scope:'pure-function-only-not-repository-or-full-merge'},null,2)+'\n');
console.log('已逐字提取实际Android打卡纯函数到独立build目录。');
