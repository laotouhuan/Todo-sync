import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../codec.mjs';
import { createDataset, createRecord, seal, validateJoin } from '../envelope.mjs';
import { MemoryStore, memoryTransport, openRecordLab } from '../client.mjs';
import { createRecovery, restoreRecovery } from '../recovery.mjs';
import { NORMAL_TODO_PROFILE, normalTodoOperation } from '../normal-record-profile.mjs';
import { PERSONAL_CORE_PROFILE as profile, reminderSettingsOperation } from '../personal-record-profile.mjs';
import { normalizeReminderSettings } from '../../../windows/src/reminderSettingsConflict.js';

const id = number => `80000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const time = '2026-11-07T02:00:00Z';
const later = '2026-11-07T02:01:00Z';
const rule = (fields = {}) => ({ id: id(200), time: '09:00', ...fields });
const settings = (fields = {}) => normalizeReminderSettings({ updated_at: time, ...fields });
const todo = (fields = {}) => ({ id: id(100), content: '任务', created_at: time, updated_at: time, ...fields });
const normal = raw => normalTodoOperation(raw.deleted ? 'delete' : 'put', raw);
const baseline = (reminder = settings({ updated_at: null }), fields = {}) => ({ version: 1, last_updated: time, todos: [],
    reminder_settings: reminder, time_entries: [{ opaque: '计时原值' }], daily_reviews: [{ opaque: '复盘原值' }],
    task_series: [{ opaque: '系列原值' }], task_series_links: [{ opaque: '关联原值' }], future: { keep: ['扩展'] }, ...fields });
const dataset = data => createDataset({ datasetId: id(1), createdAt: time, data: data ?? baseline(), profile });
const intent = (number, operations, createdAt = time) => ({ id: id(number), actorId: id(2), createdAt, operations });
const record = (data, number, operations, fields = {}) => createRecord({ pin: data.pin, ...intent(number, operations), profile, ...fields });
const open = (data, store = new MemoryStore(), transport = memoryTransport()) => openRecordLab({ dataset: data, store, transport, profile });
const same = (actual, expected) => assert.deepEqual(encode(actual), encode(expected));
const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/reminder-settings/conflicts.json', import.meta.url), 'utf8'));
const validSamples = fixture.cases.filter(sample => {
    try { reminderSettingsOperation(sample.local.reminder_settings); reminderSettingsOperation(sample.cloud.reminder_settings); return true; }
    catch { return false; }
});

for (const sample of validSamples) test(`提醒真实业务日志 ${sample.id}：两个折叠方向与乱序冷端一致`, async () => {
    const existing = [...(sample.local.reminder_settings?.global_rules ?? []), ...(sample.cloud.reminder_settings?.global_rules ?? [])];
    const uniqueRules = [...new Map(existing.map(item => [item.id, item])).values()];
    const data = dataset(baseline(settings({ updated_at: null, global_rules: uniqueRules })));
    for (const snapshots of [[sample.local.reminder_settings, sample.cloud.reminder_settings], [sample.cloud.reminder_settings, sample.local.reminder_settings]]) {
        const records = snapshots.map((value, index) => record(data, index + 10, [reminderSettingsOperation(value)]));
        const transport = memoryTransport(records);
        transport.list = async () => [records[1].name, records[0].name, records[1].name];
        const client = await open(data, new MemoryStore(), transport);
        await client.sync();
        same(client.state().view.reminder_settings, sample.winner);
        assert.equal(client.state().artifacts.length, 2);
        transport.list = async () => []; await client.sync();
        same(client.state().view.reminder_settings, sample.winner);
        const cold = await open(data, new MemoryStore(), memoryTransport(records));
        await cold.sync(); same(cold.state().view, client.state().view);
    }
});

test('共享样本只将有效独立提醒时钟接成新操作，旧时钟仅在固定基线兼容', async () => {
    assert.equal(validSamples.length, 13);
    for (const sample of fixture.cases.filter(item => !validSamples.includes(item))) {
        const original = sample.local.reminder_settings;
        const data = dataset(baseline(original));
        const client = await open(data);
        await client.commit(intent(10, [normal(todo())], '2099-01-01T00:00:00Z'));
        same(client.state().view.reminder_settings, normalizeReminderSettings(original));
        assert.equal(client.state().view.last_updated, '2099-01-01T00:00:00Z');
    }
});

test('实验Schema的全部已知提醒字段引用根契约，完整归一输出补齐required且保留扩展', () => {
    const url = new URL('../personal-record-profile.schema.json', import.meta.url);
    const schema = JSON.parse(readFileSync(url, 'utf8'));
    const settingsSchema = schema.oneOf[1].properties.settings;
    const root = JSON.parse(readFileSync(new URL('../../../todo_data.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(settingsSchema.properties).sort(), Object.keys(root.properties.reminder_settings.properties).sort());
    const ruleSchema = settingsSchema.properties.global_rules.items;
    assert.deepEqual(Object.keys(ruleSchema.properties).sort(), Object.keys(root.properties.reminder_settings.properties.global_rules.items.properties).sort());
    assert.equal(ruleSchema.properties.id.format, undefined);
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.$ref) {
            const [path, pointer] = value.$ref.split('#');
            let resolved = JSON.parse(readFileSync(new URL(path, url), 'utf8'));
            for (const key of pointer ? pointer.slice(1).split('/') : []) resolved = resolved[key.replaceAll('~1', '/').replaceAll('~0', '~')];
            assert.notEqual(resolved, undefined, value.$ref);
        }
        Object.values(value).forEach(visit);
    };
    visit(schema);
    const operation = reminderSettingsOperation({ updated_at: time, extra: { retained: true }, global_rules: [rule({ future: ['原顺序'] })] });
    for (const key of settingsSchema.required) assert.ok(Object.hasOwn(operation.settings, key));
    for (const key of ruleSchema.required) assert.ok(Object.hasOwn(operation.settings.global_rules[0], key));
    same(operation.settings.extra, { retained: true });
    same(operation.settings.global_rules[0].future, ['原顺序']);
});

test('新提醒操作必须完整归一和有效独立时钟，不生成时间或接受整文件替换', () => {
    for (const clock of [undefined, null, '', 'bad', '2026-11-07', '2026-11-07T02:00:00', '2026-02-30T02:00:00Z']) {
        assert.throws(() => reminderSettingsOperation({ updated_at: clock }), /INVALID_TODO_TIMESTAMP/);
    }
    for (const raw of [{ type: 'data.replace', data: baseline() }, { type: 'reminder.settings.put', settings: { updated_at: time } },
        { ...reminderSettingsOperation(settings()), data: baseline() }]) assert.throws(() => profile.validateOperation(raw), /UNSUPPORTED_OPERATION|NON_NORMALIZED/);
    for (const fields of [{ condition: 'future' }, { task_scope: 'future' }]) {
        assert.throws(() => reminderSettingsOperation(settings({ global_rules: [rule(fields)] })), /UNSUPPORTED_REMINDER_RULE_ENUM/);
    }
    const value = settings({ updated_at: '2026-11-07T10:00:00.0009+08:00' });
    assert.equal(reminderSettingsOperation(value).settings.updated_at, value.updated_at);
});

test('旧基线中的未知枚举与未知字段仍可恢复，新操作不擅自解释新枚举', async () => {
    const original = settings({ updated_at: null, global_rules: [rule({ id: '旧规则', condition: 'future', task_scope: 'future', extra: '原值' })] });
    const data = dataset(baseline(original)), client = await open(data);
    same(client.state().view.reminder_settings, original);
    const bundle = createRecovery({ dataset: data, state: client.state(), profile });
    same(restoreRecovery({ dataset: data, bundle, profile }).view.reminder_settings, original);
    assert.throws(() => reminderSettingsOperation({ ...original, updated_at: later }), /UNSUPPORTED_REMINDER_RULE_ENUM/);
});

test('新profile与旧normal数据集显式互拒，旧profile不增加提醒操作', async () => {
    const data = dataset(), old = createDataset({ datasetId: id(1), createdAt: time, data: baseline(), profile: NORMAL_TODO_PROFILE });
    assert.equal(data.descriptor.value.operation_set, 'lab-personal-core/1');
    assert.equal(old.descriptor.value.operation_set, 'lab-normal-todo/1');
    assert.throws(() => validateJoin(data.pin, data.descriptor.bytes, data.baseline.bytes, NORMAL_TODO_PROFILE), /INVALID_DATASET_BINDING/);
    assert.throws(() => validateJoin(old.pin, old.descriptor.bytes, old.baseline.bytes, profile), /INVALID_DATASET_BINDING/);
    assert.throws(() => NORMAL_TODO_PROFILE.validateOperation(reminderSettingsOperation(settings())), /UNSUPPORTED_OPERATION/);
    await assert.rejects(openRecordLab({ dataset: old, store: new MemoryStore(), transport: memoryTransport(), profile }), /INVALID_DATASET_BINDING/);
    await assert.rejects(openRecordLab({ dataset: data, store: new MemoryStore(), transport: memoryTransport(), profile: NORMAL_TODO_PROFILE }), /INVALID_DATASET_BINDING/);
});

test('正常任务记录推进文件时钟不伪造提醒时钟，首次明确编辑可以清除旧非空规则', async () => {
    for (const clock of [null, '', 'bad']) {
        const original = settings({ updated_at: clock, global_rules: [rule({ id: '旧规则' })] });
        const data = dataset(baseline(original)), client = await open(data);
        await client.commit(intent(10, [normal(todo())], '2099-01-01T00:00:00Z'));
        same(client.state().view.reminder_settings, original);
        const cleared = settings({ updated_at: '2020-01-01T00:00:00Z', global_rules: [] });
        await client.commit(intent(11, [reminderSettingsOperation(cleared)]));
        same(client.state().view.reminder_settings, cleared);
        assert.equal(client.state().view.todos.length, 1);
    }
});

test('规则身份例外只来自提醒基线和历史，删除后可恢复原旧ID，新规则必须UUIDv4', async () => {
    const legacy = rule({ id: '旧提醒规则' });
    const original = settings({ updated_at: null, global_rules: [legacy] });
    const data = dataset(baseline(original)), client = await open(data);
    await client.commit(intent(10, [reminderSettingsOperation(settings({ global_rules: [] }))]));
    await client.commit(intent(11, [reminderSettingsOperation(settings({ updated_at: later, global_rules: [legacy] }))]));
    assert.equal(client.state().view.reminder_settings.global_rules[0].id, legacy.id);
    const before = encode(client.state());
    await assert.rejects(client.commit(intent(12, [reminderSettingsOperation(settings({ updated_at: '2026-11-07T02:02:00Z', global_rules: [rule({ id: '新字符串规则' })] }))])), /INVALID_NEW_REMINDER_RULE_ID/);
    assert.deepEqual(encode(client.state()), before);
    await client.commit(intent(13, [reminderSettingsOperation(settings({ updated_at: '2026-11-07T02:03:00Z', global_rules: [rule({ id: id(201) })] }))]));
    assert.equal(client.state().view.reminder_settings.global_rules[0].id, id(201));
});

test('任务及子任务的旧字符串ID不能用来冒充已知提醒身份', async () => {
    const old = todo({ id: '旧任务', subtasks: [{ id: '旧子任务', content: '原值' }] });
    const data = dataset(baseline(undefined, { todos: [old] })), client = await open(data);
    for (const borrowed of [old.id, old.subtasks[0].id]) {
        await assert.rejects(client.commit(intent(10, [normal({ ...old, content: '新内容' }),
            reminderSettingsOperation(settings({ global_rules: [rule({ id: borrowed })] }))])), /INVALID_NEW_REMINDER_RULE_ID/);
        assert.equal(client.state().view.todos[0].content, old.content);
        assert.equal(client.state().artifacts.length, 0);
        assert.equal(client.state().faults.length, 0);
    }
});

test('正常加提醒混合批次业务故障本地原子拒绝，远端及恢复保留整条原字节且不发布半批', async () => {
    const data = dataset(), store = new MemoryStore(), transport = memoryTransport(), client = await open(data, store, transport);
    const operations = [normal(todo()), reminderSettingsOperation(settings({ global_rules: [rule({ id: '未知旧规则' })] }))];
    const before = encode(await store.load());
    await assert.rejects(client.commit(intent(10, operations)), /INVALID_NEW_REMINDER_RULE_ID/);
    assert.deepEqual(encode(await store.load()), before);
    assert.equal(transport.files.size, 0);
    const bad = record(data, 10, operations);
    const remote = await open(data, new MemoryStore(), memoryTransport([bad]));
    await remote.sync();
    assert.equal(remote.state().blocked, true);
    assert.equal(remote.state().view.todos.length, 0);
    assert.equal(remote.state().artifacts[0].base64, bad.bytes.toString('base64'));
    const bundle = createRecovery({ dataset: data, state: remote.state(), profile });
    const restored = restoreRecovery({ dataset: data, bundle, profile });
    assert.equal(restored.blocked, true);
    assert.equal(restored.view.todos.length, 0);
    assert.equal(restored.artifacts[0].base64, bad.bytes.toString('base64'));
});

test('混合批次未知类型或无时区提醒时钟均在应用前整条拒绝并保存原始故障', async () => {
    const data = dataset(), valid = record(data, 10, [normal(todo()), reminderSettingsOperation(settings())]);
    for (const invalid of [{ type: 'future.operation' }, { type: 'reminder.settings.put', settings: settings({ updated_at: '2026-11-07T02:00:00' }) }]) {
        const bad = seal('record', { ...valid.value, operations: [normal(todo()), invalid] });
        const client = await open(data, new MemoryStore(), memoryTransport([bad]));
        await client.sync();
        assert.equal(client.state().blocked, true);
        assert.equal(client.state().view.todos.length, 0);
        assert.ok(client.state().faults.some(fault => fault.base64 === bad.bytes.toString('base64')));
    }
});

test('混合日志丢弃缓存后冷恢复完整，旧恢复包只并集，不覆盖新提醒或任务', async () => {
    const data = dataset(), transport = memoryTransport(), client = await open(data, new MemoryStore(), transport);
    const first = [normal(todo()), reminderSettingsOperation(settings())];
    await client.commit(intent(10, first));
    const old = createRecovery({ dataset: data, state: client.state(), profile });
    const finalSettings = settings({ updated_at: later, enabled: false, global_rules: [rule()] });
    await client.commit(intent(11, [normal(todo({ content: '较新内容', updated_at: later })), reminderSettingsOperation(finalSettings)]));
    await client.sync();
    const expected = client.state().view;
    const forged = client.state(); forged.view = { todos: [], reminder_settings: { enabled: true }, future: '伪造缓存' };
    const restored = restoreRecovery({ dataset: data, currentState: forged, bundle: old, profile });
    same(restored.view, expected);
    assert.equal(restored.artifacts.length, 2);
    assert.equal(restored.outbox.length, 1);
    const reopened = await open(data, new MemoryStore(restored), transport);
    await reopened.sync(); same(reopened.state().view, expected);
    assert.equal(reopened.state().outbox.length, 0);
    const cold = await open(data, new MemoryStore(), transport);
    await cold.sync(); same(cold.state().view, expected);
    for (const key of ['time_entries', 'daily_reviews', 'task_series', 'task_series_links', 'future']) same(expected[key], data.baseline.value.data[key]);
    same(expected.reminder_settings, finalSettings);
});

test('固定混合意图上传响应丢失后复用同一ID、正文与时间，设置和规则扩展原位保留', async () => {
    const extension = JSON.parse('{"__proto__":{"n":1e-7},"2":"原值","10":"原值"}');
    const desired = settings({ extension, global_rules: [rule({ extra: ['第二', '第一'] }), rule({ id: id(201), extra: { keep: true } })] });
    const change = intent(10, [normal(todo()), reminderSettingsOperation(desired)]);
    const data = dataset(), store = new MemoryStore(), transport = memoryTransport();
    let client = await open(data, store, transport);
    const pending = client.commit(change); change.operations[1].settings.enabled = false;
    const fixed = await pending;
    let lost = true; const write = transport.write;
    transport.write = async (name, bytes) => { await write(name, bytes); if (lost) { lost = false; throw new Error('ACK_LOST'); } };
    await client.sync(); assert.equal(client.state().outbox.length, 1);
    client = await open(data, store, transport);
    const original = intent(10, [normal(todo()), reminderSettingsOperation(desired)]);
    same(await client.commit(original), fixed);
    await assert.rejects(client.commit({ ...original, operations: [normal(todo()), reminderSettingsOperation({ ...desired, enabled: false })] }), /RECORD_ID_CONTENT_CONFLICT/);
    await client.sync(); assert.equal(client.state().outbox.length, 0);
    assert.equal(transport.files.size, 1);
    same(client.state().view.reminder_settings, desired);
    assert.deepEqual(await transport.read(fixed.name), Buffer.from(fixed.base64, 'base64'));
});
