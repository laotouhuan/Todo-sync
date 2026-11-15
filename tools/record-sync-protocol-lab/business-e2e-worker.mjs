import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDataset } from './envelope.mjs';
import { FileStore } from './file-store.mjs';
import { verifyOwnedScratch } from './run-durability.mjs';
import { fileObjectTransport } from './normal-durability-worker.mjs';
import { collaborationTodoCreate, openCollaborationRecordLab, COLLABORATION_RECORD_PROFILE as profile } from './collaboration-record-profile.mjs';
import { checkinOperation } from './checkin-record-profile.mjs';
import { normalTodoOperation } from './normal-record-profile.mjs';

export function businessFixture() {
    const id = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const at = '2026-11-07T02:00:00Z', later = '2026-11-07T04:00:00Z', day = '2026-11-07';
    const ordinary = normalTodoOperation('put', { id: id(10), content: '既有普通任务', created_at: at, updated_at: at }).todo;
    const weekly = { id: id(11), content: '已打卡的任务', date: '2026-W45', task_type: 'weekly_checkin',
        created_at: at, updated_at: at, target_count: 1, completed: true, completed_at: at, completed_dates: [day] };
    const member = { ...weekly, id: id(12), content: '系列成员' };
    const series = { id: id(20), content: '系列', period_type: 'week', created_at: at, updated_at: at, content_updated_at: at };
    const timer = { id: id(30), task_ref: { todo_id: member.id }, started_at: at, created_at: at, updated_at: at, ended_at: null };
    const dataset = createDataset({ datasetId: id(1), createdAt: at, profile, data: {
        version: 1, last_updated: at, todos: [ordinary, weekly, member], task_series: [series],
        task_series_links: [{ todo_id: member.id, series_id: series.id, period: member.date, created_at: at, updated_at: at }],
        time_entries: [timer], future: { keep: ['原值'] }
    } });
    const binding = { sourceId: '合成协作来源', targetKey: '本次自建对象目录', generation: 1, pin: dataset.pin };
    const add = { id: id(40), actorId: id(2), createdAt: later, operations: [collaborationTodoCreate({
        id: id(13), content: '协作者新增月任务', date: '2026-11', task_type: 'monthly_checkin', target_count: 2,
        created_at: later, order: -1, subtasks: [{ id: id(14), content: '初始子任务' }]
    })] };
    const edit = { id: id(41), actorId: id(3), createdAt: later, operations: [
        normalTodoOperation('put', { ...ordinary, content: '所有者离线修改', updated_at: later }),
        checkinOperation('clear', { todo_id: weekly.id, day, updated_at: later })
    ] };
    return { dataset, binding, add, edit, member, later, deleteRecordId: id(42) };
}

export function openFixtureCollaborator(fixture, store, transport) {
    const { dataset, binding } = fixture;
    return openCollaborationRecordLab({ dataset, binding, store, transport, access: 'append',
        getCurrentBinding: () => binding, getCurrentAccess: () => 'append' });
}

async function run(directory, token, stage) {
    if (typeof process.send !== 'function' || !['before-upload', 'after-object-write'].includes(stage)) {
        throw new Error('INVALID_BUSINESS_WORKER_INVOCATION');
    }
    const root = await verifyOwnedScratch({ directory, token });
    const fixture = businessFixture();
    const store = new FileStore(join(root, 'collaborator'));
    let submitted;
    async function stop() {
        await new Promise(resolveSend => process.send({ stage, lease: store.leaseInfo(), submitted }, resolveSend));
        process.exit(91);
    }
    const transport = fileObjectTransport(join(root, 'objects'), async () => {
        if (stage === 'after-object-write') await stop();
    });
    const client = await openFixtureCollaborator(fixture, store, transport);
    submitted = await client.append(fixture.binding, fixture.add);
    if (stage === 'before-upload') await stop();
    await client.sync();
    throw new Error('BUSINESS_WORKER_STAGE_NOT_REACHED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await run(process.argv[2], process.argv[3], process.argv[4]);
}
