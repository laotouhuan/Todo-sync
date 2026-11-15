import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectRecordRecoveryFile, openRecordJournal, previewRecordRecovery, recheckRecordFault, saveRecordRecovery, submitLocalRecord } from '../src/recordRecovery.js';
import { bindRecordRecoverySettings } from '../src/recordRecoverySettings.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/native-record-journal/series-causal-replay.json', import.meta.url)));
const row = fixture.cases[0];
const [child, parent] = row.journal.records;

test('设置页打开合成材料时报告依赖状态，并只导出本机故障证据', async () => {
    const elements = new Map(['file', 'status', 'export', 'recheck'].map(key => [key, {
        events: {}, addEventListener(type, handler) { this.events[type] = handler; }
    }]));
    const file = elements.get('file'), status = elements.get('status'), exportButton = elements.get('export');
    const input = JSON.stringify({ pin: fixture.pin, descriptor: 'descriptor', baseline: 'baseline', received: [child] });
    let fault = null;
    const calls = [];
    const invoke = async (command, args) => {
        calls.push(command);
        if (command === 'export_record_fault_evidence') {
            assert.deepEqual(args.pin, fixture.pin);
            return true;
        }
        assert.equal(command, 'prepare_record_recovery_commit');
        return { receipt: {}, preview: { journal: { ...row.journal, fault },
            dependencies: { missing: [parent.name] }, records: null } };
    };
    bindRecordRecoverySettings({ getElementById: id => elements.get(id.replace('record-recovery-', '')) }, invoke, () => ({ sync_mode: 'webdav' }));
    async function open() {
        file.files = [{ size: input.length, async text() { return input; } }];
        await file.events.change();
    }
    await open();
    assert.match(status.textContent, /缺少 1 条父记录/);
    assert.equal(exportButton.hidden, true);
    fault = { code: 'RECORD_REMOTE_BYTES_CHANGED', observed: parent };
    await open();
    assert.match(status.textContent, /同步已暂停/);
    assert.equal(exportButton.hidden, false);
    assert.equal(elements.get('recheck').hidden, false);
    await exportButton.events.click();
    assert.match(status.textContent, /已导出本机故障证据/);
    assert.equal(calls.filter(command => command === 'prepare_record_recovery_commit').length, 3);
    assert.equal(calls.at(-1), 'export_record_fault_evidence');
});

test('恢复材料只触发磁盘预览，文件中的当前日志与修复指令不会传入命令', async () => {
    const file = { pin: fixture.pin, descriptor: 'descriptor', baseline: 'baseline', received: [child],
        current: 'external', repair: { restored: parent } };
    const requests = [];
    const state = await inspectRecordRecoveryFile(async (command, { request }) => {
        assert.equal(command, 'prepare_record_recovery_commit');
        requests.push(request);
        return { receipt: {}, preview: { journal: { ...row.journal, records: request.received ?? [] },
            dependencies: { missing: [parent.name] }, records: null } };
    }, JSON.stringify(file));
    const binding = { pin: file.pin, descriptor: file.descriptor, baseline: file.baseline };
    assert.deepEqual(requests, [binding, { ...binding, backup: undefined, received: [child] }]);
    assert.deepEqual(state.missing, [parent.name]);
    assert.equal(state.view, null);
});

test('手动复核只读故障对象，缺失时保留冻结，匹配后提交原日志版本', async () => {
    const binding = { pin: fixture.pin, descriptor: 'descriptor', baseline: 'baseline' };
    const journal = { ...row.journal, pending: [child.name],
        fault: { code: 'RECORD_REMOTE_BYTES_CHANGED', observed: { ...parent, content: child.content } } };
    let content = null;
    let commits = 0;
    const transport = { namespace: fixture.pin.namespace, async read(name) {
        assert.equal(name, parent.name);
        return content;
    } };
    const invoke = async (command, { request }) => {
        if (command === 'commit_record_recovery') { commits++; return; }
        assert.equal(command, 'prepare_record_recovery_commit');
        if (!request.repair) return { receipt: { previous_sha256: 'frozen' }, preview: {
            journal, dependencies: { missing: [] }, records: null
        } };
        assert.deepEqual(request.repair, { observed_sha256: 'frozen', restored: parent });
        return { receipt: {}, preview: {
            journal: { ...journal, fault: undefined, resolved_faults: [journal.fault] },
            dependencies: { missing: [] }, operation_set: 'lab-collaboration/2',
            baseline: JSON.stringify({ data: fixture.baseline }),
            records: [parent, child].map(item => Buffer.from(item.content, 'base64').toString('utf8'))
        } };
    };
    await assert.rejects(recheckRecordFault(invoke, binding, transport), /RECORD_REPAIR_OBJECT_MISSING/);
    assert.equal(commits, 0);
    content = parent.content;
    const result = await recheckRecordFault(invoke, binding, transport);
    assert.equal(commits, 1);
    assert.deepEqual(result.journal.pending, [child.name]);
    assert.deepEqual(result.view, row.expected);
});

