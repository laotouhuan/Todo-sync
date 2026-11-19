import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordSandbox } from '../src/recordSandbox.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

for (const editQueued of [false, true]) test(`计划同步合并请求时保留排队修改：${editQueued}`, async () => {
    const entered = deferred(), release = deferred();
    let lists = 0;
    const target = { datasetId: 'ec000000-0000-4000-8000-000000000001',
        actorId: 'ec000000-0000-4000-8000-000000000002', at: '1970-01-01T00:00:00Z' };
    const invoke = async (command, args) => {
        if (command === 'prepare_record_recovery_commit') return { receipt: {}, preview: {
            operation_set: 'planning/1', baseline: Buffer.from(args.request.baseline, 'base64').toString(),
            journal: { records: [], pending: [], unread: [] }, dependencies: { missing: [] }, records: []
        } };
        if (command === 'initialize_planning_webdav') return;
        if (command === 'commit_record_recovery') return;
        assert.equal(command, 'request_record_webdav');
        assert.equal(args.action, 'list');
        lists++;
        entered.resolve(); await release.promise;
        return '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/synthetic/' +
            args.binding.pin.namespace + 'records/</d:href></d:response></d:multistatus>';
    };
    const session = await openRecordSandbox(invoke, target, () => {}, assert.fail, 60000, {
        webDav: { endpoint: 'https://example.test/dav/', directory: ['synthetic'], username: 'fake', password: 'fake' }
    });
    try {
        await entered.promise;
        const edit = editQueued ? session.change({ kind: 'rate', date: '2026-11-15', score: 3 }) : Promise.resolve();
        const manual = session.sync();
        release.resolve();
        await Promise.all([edit, manual]);
        assert.equal(lists, editQueued ? 2 : 1, '只有中间没有修改时才复用同一轮同步');
        await session.sync();
        assert.equal(lists, editQueued ? 3 : 2, '上一轮已结束后仍须重新请求云端');
    } finally { release.resolve(); await session.close(); }
});
