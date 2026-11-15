import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDataset } from './envelope.mjs';
import { openRecordLab } from './client.mjs';
import { FileStore } from './file-store.mjs';

export function makeDurabilityFixture() {
    const createdAt = '2026-11-05T10:00:00.000Z';
    const dataset = createDataset({ datasetId: '60000000-0000-4000-8000-000000000001', createdAt,
        data: { todos: [], notes: { baseline: 'synthetic-baseline' } } });
    const intent = number => ({ id: `60000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
        actorId: '60000000-0000-4000-8000-000000000099', createdAt,
        operations: [{ type: 'lab.note.set', key: number === 2 ? 'first' : 'second', value: number === 2 ? 'committed-before-exit' : 'candidate-at-exit' }] });
    return { dataset, first: intent(2), second: intent(3) };
}

const noNetwork = Object.fromEntries(['list', 'read', 'write'].map(name => [name, async () => { throw new Error('DURABILITY_TEST_NETWORK_FORBIDDEN'); }]));
export async function runDurabilityWorker({ directory, stage, termination }) {
    if (!['before-write', 'tmp-fsynced', 'renamed'].includes(stage) || !['exit', 'kill'].includes(termination) || !process.send) throw new Error('INVALID_DURABILITY_WORKER');
    const fixture = makeDurabilityFixture();
    let armed = false;
    const store = new FileStore(directory, { async onStage(event) {
        if (!armed || event.artifactCount !== 2 || event.stage !== stage) return;
        const message = { type: 'durability-stage', stage, termination, lease: store.leaseInfo(), artifactCount: event.artifactCount, outboxCount: event.outboxCount };
        await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
        if (termination === 'exit') process.exit(91);
        // 父进程收到握手后真实终止此子进程；不是抛异常后继续使用内存对象。
        const keepAlive = setInterval(() => {}, 1000);
        await new Promise(() => {});
        clearInterval(keepAlive);
    } });
    const client = await openRecordLab({ dataset: fixture.dataset, store, transport: noNetwork });
    armed = true;
    await client.commit(fixture.second);
    await store.close();
    throw new Error('DURABILITY_CRASH_POINT_NOT_REACHED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [directory, stage, termination] = process.argv.slice(2);
    try { await runDurabilityWorker({ directory, stage, termination }); }
    catch { process.stderr.write('隔离持久化子进程未完成预定检查。\n'); process.exitCode = 2; }
}
