import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createOwnedScratch, removeOwnedScratch } from '../run-durability.mjs';
import { businessFixture } from '../business-e2e-worker.mjs';
import { createDataset, createRecord, inspect } from '../envelope.mjs';
import { scanFolderRecords } from '../folder-record-scan.mjs';
import { COLLABORATION_RECORD_PROFILE as profile } from '../collaboration-record-profile.mjs';

async function withFolder(run) {
    const owned = await createOwnedScratch();
    const directory = join(owned.directory, 'records');
    try {
        await mkdir(directory);
        const fixture = businessFixture();
        await run({ ...fixture, directory, scan: () => scanFolderRecords({ directory, pin: fixture.dataset.pin, profile }) });
    } finally { await removeOwnedScratch(owned); }
}

test('文件夹冲突副本按记录字节归并，内容一致时去重，任意副本名可以恢复缺失的原名', () => withFolder(async fixture => {
    const { dataset, directory, scan } = fixture;
    const a = createRecord({ pin: dataset.pin, ...fixture.edit, profile });
    const b = createRecord({ pin: dataset.pin, ...fixture.add, profile });
    await writeFile(join(directory, a.name.split('/')[1]), a.bytes);
    await writeFile(join(directory, 'A (冲突副本).json'), a.bytes);
    await writeFile(join(directory, 'B.json (同步副本)'), b.bytes);
    const result = await scan();
    assert.equal(result.unresolved, false);
    assert.deepEqual(result.artifacts.map(row => row.name).sort(), [a.name, b.name].sort());
    assert.equal(result.evidence.filter(row => row.result === 'duplicate').length, 1);
    const checked = inspect(dataset.pin, result.artifacts, profile);
    const view = profile.project(dataset.baseline.value.data, checked.ordered);
    assert.equal(view.todos[0].content, '所有者离线修改');
    assert.deepEqual(view.todos[1].completed_dates, []);
    assert.equal(view.todos[3].content, '协作者新增月任务');
    assert.deepEqual(await readFile(join(directory, 'B.json (同步副本)')), b.bytes);
}));

test('同 ID 的不同副本保留两份原件，不能静默选一份', () => withFolder(async fixture => {
    const { dataset, directory, scan } = fixture;
    const a = createRecord({ pin: dataset.pin, ...fixture.edit, profile });
    const b = createRecord({ pin: dataset.pin, ...fixture.edit, operations: fixture.edit.operations.slice(0, 1), profile });
    await writeFile(join(directory, '甲副本'), a.bytes);
    await writeFile(join(directory, '乙副本'), b.bytes);
    const result = await scan();
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.unresolved, true);
    assert.ok(result.evidence.some(row => row.result === 'identity-conflict'));
    assert.throws(() => inspect(dataset.pin, result.artifacts, profile), /RECORD_ID_CONTENT_CONFLICT/);
    assert.deepEqual(await readFile(join(directory, '甲副本')), a.bytes);
    assert.deepEqual(await readFile(join(directory, '乙副本')), b.bytes);
}));

test('坏正文、异数据集、改坏的规范文件名和未知目录均标为待核对', () => withFolder(async fixture => {
    const { dataset, directory, scan } = fixture;
    const a = createRecord({ pin: dataset.pin, ...fixture.edit, profile });
    const foreign = createDataset({ datasetId: 'f1234567-1234-4234-8234-123456789abc', createdAt: fixture.edit.createdAt,
        data: dataset.baseline.value.data, profile });
    const wrong = createRecord({ pin: foreign.pin, ...fixture.edit, profile });
    await writeFile(join(directory, a.name.split('/')[1]), wrong.bytes);
    await writeFile(join(directory, '异数据集副本.json'), wrong.bytes);
    await writeFile(join(directory, '暂时半写入.json'), '{');
    await mkdir(join(directory, '未知目录'));
    const result = await scan();
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.unresolved, true);
    assert.deepEqual(result.evidence.map(row => row.result).sort(),
        ['unresolved-entry', 'unresolved-record', 'unresolved-record', 'unresolved-record']);
}));
