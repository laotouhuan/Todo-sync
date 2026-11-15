import { mkdir, readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { decode } from './codec.mjs';
import { createDataset } from './envelope.mjs';
import { openRecordLab } from './client.mjs';
import { FileStore } from './file-store.mjs';
import { NORMAL_TODO_PROFILE as profile, normalTodoOperation } from './normal-record-profile.mjs';

const recordName = /^records\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}\.json$/;

export function normalDurabilityFixture() {
    const initial = normalTodoOperation('put', { id: '50000000-0000-4000-8000-000000000100', content: '真实进程合成任务',
        created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z', future: { keep: true } }).todo;
    const dataset = createDataset({ datasetId: '50000000-0000-4000-8000-000000000001', createdAt: '2026-11-07T02:00:00Z',
        data: { version: 1, last_updated: initial.updated_at, todos: [initial], time_entries: [], daily_reviews: [],
            task_series: [], task_series_links: [], extension: ['原样保留'] }, profile });
    const intent = { id: '50000000-0000-4000-8000-000000000010', actorId: '50000000-0000-4000-8000-000000000002',
        createdAt: '2026-11-07T02:00:00Z', operations: [normalTodoOperation('delete', { ...initial, deleted: true, updated_at: '2026-11-05T00:01:00Z' })] };
    return { dataset, intent };
}

// 仅用于本次受归属标记保护的scratch目录，不是HTTP或本地同步盘验收适配器。
export function fileObjectTransport(directory, afterWrite = async () => {}) {
    const root = resolve(directory);
    const path = name => {
        if (!recordName.test(name)) throw new Error('INVALID_SCRATCH_OBJECT_NAME');
        return join(root, name);
    };
    return {
        async list() {
            try { return (await readdir(join(root, 'records'))).map(name => 'records/' + name); }
            catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        },
        async read(name) {
            try { return await readFile(path(name)); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async write(name, bytes) {
            const target = path(name);
            await mkdir(join(root, 'records'), { recursive: true });
            await writeFile(target, bytes, { flag: 'wx' });
            await afterWrite({ name, bytes: Buffer.from(bytes) });
        }
    };
}

async function run(directory, stage) {
    if (typeof process.send !== 'function') throw new Error('NORMAL_DURABILITY_IPC_REQUIRED');
    if (!['tmp-fsynced', 'renamed', 'before-upload', 'after-object-write'].includes(stage)) throw new Error('INVALID_NORMAL_DURABILITY_STAGE');
    const labRoot = await realpath(fileURLToPath(new URL('.', import.meta.url)));
    const requested = resolve(directory), actual = await realpath(requested), entry = await lstat(requested);
    const owner = decode(await readFile(join(actual, '.durability-owner.json')));
    if (!entry.isDirectory() || entry.isSymbolicLink() || requested !== actual || dirname(actual) !== labRoot ||
        owner.kind !== 'record-sync-durability-test/1' || typeof owner.token !== 'string' ||
        basename(actual) !== '.scratch-durability-' + owner.token) throw new Error('UNSAFE_NORMAL_DURABILITY_DIRECTORY');
    const fixture = normalDurabilityFixture();
    let store;
    const stop = async () => {
        await new Promise(resolveSend => process.send({ type: 'normal-record-stage', stage, lease: store.leaseInfo() }, resolveSend));
        process.exit(91);
    };
    store = new FileStore(join(directory, 'store'), { onStage: async event => {
        if (event.artifactCount === 1 && event.stage === stage) await stop();
    } });
    const transport = fileObjectTransport(join(directory, 'objects'), async () => { if (stage === 'after-object-write') await stop(); });
    const client = await openRecordLab({ ...fixture, store, transport, profile });
    await client.commit(fixture.intent);
    if (stage === 'before-upload') await stop();
    await client.sync();
    throw new Error('NORMAL_DURABILITY_STAGE_NOT_REACHED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await run(process.argv[2], process.argv[3]);
}
