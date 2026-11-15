import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../codec.mjs';
import { createDataset, createRecord, seal, validateJoin } from '../envelope.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { normalTodoOperation, NORMAL_TODO_PROFILE } from '../normal-record-profile.mjs';
import { reminderSettingsOperation, PERSONAL_CORE_PROFILE } from '../personal-record-profile.mjs';
import { PERSONAL_LEARNING_PROFILE as profile, timeEntryOperation, dailyReviewOperation } from '../learning-record-profile.mjs';
import { businessVectors } from '../business-vectors.mjs';

const id = number => `90000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const time = '2026-11-07T02:00:00Z';
const later = '2026-11-07T02:01:00Z';
const old = '2026-11-04T00:00:00Z';
const timer = (fields = {}) => ({ id: id(100), task_ref: { todo_id: '历史任务' }, started_at: '2026-11-07T01:00:00Z',
    created_at: time, updated_at: time, ...fields });
const review = (fields = {}) => ({ id: id(200), date: '2026-11-07', created_at: time, updated_at: time, ...fields });
const timeOp = raw => timeEntryOperation(raw.deleted ? 'delete' : 'put', raw);
const reviewOp = raw => dailyReviewOperation(raw.deleted ? 'delete' : 'put', raw);
const todoOp = (fields = {}) => normalTodoOperation(fields.deleted ? 'delete' : 'put', { id: id(300), content: '任务', created_at: time, updated_at: time, ...fields });
const baseline = (fields = {}) => ({ version: 1, last_updated: time, todos: [],
    reminder_settings: { updated_at: null, enabled: true, privacy_mode: false, global_rules: [] },
    time_entries: [], daily_reviews: [], task_series: [{ opaque: '系列保留' }], task_series_links: [{ opaque: '关联保留' }],
    future: { original: ['原值'] }, ...fields });
const dataset = data => createDataset({ datasetId: id(1), createdAt: time, data: data ?? baseline(), profile });
const intent = (number, operations, createdAt = time) => ({ id: id(number), actorId: id(2), createdAt, operations });
const record = (data, number, operations, fields = {}) => createRecord({ pin: data.pin, ...intent(number, operations), profile, ...fields });
const open = (data, store = new MemoryStore(), transport = memoryTransport()) => openRecordLab({ dataset: data, store, transport, profile });
const same = (actual, expected) => assert.deepEqual(encode(actual), encode(expected));

for (const sample of businessVectors().filter(item => item.domain === 'review')) {
    test(`原复盘黄金样本 ${sample.id}：同日整篇规则不因日志顺序改变`, async () => {
        const seeded = sample.records.map(item => ({ id: item.id, date: item.date, created_at: old }));
        const data = dataset(baseline({ daily_reviews: seeded }));
        for (const values of [sample.records, [...sample.records].reverse()]) {
            const records = values.map((value, index) => record(data, index + 10, [reviewOp(value)]));
            const transport = memoryTransport(records);
            transport.list = async () => [records[1]?.name ?? records[0].name, records[0].name, records[0].name];
            const client = await open(data, new MemoryStore(), transport);
            await client.sync();
            same(client.state().view.daily_reviews, sample.winners);
            assert.equal(client.state().artifacts.length, records.length);
            const cold = await open(data, new MemoryStore(), memoryTransport(records));
            await cold.sync(); same(cold.state().view, client.state().view);
        }
    });
}

test('实验Schema逐已知学习属性引用根契约，完整操作补默认且允许旧引用身份', () => {
    const url = new URL('../learning-record-profile.schema.json', import.meta.url);
    const schema = JSON.parse(readFileSync(url, 'utf8'));
    const root = JSON.parse(readFileSync(new URL('../../../todo_data.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(schema.definitions.timeEntry.properties).sort(), Object.keys(root.properties.time_entries.items.properties).sort());
    assert.deepEqual(Object.keys(schema.definitions.review.properties).sort(), Object.keys(root.properties.daily_reviews.items.properties).sort());
    assert.equal(schema.definitions.timeEntry.properties.id.format, undefined);
    assert.equal(schema.definitions.timeEntry.properties.task_ref.properties.todo_id.format, undefined);
    assert.equal(schema.definitions.review.properties.id.format, undefined);
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.$ref) {
            const [path, pointer] = value.$ref.split('#');
            let resolved = path ? JSON.parse(readFileSync(new URL(path, url), 'utf8')) : schema;
            for (const key of pointer ? pointer.slice(1).split('/') : []) resolved = resolved[key.replaceAll('~1', '/').replaceAll('~0', '~')];
            assert.notEqual(resolved, undefined, value.$ref);
        }
        Object.values(value).forEach(visit);
    };
    visit(schema);
    const entry = timeOp(timer()).entry, value = reviewOp(review()).review;
    for (const key of schema.definitions.timeEntry.required) assert.ok(Object.hasOwn(entry, key));
    for (const key of schema.definitions.timeEntry.properties.task_ref.required) assert.ok(Object.hasOwn(entry.task_ref, key));
    for (const key of schema.definitions.review.required) assert.ok(Object.hasOwn(value, key));
    same(entry.task_ref, { todo_id: '历史任务', source_type: 'personal', source_id: null });
    assert.equal(entry.ended_at, null); assert.equal(entry.task_content_snapshot, ''); assert.equal(entry.label_snapshot, null);
    assert.equal(value.fact, ''); assert.equal(value.obstacle, ''); assert.equal(value.effective_action, ''); assert.equal(value.next_step, '');
});

test('旧基线仅缺更新时间和默认字段时固定补齐，不丢记录或伪造结束时间', async () => {
    const legacyTimer = timer({ id: '旧计时' }); delete legacyTimer.updated_at;
    const legacyReview = review({ id: '旧复盘' }); delete legacyReview.updated_at;
    const data = dataset(baseline({ time_entries: [legacyTimer], daily_reviews: [legacyReview] })), client = await open(data);
    const entry = client.state().view.time_entries[0], value = client.state().view.daily_reviews[0];
    assert.equal(entry.updated_at, legacyTimer.created_at); assert.equal(entry.ended_at, null); assert.equal(entry.deleted, false);
    assert.equal(value.updated_at, legacyReview.created_at); assert.equal(value.fact, ''); assert.equal(value.deleted, false);
    for (const rows of [{ time_entries: null }, { daily_reviews: {} }, { time_entries: [timer({ deleted: null })] },
        { time_entries: [timer({ task_ref: null })] }, { time_entries: [timer({ task_content_snapshot: null })] },
        { daily_reviews: [review({ fact: null })] }, { daily_reviews: [review({ updated_at: null })] }]) {
        assert.throws(() => dataset(baseline(rows)), /INVALID_|EXPECTED_/);
    }
});

test('新操作严格校验已知类型、时钟与日期，拒绝未归一wire及删除类型伪装', () => {
    const missingTimer = timer(); delete missingTimer.updated_at;
    const missingReview = review(); delete missingReview.updated_at;
    assert.throws(() => timeOp(missingTimer), /UPDATE_CLOCK_REQUIRED/);
    assert.throws(() => reviewOp(missingReview), /UPDATE_CLOCK_REQUIRED/);
    for (const entry of [timer({ updated_at: '2026-11-07T02:00:00' }), timer({ started_at: '2026-02-30T01:00:00Z' }),
        timer({ ended_at: '2026-11-07T00:00:00Z' }), timer({ ended_at: false }), timer({ label_snapshot: 3 }),
        timer({ task_ref: { todo_id: '历史', source_type: 'future' } }), timer({ task_ref: { todo_id: '历史', source_id: 3 } })]) {
        assert.throws(() => timeOp(entry), /INVALID_/);
    }
    for (const value of [review({ date: '2026-02-30' }), review({ date: '2026-2-3' }), review({ date: 3 }), review({ next_step: 3 })]) {
        assert.throws(() => reviewOp(value), /INVALID_/);
    }
    assert.throws(() => profile.validateOperation({ type: 'time.entry.put', entry: timer() }), /NON_NORMALIZED/);
    assert.throws(() => profile.validateOperation({ type: 'daily.review.put', review: review() }), /NON_NORMALIZED/);
    assert.throws(() => profile.validateOperation({ type: 'time.entry.delete', entry: timeOp(timer()).entry }), /DELETE_KIND_MISMATCH/);
    assert.throws(() => profile.validateOperation({ type: 'daily.review.delete', review: reviewOp(review()).review }), /DELETE_KIND_MISMATCH/);
    assert.throws(() => profile.validateOperation({ ...timeOp(timer()), data: baseline() }), /UNSUPPORTED_OPERATION/);
});

test('计时同ID较新整条胜出，平局删除优先、其余按原canonicalLearning内容键', async () => {
    const cases = [
        [timer({ task_content_snapshot: '旧内容', label_snapshot: '旧标签' }), timer({ task_content_snapshot: '较新整条', updated_at: later }), '较新整条', false],
        [timer({ task_content_snapshot: '较长但未删' }), timer({ task_content_snapshot: '删', deleted: true, ended_at: null }), '删', true],
        [timer({ task_content_snapshot: 'z' }), timer({ task_content_snapshot: 'aa' }), 'aa', false],
        [timer({ task_content_snapshot: 'z', updated_at: '2026-11-07T02:00:00.0009Z' }), timer({ task_content_snapshot: 'aa', updated_at: '2026-11-07T02:00:00.0001Z' }), 'aa', false]
    ];
    for (const [a, b, expectedContent, deleted] of cases) for (const values of [[a, b], [b, a]]) {
        const data = dataset(), records = values.map((value, index) => record(data, index + 10, [timeOp(value)]));
        const client = await open(data, new MemoryStore(), memoryTransport(records)); await client.sync();
        const result = client.state().view.time_entries[0];
        assert.equal(result.task_content_snapshot, expectedContent); assert.equal(result.deleted, deleted);
        if (expectedContent === '较新整条') assert.equal(result.label_snapshot, null);
    }
});

test('删除及恢复均是明确完整候选，不给运行记录自动补结束时间', async () => {
    const data = dataset(), client = await open(data);
    await client.commit(intent(10, [timeOp(timer()), reviewOp(review({ fact: '初稿' }))]));
    assert.throws(() => timeEntryOperation('delete', timer({ deleted: true, updated_at: later })), /DELETE_END_STATE_REQUIRED/);
    await client.commit(intent(11, [timeOp(timer({ deleted: true, ended_at: null, updated_at: later })), reviewOp(review({ fact: '删除稿', deleted: true, updated_at: later }))]));
    assert.equal(client.state().view.time_entries[0].deleted, true); assert.equal(client.state().view.time_entries[0].ended_at, null);
    assert.equal(client.state().view.daily_reviews[0].deleted, true);
    const resumed = '2026-11-07T02:02:00Z';
    await client.commit(intent(12, [timeOp(timer({ updated_at: resumed, task_content_snapshot: '重新恢复' })), reviewOp(review({ updated_at: resumed, fact: '重新填写' }))]));
    assert.equal(client.state().view.time_entries[0].deleted, false); assert.equal(client.state().view.time_entries[0].ended_at, null);
    assert.equal(client.state().view.daily_reviews[0].deleted, false); assert.equal(client.state().view.daily_reviews[0].fact, '重新填写');
});

test('因果后继并不推翻较新业务时钟；复盘不同ID同日仍选整篇而不拼字段', async () => {
    const data = dataset(), client = await open(data);
    const original = review({ id: id(201), fact: '较新事实', next_step: '', updated_at: later });
    await client.commit(intent(10, [timeOp(timer({ task_content_snapshot: '较新时钟', updated_at: later })), reviewOp(original)]));
    await client.commit(intent(11, [timeOp(timer({ task_content_snapshot: '因果后写但旧时钟' })), reviewOp(review({ id: id(202), next_step: '另一端下一步' }))]));
    assert.equal(client.state().view.time_entries[0].task_content_snapshot, '较新时钟');
    same(client.state().view.daily_reviews, [reviewOp(original).review]);
    assert.equal(client.state().view.daily_reviews[0].next_step, '');
});

test('两端并发开始多个计时不自动互相结束，缺失或删除任务引用也保留', async () => {
    const data = dataset(baseline({ todos: [todoOp({ deleted: true }).todo] })), transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    await a.commit(intent(10, [timeOp(timer({ id: id(101), task_ref: { todo_id: id(300) } }))]));
    await b.commit({ ...intent(11, [timeOp(timer({ id: id(102), task_ref: { todo_id: '已缺失任务' }, started_at: '2099-01-01T00:00:00Z' }))]), actorId: id(3) });
    await a.sync(); await b.sync(); await a.sync();
    same(a.state().view, b.state().view);
    assert.equal(a.state().view.time_entries.length, 2);
    assert.ok(a.state().view.time_entries.every(entry => !entry.deleted && entry.ended_at === null));
});

test('正常任务删除、改名或改标签不改写历史计时快照和协作来源', async () => {
    const data = dataset(), client = await open(data);
    const source = { todo_id: '协作旧任务', source_type: 'collaboration', source_id: '旧协作源', extra: ['引用原值'] };
    const entry = timer({ task_ref: source, task_content_snapshot: '历史正文', label_snapshot: ' \ufeffe\u0301 ' });
    await client.commit(intent(10, [todoOp({ label: '当前标签' }), timeOp(entry)]));
    await client.commit(intent(11, [todoOp({ deleted: true, content: '新名', label: '新标签', updated_at: later })]));
    const result = client.state().view.time_entries[0];
    same(result.task_ref, source); assert.equal(result.task_content_snapshot, '历史正文'); assert.equal(result.label_snapshot, 'é');
    assert.equal(result.ended_at, null); assert.equal(result.deleted, false);
});

test('计时与复盘旧ID上下文分别保留，输掉同日归并的旧复盘也可继续编辑', async () => {
    const seeded = baseline({ todos: [todoOp({ id: '旧任务', subtasks: [{ id: '旧子任务', content: '原值' }] }).todo],
        reminder_settings: { updated_at: null, global_rules: [{ id: '旧提醒', time: '09:00' }] },
        time_entries: [timer({ id: '旧计时' })], daily_reviews: [review({ id: '旧复盘甲', fact: 'z' }), review({ id: '旧复盘乙', fact: 'aa' })] });
    const data = dataset(seeded), client = await open(data);
    assert.equal(client.state().view.daily_reviews[0].id, '旧复盘乙');
    await client.commit(intent(10, [timeOp(timer({ id: '旧计时', updated_at: later })), reviewOp(review({ id: '旧复盘甲', fact: '较新重新编辑', updated_at: later }))]));
    assert.equal(client.state().view.daily_reviews[0].id, '旧复盘甲');
    for (const borrowed of ['旧任务', '旧子任务', '旧提醒', '旧复盘甲']) {
        await assert.rejects(client.commit(intent(11, [timeOp(timer({ id: borrowed }))])), /INVALID_NEW_TIME_ENTRY_ID/);
    }
    for (const borrowed of ['旧任务', '旧子任务', '旧提醒', '旧计时']) {
        await assert.rejects(client.commit(intent(11, [reviewOp(review({ id: borrowed }))])), /INVALID_NEW_DAILY_REVIEW_ID/);
    }
    assert.equal(client.state().artifacts.length, 1); assert.equal(client.state().faults.length, 0);
});

test('旧复盘ID只能在已有的各自日期复用，新日期需要UUIDv4', async () => {
    const legacyId = '跨日旧复盘';
    const rows = [review({ id: legacyId, date: '2026-11-06', fact: '六日原文' }),
        review({ id: legacyId, date: '2026-11-07', fact: '七日原文' })];
    const data = dataset(baseline({ daily_reviews: rows })), store = new MemoryStore();
    const client = await open(data, store);
    same(client.state().view.daily_reviews, rows.map(row => reviewOp(row).review));
    await client.commit(intent(10, rows.map(row => reviewOp({ ...row, fact: '原日期可编辑', updated_at: later }))));
    assert.ok(client.state().view.daily_reviews.every(row => row.fact === '原日期可编辑'));

    const before = encode(await store.load());
    const next = review({ date: '2026-11-08', fact: '新日期', updated_at: later });
    await assert.rejects(client.commit(intent(11, [reviewOp({ ...next, id: legacyId })])), /INVALID_NEW_DAILY_REVIEW_ID/);
    assert.deepEqual(encode(client.state()), before);
    assert.deepEqual(encode(await store.load()), before);

    await client.commit(intent(11, [reviewOp(next)]));
    same(client.state().view.daily_reviews[2], reviewOp(next).review);
});

test('正常与学习混合批次context故障本地无半批、无outbox，远端与恢复保留整条原记录', async () => {
    const data = dataset(), store = new MemoryStore(), transport = memoryTransport(), client = await open(data, store, transport);
    const operations = [todoOp(), timeOp(timer()), reviewOp(review({ id: '错误的新复盘ID' }))];
    const before = encode(await store.load());
    await assert.rejects(client.commit(intent(10, operations)), /INVALID_NEW_DAILY_REVIEW_ID/);
    assert.deepEqual(encode(await store.load()), before); assert.equal(transport.files.size, 0);
    const bad = record(data, 10, operations), remote = await open(data, new MemoryStore(), memoryTransport([bad]));
    await remote.sync();
    assert.equal(remote.state().blocked, true); assert.equal(remote.state().view.todos.length, 0); assert.equal(remote.state().view.time_entries.length, 0);
    assert.equal(remote.state().artifacts[0].base64, bad.bytes.toString('base64'));
    const bundle = createRecovery({ dataset: data, state: remote.state(), profile });
    const restored = restoreRecovery({ dataset: data, bundle, profile });
    assert.equal(restored.blocked, true); assert.equal(restored.view.time_entries.length, 0);
    assert.equal(restored.artifacts[0].base64, bad.bytes.toString('base64'));
});

test('未知学习操作或第二项坏类型整批拒绝，不先应用有效普通任务', async () => {
    const data = dataset(), valid = record(data, 10, [todoOp(), timeOp(timer())]);
    for (const operation of [{ type: 'time.entry.replaceAll' }, { type: 'time.entry.put', entry: { ...timeOp(timer()).entry, deleted: 'false' } }]) {
        const bad = seal('record', { ...valid.value, operations: [todoOp(), operation] });
        const client = await open(data, new MemoryStore(), memoryTransport([bad])); await client.sync();
        assert.equal(client.state().blocked, true); assert.equal(client.state().view.todos.length, 0);
        assert.ok(client.state().faults.some(fault => fault.base64 === bad.bytes.toString('base64')));
    }
});

test('未知字段和proto引用原位保留，清空缓存与旧恢复包并集不覆盖新学习记录', async () => {
    const extension = JSON.parse('{"__proto__":{"n":1e-7},"2":"原值","10":"原值"}');
    const source = { todo_id: '历史引用', source_type: 'collaboration', source_id: '协作来源', extension };
    const original = timer({ task_ref: source, task_content_snapshot: '历史快照', label_snapshot: '课程', extension });
    const data = dataset(), transport = memoryTransport(), client = await open(data, new MemoryStore(), transport);
    const reminder = reminderSettingsOperation({ updated_at: time, enabled: false });
    await client.commit(intent(10, [todoOp(), reminder, timeOp(original), reviewOp(review({ fact: '原文', extension }))]));
    const oldBundle = createRecovery({ dataset: data, state: client.state(), profile });
    await client.commit(intent(11, [timeOp({ ...original, updated_at: later, ended_at: '2026-11-07T02:00:00Z' }),
        reviewOp(review({ fact: '较新整篇', updated_at: later, extension }))], later));
    await client.sync();
    const expected = client.state().view, forged = client.state(); forged.view = { time_entries: [], daily_reviews: [] };
    const restored = restoreRecovery({ dataset: data, currentState: forged, bundle: oldBundle, profile });
    same(restored.view, expected); assert.equal(restored.artifacts.length, 2); assert.equal(restored.outbox.length, 1);
    const reopened = await open(data, new MemoryStore(restored), transport); await reopened.sync();
    same(reopened.state().view, expected); assert.equal(reopened.state().outbox.length, 0);
    const cold = await open(data, new MemoryStore(), transport); await cold.sync(); same(cold.state().view, expected);
    same(expected.time_entries[0].task_ref, source); same(expected.time_entries[0].extension, extension);
    same(expected.reminder_settings, reminder.settings);
    for (const key of ['task_series', 'task_series_links', 'future']) same(expected[key], data.baseline.value.data[key]);
});

test('新学习profile与原normal/core显式互拒，旧能力集合不自动解释新记录', async () => {
    const data = dataset(), operation = timeOp(timer());
    assert.equal(data.descriptor.value.operation_set, 'lab-personal-learning/1');
    for (const oldProfile of [NORMAL_TODO_PROFILE, PERSONAL_CORE_PROFILE]) {
        const oldDataset = createDataset({ datasetId: id(1), createdAt: time, data: baseline(), profile: oldProfile });
        assert.throws(() => oldProfile.validateOperation(operation), /UNSUPPORTED_OPERATION/);
        assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, oldProfile), /INVALID_DATASET_BINDING/);
        assert.throws(() => validateJoin(oldDataset.pin, oldDataset.descriptor.bytes, oldDataset.baseline.bytes, profile), /INVALID_DATASET_BINDING/);
        await assert.rejects(openRecordLab({ dataset: data, store: new MemoryStore(), transport: memoryTransport(), profile: oldProfile }), /INVALID_DATASET_BINDING/);
    }
});

test('归一与重放不读取当前时钟，不生成UUID，也不使用当前日期强行结束记录', () => {
    const data = baseline(), operations = [timeOp(timer()), reviewOp(review({ fact: '原文' }))];
    const records = [{ created_at: later, operations }];
    const ActualDate = globalThis.Date, actualRandom = crypto.randomUUID;
    try {
        globalThis.Date = class extends ActualDate {
            constructor(...args) { if (!args.length) throw new Error('CURRENT_TIME_READ'); super(...args); }
            static now() { throw new Error('CURRENT_TIME_READ'); }
        };
        crypto.randomUUID = () => { throw new Error('RANDOM_ID_CREATED'); };
        const result = profile.project(data, records);
        assert.equal(result.time_entries[0].ended_at, null); assert.equal(result.daily_reviews[0].fact, '原文');
        assert.equal(result.last_updated, later);
    } finally { globalThis.Date = ActualDate; crypto.randomUUID = actualRandom; }
});
