import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encode, hash } from './codec.mjs';
import { createDataset } from './envelope.mjs';
import { FileStore } from './file-store.mjs';
import { openRecordLab, memoryTransport } from './client.mjs';
import { createRecovery, restoreRecovery } from './recovery.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const actor='11111111-1111-4111-8111-111111111111';
const intent=(n,key,value)=>({id:`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,actorId:actor,
    createdAt:'2026-11-05T00:00:00Z',operations:[{type:'lab.note.set',key,value}]});

/** 验证恢复包确实写盘并重读；不访问应用数据或真实WebDAV。 */
export async function runDurableRecovery() {
    const nonce=randomUUID(),directory=await mkdtemp(join(root,'.scratch-recovery-'));
    await writeFile(join(directory,'owner.json'),JSON.stringify({nonce}),{flag:'wx'});
    const stores=[],checks=[];
    const track=path=>{const store=new FileStore(path);stores.push(store);return store;};
    const check=(name,condition)=>{assert.ok(condition,name);checks.push({name,passed:true});};
    try {
        const dataset=createDataset({datasetId:'b1234567-1234-4234-8234-123456789abc',createdAt:'2026-11-05T00:00:00Z',data:{notes:{},extension:{keep:'原扩展'}}});
        const remote=memoryTransport();
        let primary=track(join(directory,'primary')),client=await openRecordLab({dataset,store:primary,transport:remote});
        const first=await client.commit(intent(1,'first','已备份未上传'));
        const backup=track(join(directory,'backup'));
        await backup.save(createRecovery({dataset,state:client.state()}));
        await backup.close();
        check('恢复包包含未上传原始字节与outbox',client.state().outbox.includes(first.name));
        const second=await client.commit(intent(2,'second','备份后新增未上传'));
        await primary.close();
        const reopenedBackup=track(join(directory,'backup')),bundle=await reopenedBackup.load();
        await reopenedBackup.close();
        primary=track(join(directory,'primary'));
        const merged=restoreRecovery({dataset,currentState:await primary.load(),bundle});
        await primary.save(merged);await primary.close();
        primary=track(join(directory,'primary'));client=await openRecordLab({dataset,store:primary,transport:remote});
        check('旧包恢复不覆盖备份后修改',client.state().artifacts.length===2&&client.state().view.notes.second==='备份后新增未上传');
        check('旧包恢复保留两条原outbox',client.state().outbox.includes(first.name)&&client.state().outbox.includes(second.name));
        await client.sync();
        check('恢复后上传同一文件及完整正文',remote.files.size===2&&client.state().outbox.length===0&&
            Buffer.from(first.base64,'base64').equals(await remote.read(first.name))&&Buffer.from(second.base64,'base64').equals(await remote.read(second.name)));
        const expected=encode(client.state().view);
        await primary.close();
        const cold=track(join(directory,'cold'));
        await cold.save(restoreRecovery({dataset,bundle}));
        const recovered=await openRecordLab({dataset,store:cold,transport:remote});
        await recovered.sync();
        check('新目录仅旧包加记录恢复完整已知结果',encode(recovered.state().view).equals(expected)&&recovered.state().view.extension.keep==='原扩展');
        // 投影字段即使被改坏，也不能成为恢复依据。
        const tampered=structuredClone(bundle);tampered.state.view={notes:{forged:'伪造缓存'}};
        const viewless=restoreRecovery({dataset,bundle:tampered});
        check('包内缓存不是数据依据',viewless.view.notes.first==='已备份未上传'&&viewless.view.notes.forged===undefined);
        return {outcome:'passed',testedAt:new Date().toISOString(),storage:'real-workspace-files',transport:'memory',checks,
            recordCount:2,finalProjectionSha256:hash(expected),
            limitations:['只验证lab.note.set，不验证计划业务投影','没有真实WebDAV传输或应用接入','没有断电或多进程共享store保证','恢复完整性仅限打包端已知记录']};
    } finally {
        for(const store of stores)await store.close();
        const absolute=await realpath(directory),parent=await realpath(root),owner=JSON.parse(await readFile(join(absolute,'owner.json'),'utf8'));
        assert.equal(dirname(absolute),parent);assert.ok(basename(absolute).startsWith('.scratch-recovery-'));assert.equal(owner.nonce,nonce);
        await rm(absolute,{recursive:true,force:true});
    }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    const report=await runDurableRecovery();
    if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(report,null,2));
}
