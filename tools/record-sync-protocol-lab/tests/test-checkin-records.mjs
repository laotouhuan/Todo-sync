import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createDataset, createRecord, seal, validateJoin } from '../envelope.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { checkinOperation, PERSONAL_CHECKIN_PROFILE as profile } from '../checkin-record-profile.mjs';
import { PERSONAL_LEARNING_PROFILE, dailyReviewOperation } from '../learning-record-profile.mjs';

const id = number => `90000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const day = '2026-11-05';
const before = '2026-11-07T01:59:59.999999Z';
const at = '2026-11-07T02:00:00.000Z';
const after = '2026-11-07T02:00:00.001Z';
const todoId = '旧周期任务';
const period = (fields = {}) => ({ id: todoId, content: '阅读', date: '2026-W45', task_type: 'weekly_checkin',
    completed_dates: [day], target_count: 1, completed: true, completed_at: at,
    created_at: before, updated_at: at, extension: { keep: ['原值'] }, ...fields });
const baseline = (todos = [period()]) => ({ version: 1, last_updated: at, todos, task_series: [{ opaque: '系列' }] });
const dataset = (data = baseline()) => createDataset({ datasetId: id(1), createdAt: at, data, profile });
const mark = (updated_at, value = day, fields = {}) => checkinOperation('mark', { todo_id: todoId, day, updated_at, value, ...fields });
const clear = (updated_at = at, fields = {}) => checkinOperation('clear', { todo_id: todoId, day, updated_at, ...fields });
const intent = (number, operations, actor = 2) => ({ id: id(number), actorId: id(actor), createdAt: at, operations });
const record = (data, number, operations) => createRecord({ pin: data.pin, ...intent(number, operations), profile });
const open = (data, store = new MemoryStore(), transport = memoryTransport()) => openRecordLab({ dataset: data, store, transport, profile });
const project = (data, operations) => profile.project(data, operations.map(operation => ({ created_at: at, operations: [operation] })));
const same = (actual, expected) => assert.deepEqual(encode(actual), encode(expected));

test('日期与动作时间独立，按实际毫秒拒绝同刻补卡并保留下一毫秒补卡', () => {
    const oldLong = '2026-11-05T09:00:00.000000+08:00';
    const equal = '2026-11-07T10:00:00.000999+08:00';
    assert.deepEqual(project(baseline(), [mark(before, oldLong), clear(), mark(equal)]).todos[0].completed_dates, []);
    assert.deepEqual(project(baseline(), [mark(after), clear(), mark(equal, oldLong)]).todos[0].completed_dates, [day]);
    assert.deepEqual(project(baseline(), [clear(before), mark(at), clear(after)]).todos[0].completed_dates, []);
});

test('同日补卡继续较长优先、等长比较实际时间及 UTF-16 平局', () => {
    const earlier = '2026-11-05T11:00:00+08:00';
    const later = '2026-11-05T09:00:00+05:00';
    const sameInstant = '2026-11-05T12:00:00+08:00';
    const long = '2026-11-05T10:00:00.000+08:00';
    for (const [values, expected] of [
        [[earlier, later], later],
        [[later, sameInstant], sameInstant],
        [[sameInstant, long], long]
    ]) {
        const operations = values.map(value => mark(after, value));
        for (const order of [operations, operations.toReversed()]) {
            assert.deepEqual(project(baseline(), order).todos[0].completed_dates, [expected]);
            assert.deepEqual(project(baseline(), [...order, clear()]).todos[0].completed_dates, [expected]);
        }
    }
});

test('销卡作用于指定任务和日期，其它基线日期、扩展和系列原样保留', () => {
    const original = period({ completed_dates: [day, '2026-11-06', '旧格式'] });
    const other = period({ id: '另一个月任务', date: '2026-11', task_type: 'monthly_checkin' });
    const data = baseline([original, other]);
    const output = project(data, [clear()]);
    const result = output.todos.find(todo => todo.id === todoId);
    same(result, { ...original, completed_dates: ['2026-11-06', '旧格式'] });
    same(output.todos.find(todo => todo.id === other.id), other);
    same(output.task_series, data.task_series);
    same(data.todos[0], original);
});

test('缺项和空销卡无副作用，原日期中可识别的旧格式仍可被明确清除', () => {
    const legacy = period({ completed_dates: ['2026-11-04', '2026-11-05T历史未知格式', '2026-11-06', '2026-11-06'] });
    const data = baseline([legacy]);
    same(project(data, []).todos[0], legacy);
    same(project(data, [clear(at, { day: '2026-11-03' })]).todos[0], legacy);
    assert.deepEqual(project(data, [clear()]).todos[0].completed_dates, ['2026-11-04', '2026-11-06', '2026-11-06']);
});

test('仅在日期结果变化时重算有目标的周期完成状态，补达目标不伪造时间', () => {
    const cleared = project(baseline(), [clear()]).todos[0];
    assert.equal(cleared.completed, false);
    assert.equal(cleared.completed_at, null);
    assert.equal(cleared.updated_at, at);
    const incomplete = period({ completed: false, completed_at: null, completed_dates: [] });
    const marked = project(baseline([incomplete]), [mark(after)]).todos[0];
    assert.equal(marked.completed, true);
    assert.equal(marked.completed_at, null);
    const manual = period({ target_count: null });
    same(project(baseline([manual]), [clear()]).todos[0], { ...manual, completed_dates: [] });
});

test('ISO 跨年周、跨时区日历日及月份计数使用日期前缀与去重', () => {
    const weekly = period({ date: '2020-W53', completed_dates: ['2021-01-03', '2021-01-03'], target_count: 2, completed: false });
    const sunday = '2021-01-03', friday = '2021-01-01', outside = '2021-01-04';
    const add = (day, value) => mark(after, value, { day });
    assert.equal(project(baseline([weekly]), [add(outside, outside)]).todos[0].completed, false);
    const value = '2021-01-01T00:00:00+14:00';
    const weeklyResult = project(baseline([weekly]), [add(friday, value)]).todos[0];
    assert.equal(weeklyResult.completed, true);
    assert.deepEqual(weeklyResult.completed_dates, [sunday, sunday, value]);
    const monthly = period({ date: '2021-01', task_type: 'monthly_checkin', completed_dates: [], completed: false });
    assert.equal(project(baseline([monthly]), [add(friday, value)]).todos[0].completed, true);
});

test('动作验证拒绝无时区时钟、非法日、值与日期不符和销卡携带值', () => {
    for (const make of [
        () => mark('2026-11-07T02:00:00'),
        () => clear('2026-11-07T02:00:00+24:00'),
        () => clear(at, { day: '2026-02-29' }),
        () => clear(at, { todo_id: '' }),
        () => clear(at, { value: day }),
        () => mark(at, '2026-11-06T01:00:00+14:00'),
        () => mark(at, '2026-11-05T25:00:00Z'),
        () => mark(at, day, { metadata: true })
    ]) assert.throws(make, /INVALID_CHECKIN_OPERATION|INVALID_TODO_TIMESTAMP|CHECKIN_VALUE_DAY_MISMATCH/);
    assert.equal(mark(at, '2026-11-05T23:00:00-08:00').day, day);
    assert.throws(() => PERSONAL_LEARNING_PROFILE.validateOperation(clear()), /UNSUPPORTED_OPERATION/);
    const data = dataset();
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, PERSONAL_LEARNING_PROFILE), /INVALID_DATASET_BINDING/);
});

test('不同目录发现顺序、重复、读失败及分批补齐最终产生同一完整视图', async () => {
    const data = dataset();
    const oldValue = '2026-11-05T09:00:00.000000+08:00';
    const records = [record(data, 10, [mark(before, oldValue)]), record(data, 11, [clear()]), record(data, 12, [mark(after)])];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const cold = await open(data, new MemoryStore(), memoryTransport(records));
    await cold.sync();
    const expected = cold.state().view;
    assert.deepEqual(expected.todos[0].completed_dates, [day]);
    for (const order of orders) {
        const transport = memoryTransport(records);
        const client = await open(data, new MemoryStore(), transport);
        const read = transport.read;
        for (const index of order) {
            const name = records[index].name;
            transport.list = async () => [name, name];
            transport.read = async candidate => candidate === name ? null : read(candidate);
            await client.sync();
            transport.read = read;
            await client.sync();
        }
        transport.list = async () => [];
        await client.sync();
        same(client.state().view, expected);
        assert.equal(client.state().artifacts.length, records.length);
    }
});

test('两端离线明确销卡与补卡，重试同记录，丢弃缓存或导入旧恢复包均可重建', async () => {
    const data = dataset(), transport = memoryTransport();
    const a = await open(data, new MemoryStore(), transport), b = await open(data, new MemoryStore(), transport);
    const clearIntent = intent(10, [clear()]);
    await a.commit(clearIntent);
    const oldBundle = createRecovery({ dataset: data, state: a.state(), profile });
    await b.commit(intent(11, [mark(before, '2026-11-05T09:00:00.000Z')], 3));
    await b.commit(intent(12, [mark(after)], 3));
    const write = transport.write;
    let loseResponse = true;
    transport.write = async (name, bytes) => {
        await write(name, bytes);
        if (loseResponse) {
            loseResponse = false;
            throw new Error('模拟写入后响应丢失');
        }
    };
    await a.sync();
    await b.sync();
    await a.sync();
    await b.sync();
    same(a.state().view, b.state().view);
    assert.deepEqual(a.state().view.todos[0].completed_dates, [day]);
    assert.equal(transport.files.size, 3);
    assert.equal(a.state().outbox.length, 0);
    const stale = a.state(); stale.view = { todos: [] };
    const restored = restoreRecovery({ dataset: data, currentState: stale, bundle: oldBundle, profile });
    same(restored.view, a.state().view);
    const cold = await open(data, new MemoryStore(), transport);
    await cold.sync();
    same(cold.state().view, a.state().view);
    assert.equal(cold.state().artifacts.length, 3);
});

test('非法目标导致混合批次原子拒绝，远端冻结并保留可恢复的原始记录', async () => {
    const data = dataset(baseline([period({ deleted: true }), period({ id: '普通', date: null, task_type: 'normal', completed_at: null })]));
    const review = dailyReviewOperation('put', { id: id(42), date: day, created_at: at, updated_at: at, fact: '原文' });
    const store = new MemoryStore(), transport = memoryTransport(), client = await open(data, store, transport);
    const original = await store.load();
    for (const todo_id of [todoId, '普通', '不存在']) {
        const operations = [review, clear(at, { todo_id })];
        await assert.rejects(client.commit(intent(10, operations)), /CHECKIN_TARGET_NOT_ACTIVE_PERIOD/);
        same(await store.load(), original);
        assert.equal(transport.files.size, 0);
    }
    const bad = record(data, 10, [review, clear()]);
    const remote = await open(data, new MemoryStore(), memoryTransport([bad]));
    await remote.sync();
    assert.equal(remote.state().blocked, true);
    assert.equal(remote.state().view.daily_reviews.length, 0);
    assert.equal(remote.state().artifacts[0].base64, bad.bytes.toString('base64'));
    const bundle = createRecovery({ dataset: data, state: remote.state(), profile });
    const recovered = restoreRecovery({ dataset: data, bundle, profile });
    assert.equal(recovered.blocked, true);
    assert.equal(recovered.artifacts[0].base64, bad.bytes.toString('base64'));
    const malformed = seal('record', { ...bad.value, operations: [review, { ...clear(), value: day }] });
    const rejected = await open(data, new MemoryStore(), memoryTransport([malformed]));
    await rejected.sync();
    assert.equal(rejected.state().blocked, true);
    assert.equal(rejected.state().view.daily_reviews.length, 0);
    assert.ok(rejected.state().faults.some(fault => fault.base64 === malformed.bytes.toString('base64')));
});

test('归并不会读取当前时钟，明确打卡记录与继承的复盘操作可在同一批次应用', async () => {
    const review = dailyReviewOperation('put', { id: id(42), date: day, created_at: at, updated_at: at, fact: '原文' });
    const client = await open(dataset());
    await client.commit(intent(10, [clear(), review]));
    assert.deepEqual(client.state().view.todos[0].completed_dates, []);
    assert.equal(client.state().view.daily_reviews[0].fact, '原文');
    const RealDate = globalThis.Date;
    try {
        globalThis.Date = class extends RealDate {
            constructor(...args) {
                if (!args.length) throw new Error('CURRENT_TIME_READ');
                super(...args);
            }
            static now() { throw new Error('CURRENT_TIME_READ'); }
        };
        assert.deepEqual(project(baseline(), [clear()]).todos[0].completed_dates, []);
    } finally {
        globalThis.Date = RealDate;
    }
});
