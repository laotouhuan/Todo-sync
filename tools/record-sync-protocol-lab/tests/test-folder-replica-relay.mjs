import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { encode } from '../codec.mjs';
import { createRecord } from '../envelope.mjs';
import { FileStore } from '../file-store.mjs';
import { openRecordLab } from '../client.mjs';
import { createOwnedScratch, removeOwnedScratch } from '../run-durability.mjs';
import { businessFixture } from '../business-e2e-worker.mjs';
import { scanFolderRecords } from '../folder-record-scan.mjs';
import { COLLABORATION_RECORD_PROFILE as profile } from '../collaboration-record-profile.mjs';
import { deleteSeriesWorkflow } from '../series-workflow-profile.mjs';
import { deletePreview } from '../../../windows/src/taskSeries.js';

function readReplica(directory, dataset) {
    let snapshot = new Map();
    return {
        async list() {
            const scan = await scanFolderRecords({ directory, pin: dataset.pin, profile });
            snapshot = new Map(scan.artifacts.map(item => [item.name, item.bytes]));
            return [...snapshot.keys()];
        },
        async read(name) { return snapshot.get(name) ?? null; },
        async write() { throw new Error('REPLICA_TEST_IS_READ_ONLY'); }
    };
}

const nameOf = artifact => artifact.name.split('/')[1];
const same = (left, right) => assert.deepEqual(encode(left), encode(right));

test('两份磁盘副本分别离线写入，复制乱序、冲突改名和暂时消失后仍可收敛', async () => {
    const owned = await createOwnedScratch();
    const aDir = join(owned.directory, 'replica-A'), bDir = join(owned.directory, 'replica-B');
    const aStore = new FileStore(join(owned.directory, 'A-state')), bStore = new FileStore(join(owned.directory, 'B-state'));
    const coldStore = new FileStore(join(owned.directory, 'cold-state'));
    try {
        await Promise.all([mkdir(aDir), mkdir(bDir)]);
        const fixture = businessFixture(), { dataset } = fixture;
        const edit = createRecord({ pin: dataset.pin, ...fixture.edit, profile });
        const add = createRecord({ pin: dataset.pin, ...fixture.add, profile });
        const editView = profile.project(dataset.baseline.value.data, [edit.value]);
        const operation = deleteSeriesWorkflow(deletePreview(editView, fixture.member.id, true), fixture.later);
        const deletion = createRecord({ pin: dataset.pin, ...fixture.edit, id: fixture.deleteRecordId,
            operations: [operation], parents: [edit], profile });
        const editFile = join(aDir, nameOf(edit)), deletionFile = join(aDir, nameOf(deletion)), addFile = join(bDir, nameOf(add));
        await Promise.all([
            writeFile(editFile, edit.bytes, { flag: 'wx' }),
            writeFile(deletionFile, deletion.bytes, { flag: 'wx' }),
            writeFile(addFile, add.bytes, { flag: 'wx' })
        ]);
        const openReplica = (directory, store) => openRecordLab({ dataset, store, transport: readReplica(directory, dataset), profile });
        const a = await openReplica(aDir, aStore), b = await openReplica(bDir, bStore);
        await a.sync(); await b.sync();
        assert.equal(a.state().view.task_series[0].deleted, true);
        assert.equal(b.state().view.task_series[0].deleted, false);

        await copyFile(deletionFile, join(bDir, '删除记录（同步副本）'));
        assert.equal((await b.sync()).reason, 'MISSING_DEPENDENCIES');
        assert.ok(b.state().retryNames.includes(edit.name));
        assert.equal(b.state().view.task_series[0].deleted, false);
        await copyFile(editFile, join(bDir, '原始编辑（同步副本）'));
        await copyFile(editFile, join(bDir, '原始编辑（重复副本）'));
        const receivedAdd = join(aDir, '协作新增（同步副本）');
        await copyFile(addFile, receivedAdd);
        assert.equal((await b.sync()).blocked, false);
        assert.equal((await a.sync()).blocked, false);

        const expected = a.state().view;
        same(expected, b.state().view);
        assert.equal(expected.todos[0].content, '所有者离线修改');
        assert.deepEqual(expected.todos[1].completed_dates, []);
        assert.equal(expected.todos[2].deleted, true);
        assert.equal(expected.todos[3].subtasks.length, 1);
        assert.equal(expected.time_entries[0].ended_at, fixture.later);
        assert.equal(b.state().artifacts.length, 3);

        const delayed = join(owned.directory, 'temporarily-unavailable');
        await rename(receivedAdd, delayed);
        await a.sync();
        same(a.state().view, expected);
        await rename(delayed, receivedAdd);
        const cold = await openReplica(aDir, coldStore);
        await cold.sync();
        same(cold.state().view, expected);
        assert.equal(cold.state().artifacts.length, 3);
    } finally {
        await Promise.all([aStore.close(), bStore.close(), coldStore.close()]);
        await removeOwnedScratch(owned);
    }
});

test('跨扫描发现同身份异体时保留两份证据，冻结在先前已确认视图', async () => {
    const owned = await createOwnedScratch();
    const records = join(owned.directory, 'records'), store = new FileStore(join(owned.directory, 'state'));
    try {
        await mkdir(records);
        const fixture = businessFixture(), { dataset } = fixture;
        const edit = createRecord({ pin: dataset.pin, ...fixture.edit, profile });
        const other = createRecord({ pin: dataset.pin, ...fixture.edit, operations: fixture.edit.operations.slice(0, 1), profile });
        const original = join(records, '原始记录'), hidden = join(owned.directory, '暂时不在目录');
        await writeFile(original, edit.bytes, { flag: 'wx' });
        const client = await openRecordLab({ dataset, store, transport: readReplica(records, dataset), profile });
        await client.sync();
        const before = client.state().view;
        await rename(original, hidden);
        await writeFile(join(records, '冲突副本'), other.bytes, { flag: 'wx' });
        const report = await client.sync();
        assert.equal(report.blocked, true);
        same(client.state().view, before);
        assert.ok(client.state().faults.some(fault => fault.code === 'RECORD_ID_CONTENT_CONFLICT'));
        const known = (await store.load()).artifacts.map(row => row.base64);
        assert.deepEqual(new Set(known), new Set([edit.bytes.toString('base64'), other.bytes.toString('base64')]));
    } finally {
        await store.close();
        await removeOwnedScratch(owned);
    }
});