test('恢复入口仅在原生层交付完整记录后按验证过的版本重放', async () => {
    const request = { pin: fixture.pin };
    const nativeResult = {
        operation_set: 'lab-collaboration/2',
        baseline: JSON.stringify({ protocol: fixture.pin.protocol, dataset_id: fixture.pin.dataset_id, data: fixture.baseline }),
        journal: row.journal,
        dependencies: { missing: [] },
        records: [parent, child].map(record => Buffer.from(record.content, 'base64').toString('utf8'))
    };
    const result = await previewRecordRecovery(async (command, args) => {
        assert.equal(command, 'preview_record_recovery');
        assert.equal(args.request, request);
        return nativeResult;
    }, request);
    assert.deepEqual(result, { journal: row.journal, missing: [], view: row.expected });
});

test('缺少精确依赖时返回日志及待补对象，不生成候选视图', async () => {
    const journal = { ...row.journal, records: [child] };
    const missing = [parent.name];
    const result = await previewRecordRecovery(async () => ({
        journal, dependencies: { missing }, records: null
    }), { pin: fixture.pin });
    assert.deepEqual(result, { journal, missing, view: null });
});

test('业务重放失败时不提交日志', async () => {
    const commands = [];
    await assert.rejects(saveRecordRecovery(async command => {
        commands.push(command);
        return { receipt: {}, preview: {
            operation_set: 'lab-collaboration/2', baseline: JSON.stringify({ data: fixture.baseline }),
            journal: row.journal, dependencies: { missing: [] },
            records: [JSON.stringify({
                id: child.name, created_at: fixture.baseline.last_updated, operations: [{ type: 'unsupported.op' }]
            })]
        } };
    }, { pin: fixture.pin }), /UNSUPPORTED_RECORD_OPERATION/);
    assert.deepEqual(commands, ['prepare_record_recovery_commit']);
});

test('先落盘才返回恢复结果，提交复用预览使用的固定请求', async () => {
    const input = { pin: fixture.pin, received: [child] };
    const receipt = { previous_sha256: null, candidate_sha256: 'hash' };
    const journal = { ...row.journal, records: [child] };
    const commands = [];
    const result = await saveRecordRecovery(async (command, args) => {
        commands.push(command);
        assert.deepEqual(args.request.received, [child]);
        if (command === 'prepare_record_recovery_commit') {
            input.received.push(parent);
            return { receipt, preview: { journal, dependencies: { missing: [parent.name] }, records: null } };
        }
        assert.equal(args.receipt, receipt);
    }, input);
    assert.deepEqual(commands, ['prepare_record_recovery_commit', 'commit_record_recovery']);
    assert.deepEqual(result, { journal, missing: [parent.name], view: null });
});

test('本地提交使用读取时的版本，并在记录和待上传队列落盘后交付结果', async () => {
    const binding = { pin: fixture.pin, descriptor: 'descriptor', baseline: 'baseline' };
    const previous = { previous_sha256: 'observed', candidate_sha256: 'observed' };
    const receipt = { previous_sha256: 'observed', candidate_sha256: 'saved' };
    const preview = {
        operation_set: 'lab-collaboration/2', baseline: JSON.stringify({ data: fixture.baseline }),
        journal: { ...row.journal, pending: [child.name] }, dependencies: { missing: [] },
        records: [parent, child].map(record => Buffer.from(record.content, 'base64').toString('utf8')), submitted: child
    };
    const opened = await openRecordJournal(async (command, args) => {
        assert.equal(command, 'prepare_record_recovery_commit');
        assert.deepEqual(args.request, binding);
        return { preview, receipt: previous };
    }, binding);
    const intent = { observed_sha256: opened.revision, operations: [{ type: 'series.rename' }] };
    const calls = [];
    const result = await submitLocalRecord(async (command, args) => {
        calls.push(command);
        assert.deepEqual(args.request, { ...binding, intent });
        if (command === 'prepare_record_recovery_commit') return { preview, receipt };
        assert.equal(args.receipt, receipt);
    }, binding, intent);
    assert.deepEqual(calls, ['prepare_record_recovery_commit', 'commit_record_recovery']);
    assert.deepEqual(result, { journal: preview.journal, missing: [], view: row.expected, revision: 'saved', artifact: child });
});
