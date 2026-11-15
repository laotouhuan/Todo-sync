import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, link, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeTodoData } from '../../windows/src/dataMerge.js';
import { PLANNING_OPERATION_SET, replayPersonalRecords } from '../../windows/src/recordReplay.js';
import { planningChange, weeklyPlanState } from '../../windows/src/weeklyPlanning.js';
import { COLLABORATION_CAUSAL_SERIES_PROFILE } from './collaboration-record-profile.mjs';
import { createDataset } from './envelope.mjs';
import { decode, encode, hash } from './codec.mjs';
import { openInitialization, readPinnedDataset } from './initialization.mjs';
import { FileStore } from './file-store.mjs';
import { openRecordLab, MemoryStore } from './client.mjs';
import { createRecovery, restoreRecovery } from './recovery.mjs';

const day = '2026-11-09', clock = day + 'T08:00:00Z', next = day + 'T09:00:00Z';
const id = value => `a0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const profile = {
    ...COLLABORATION_CAUSAL_SERIES_PROFILE,
    id: PLANNING_OPERATION_SET,
    validateBaseline: data => replayPersonalRecords(data, [], PLANNING_OPERATION_SET),
    validateOperation(operation) {
        if (!['planning.version.save', 'planning.selection.resolve', 'planning.version.delete', 'planning.rating.put'].includes(operation?.type)) {
            COLLABORATION_CAUSAL_SERIES_PROFILE.validateOperation(operation);
        }
    },
    project: (data, records) => replayPersonalRecords(data, records, PLANNING_OPERATION_SET)
};

async function withStore(path, use) {
    const store = new FileStore(path);
    try { return await use(store); }
    finally { await store.close(); }
}

function diskTransport(directory, failAfterPublish) {
    const path = name => {
        if (!/^(?:(?:baseline|dataset)\.[a-f0-9]{64}|records\/[a-f0-9-]{36}\.[a-f0-9]{64})\.json$/.test(name)) throw new Error('INVALID_REHEARSAL_PATH');
        return join(directory, name);
    };
    return {
        list: async () => (await readdir(join(directory, 'records'))).map(name => 'records/' + name),
        async read(name) {
            try { return await readFile(path(name)); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async write(name, bytes) {
            const staged = join(directory, randomUUID() + '.tmp');
            await writeFile(staged, bytes, { flag: 'wx', flush: true });
            try {
                await link(staged, path(name));
                await failAfterPublish(name);
            } finally {
                await unlink(staged);
            }
        }
    };
}

export async function runMigrationRehearsal(parent) {
    const directory = await mkdtemp(join(resolve(parent), 'todo-migration-'));
    const fixed = (suffix, content, updated_at) => ({ id: id(suffix), content, created_at: clock, updated_at, completed: false });
    const samples = [
        { version: 1, last_updated: clock, todos: [fixed(1, '旧任务', clock), fixed(2, '仅本机任务', clock)] },
        { version: 1, last_updated: next, todos: [fixed(1, '另一端修改', next), { ...fixed(3, '已删除任务', next), deleted: true }] }
    ];
    const sources = [];
    for (let index = 0; index < samples.length; index++) {
        const name = `legacy-${index + 1}.json`, path = join(directory, name);
        await writeFile(path, encode(samples[index]), { flag: 'wx' });
        const raw = await readFile(path);
        sources.push({ name, sha256: hash(raw), data: decode(raw) });
    }
    const ordered = sources.map(source => structuredClone(source.data));
    const data = mergeTodoData(...ordered).data;
    data.last_updated = next;
    data.todos.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const dataset = createDataset({ datasetId: randomUUID(), createdAt: next, data, profile });
    const remote = join(directory, 'objects'), initialization = join(directory, 'initialization');
    await mkdir(join(remote, 'records'), { recursive: true });
    let descriptorWrites = 0, interrupted = false;
    const transport = diskTransport(remote, async name => {
        if (name.startsWith('dataset.') && ++descriptorWrites === 1) throw new Error('SYNTHETIC_RESPONSE_LOSS');
    });
    await withStore(initialization, async store => {
        const session = await openInitialization({ dataset, store, transport, profile });
        try { await session.publish(); }
        catch (error) {
            if (error.message !== 'INITIALIZATION_WRITE_UNCONFIRMED' || !session.state().descriptor_publish_attempted ||
                session.state().descriptor_verified) throw error;
            interrupted = true;
        }
    });
    if (!interrupted) throw new Error('REHEARSAL_INTERRUPTION_NOT_REACHED');
    const pin = await withStore(initialization, async store => {
        const session = await openInitialization({ store, transport, profile });
        try { await session.cancel({ quiescent: true }); throw new Error('REHEARSAL_UNSAFE_CANCEL_ACCEPTED'); }
        catch (error) { if (error.message !== 'INITIALIZATION_UNSAFE_CANCEL') throw error; }
        await session.publish();
        return session.exposeInvite();
    });
    if (descriptorWrites !== 1) throw new Error('REHEARSAL_DESCRIPTOR_REWRITTEN');
    const joined = await readPinnedDataset({ pin, transport, profile });
    const work = join(directory, 'client'), actorId = id(10);
    await withStore(work, async store => {
        const client = await openRecordLab({ dataset, store, transport, profile });
        const intent = (recordId, operation) => ({ id: recordId, actorId, createdAt: next, operations: [operation] });
        const baseline = profile.project(joined.baseline.data, []);
        const plan = planningChange(baseline, { kind: 'save', week: day, versionId: id(11),
            days: ['恢复演练计划', '', '', '', '', '', ''], reason: '', tips: [] }, { id: id(12), at: next });
        await client.commit(intent(id(12), plan));
        const rating = planningChange(client.state().view, { kind: 'rate', date: day, score: 4 }, { id: id(13), at: next });
        await client.commit(intent(id(13), rating));
        await client.sync();
        const deletion = planningChange(client.state().view, { kind: 'rate', date: day, score: null },
            { id: id(14), at: next });
        await client.commit(intent(id(14), deletion));
    });
    const state = await withStore(work, async store => {
        const client = await openRecordLab({ dataset, store, transport, profile });
        if (client.state().outbox.length !== 1) throw new Error('REHEARSAL_PENDING_LOST');
        return client.state();
    });
    const bundle = createRecovery({ dataset, state, profile });
    const restored = restoreRecovery({ dataset, bundle: { ...bundle, state: { ...bundle.state, view: {} } }, profile });
    if (restored.outbox.length !== 1 || weeklyPlanState(restored.view, day).current?.days[0] !== '恢复演练计划' ||
        restored.view.daily_ratings[0]?.score !== null || !restored.view.todos.find(todo => todo.id === id(3))?.deleted ||
        restored.view.todos.find(todo => todo.id === id(1))?.content !== '另一端修改') throw new Error('REHEARSAL_RECOVERY_MISMATCH');
    const client = await openRecordLab({ dataset, store: new MemoryStore(restored), transport, profile });
    await client.sync();
    if (client.state().outbox.length) throw new Error('REHEARSAL_PENDING_UNCONFIRMED');
    for (const source of sources) {
        if (hash(await readFile(join(directory, source.name))) !== source.sha256) throw new Error('REHEARSAL_SOURCE_CHANGED');
    }
    const material = { pin, descriptor: dataset.descriptor.bytes.toString('base64'), baseline: dataset.baseline.bytes.toString('base64'),
        received: state.artifacts.map(({ name, base64 }) => ({ name, content: base64 })) };
    await writeFile(join(directory, 'preview.json'), JSON.stringify(material, null, 2), { flag: 'wx' });
    const report = { directory, sources: sources.map(({ name, sha256 }) => ({ name, sha256 })), pin, descriptorWrites,
        records: state.artifacts.length, pendingAfterReopen: state.outbox.length, restoredPlan: true, restoredRatingClear: true,
        restoredDeletedTask: true, originalSourcesVerified: true, cancellationBlockedAfterPublishAttempt: true,
        pendingAfterSync: client.state().outbox.length };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (!process.argv[2]) throw new Error('请指定演练输出的父目录');
    console.log(JSON.stringify(await runMigrationRehearsal(process.argv[2]), null, 2));
}
