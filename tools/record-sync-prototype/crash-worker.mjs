import { openClient, FileStore } from './client.mjs';
import { snapshot, actorA, fileTransport } from './scenarios.mjs';

const [phase, stateDirectory, remoteDirectory, id] = process.argv.slice(2);
if (!['before-send', 'after-upload-before-ack'].includes(phase)) throw new Error('INVALID_CRASH_PHASE');
const remote = fileTransport(remoteDirectory);
const transport = { ...remote, async write(recordId, record) {
    await remote.write(recordId, record);
    // 模拟服务端已写入、客户端尚未收到确认就退出。
    process.exit(0);
} };
const client = await openClient({ snapshot, store: new FileStore(stateDirectory), transport });
await client.commit({ id, actor_id: actorA, created_at: '2026-11-05T08:00:00.000Z',
    operations: [{ type: 'rating.set', id: '60000000-0000-4000-8000-000000000001', date: '2026-11-02', score: 5 }] });
if (phase === 'before-send') process.exit(0);
await client.sync();
process.exit(2);
