import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RecordTransportIntegrityError, startRecordSync, syncRecordJournal } from '../src/recordSync.js';
import { createRecordFolderTransport } from '../src/recordFolder.js';
import { createRecordWebDavTransport } from '../src/recordWebDav.js';
import { makeRecordSandboxBinding, planningCloudTarget } from '../src/recordSandbox.js';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/native-record-journal/series-causal-replay.json', import.meta.url)));
const binding = { pin: fixture.pin, descriptor: fixture.descriptor.content, baseline: 'baseline' };
const sample = fixture.cases[0];
const [child, parent] = sample.journal.records;
const base = JSON.stringify({ data: fixture.baseline });
const raw = item => Buffer.from(item.content, 'base64').toString('utf8');

test('计划云端绑定跨端使用同一组固定文件，账户或数据路径变化采用新身份', async () => {
    const config = { sync_mode: 'webdav', webdav_url: 'https://example.test/dav/', webdav_username: 'example',
        webdav_password: 'fake', webdav_filepath: '合成/todo_data.json' };
    const cloud = planningCloudTarget(config, 'actor');
    const fixed = makeRecordSandboxBinding(cloud.target.datasetId, cloud.target.at, 'planning/1');
    assert.equal(fixed.pin.dataset_id, '8fcc09ae-784e-404d-8399-23d03ab6ed35');
    assert.equal(fixed.pin.baseline_sha256, '05c39b9ba36feaa51ea14ac456644995b3c5bb176c828b74a934771ef8338797');
    assert.equal(fixed.pin.descriptor_sha256, 'b68d2751a82db79b3b387e54daee6fb080ba674dad2b23ef0665b347fbd59641');
    assert.equal(planningCloudTarget({ ...config, webdav_password: 'rotated' }, 'other').target.datasetId, fixed.pin.dataset_id);
    assert.notEqual(planningCloudTarget({ ...config, webdav_filepath: '其它/todo_data.json' }, 'actor').target.datasetId, fixed.pin.dataset_id);
    assert.notEqual(planningCloudTarget({ ...config, webdav_username: 'another' }, 'actor').target.datasetId, fixed.pin.dataset_id);
    let initialized = false;
    const collection = '/dav/%E5%90%88%E6%88%90/' + fixed.pin.namespace + 'records/';
    const transport = createRecordWebDavTransport(async (command, args) => {
        if (command === 'initialize_planning_webdav') {
            assert.equal(initialized, false);
            assert.equal(args.descriptor, fixed.descriptor);
            assert.equal(args.baseline, fixed.baseline);
            initialized = true;
            return;
        }
        assert.equal(command, 'request_record_webdav');
        assert.ok(initialized);
        if (args.action === 'list') return `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${collection}</d:href></d:response></d:multistatus>`;
        assert.equal(args.action, 'write_planning');
    }, { ...cloud.webDav, pin: fixed.pin }, fixed);
    assert.deepEqual(await transport.list(), []);
    assert.deepEqual(await transport.list(), []);
    await transport.write('test', 'bytes');
});

test('已同步对象字节变化时先落盘证据，重开后不请求传输', async () => {
    let journal = { ...sample.journal, records: [parent, child], pending: [child.name] };
    let prepared, reads = 0, lists = 0;
    const observed = { name: parent.name, content: child.content };
    const invoke = async (command, { request }) => {
        if (command === 'commit_record_recovery') { journal = prepared; return; }
        assert.equal(command, 'prepare_record_recovery_commit');
        if (request.observation) {
            assert.deepEqual(request.observation, { artifact: observed, confirm: false });
            prepared = { ...journal, fault: { code: 'RECORD_REMOTE_BYTES_CHANGED', observed } };
        } else prepared = journal;
        return { receipt: {}, preview: { journal: prepared, dependencies: { missing: [] },
            baseline: base, operation_set: 'lab-collaboration/2', records: prepared.fault ? null : [raw(parent), raw(child)] } };
    };
    const transport = {
        namespace: binding.pin.namespace,
        async list() { lists++; return []; },
        async read(name) { reads++; assert.equal(name, parent.name); return observed.content; },
        async write() { assert.fail('异常后不得上传'); }
    };
    for (let i = 0; i < 2; i++) await assert.rejects(syncRecordJournal(invoke, binding, transport), /RECORD_REMOTE_BYTES_CHANGED/);
    assert.equal(lists, 1);
    assert.equal(reads, 1);
    assert.deepEqual(journal.records, [parent, child]);
    assert.deepEqual(journal.pending, [child.name]);
    assert.deepEqual(journal.fault.observed, observed);
});

test('后台停止会等待已开始的一轮同步', async () => {
    let release, runs = 0;
    const completion = new Promise(resolve => { release = resolve; });
    const stop = startRecordSync({
        intervalMs: 1000,
        sync: async () => { runs++; return completion; },
        onResult: value => assert.equal(value, 'done'),
        onError: assert.fail
    });
    let stopped = false;
    const waiting = stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release('done');
    await waiting;
    assert.equal(runs, 1);
});

test('后台遇到数据完整性错误后停止重试', async () => {
    let runs = 0, rejectObserved;
    const observed = new Promise(resolve => { rejectObserved = resolve; });
    const stop = startRecordSync({
        intervalMs: 1,
        sync: async () => { runs++; throw new RecordTransportIntegrityError('blocked'); },
        onResult: assert.fail,
        onError: rejectObserved
    });
    assert.match((await observed).message, /blocked/);
    await new Promise(resolve => setTimeout(resolve, 15));
    await stop();
    assert.equal(runs, 1);
});

test('WebDAV 使用固定目录并拒绝列表中的跨目标对象', async () => {
    const collection = `/dav/%E5%90%88%E6%88%90/${binding.pin.namespace}records/`;
    const config = { endpoint: 'https://example.test/dav/', directory: ['合成'], username: 'fake', password: 'fake', pin: binding.pin };
    let href = collection + parent.name.split('/').at(-1);
    const dav = createRecordWebDavTransport(async (command, args) => {
        assert.equal(command, 'request_record_webdav');
        assert.deepEqual(args.binding, config);
        if (args.action === 'list') return `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${collection}</d:href></d:response><d:response><d:href>${href}</d:href></d:response></d:multistatus>`;
        assert.equal(args.name, parent.name);
        assert.equal(args.content, parent.content);
        return null;
    }, config);
    assert.deepEqual(await dav.list(), [parent.name]);
    await dav.write(parent.name, parent.content);
    href = 'https://other.test/' + parent.name;
    await assert.rejects(dav.list(), /INVALID_DIRECTORY_PATH/);
});

test('同步重试磁盘上的未读记录，并在上传响应丢失后通过读回出队', async () => {
    let journal = { ...sample.journal, records: [parent], pending: [parent.name], unread: [] };
    let candidate;
    const invoke = async (command, { request }) => {
        if (command === 'commit_record_recovery') {
            journal = candidate;
            return;
        }
        assert.equal(command, 'prepare_record_recovery_commit');
        candidate = structuredClone(journal);
        if (request.discovered) candidate.unread = [...new Set([...candidate.unread, ...request.discovered])];
        if (request.observation && !request.observation.confirm) {
            assert.deepEqual(request.observation.artifact, child);
            candidate.records.push(child);
            candidate.unread = [];
        }
        if (request.observation?.confirm) {
            assert.deepEqual(request.observation.artifact, parent);
            candidate.pending = [];
        }
        return { receipt: {}, preview: {
            journal: candidate, operation_set: 'lab-collaboration/2', baseline: base,
            dependencies: { missing: [] }, records: candidate.records.map(raw)
        } };
    };
    let listed = [child.name, child.name];
    const remote = new Map();
    let writes = 0;
    const transport = {
        namespace: binding.pin.namespace,
        async list() { return listed; },
        async read(name) { return remote.get(name) ?? null; },
        async write(name, content) {
            writes++;
            remote.set(name, content);
            throw new Error('响应丢失');
        }
    };
    const first = await syncRecordJournal(invoke, binding, transport);
    assert.deepEqual(first.readFailures, [child.name]);
    assert.deepEqual(first.uploadFailures, [parent.name]);
    assert.deepEqual(journal.unread, [child.name]);
    assert.deepEqual(journal.pending, [parent.name]);
    listed = [];
    remote.set(child.name, child.content);
    const retried = await syncRecordJournal(invoke, binding, transport);
    assert.equal(writes, 1);
    assert.deepEqual(retried.journal.unread, []);
    assert.deepEqual(retried.journal.pending, []);
    assert.deepEqual(retried.view, sample.expected);
});

test('收到完整记录前补读精确父对象，传输绑定错误时不发请求', async () => {
    const requests = [];
    let records = [];
    const invoke = async (command, { request }) => {
        if (command === 'commit_record_recovery') return;
        if (request.observation) records = [...records, request.observation.artifact];
        const complete = records.some(item => item.name === parent.name);
        return { receipt: {}, preview: {
            operation_set: 'lab-collaboration/2', baseline: base,
            journal: { ...sample.journal, records, unread: request.discovered ?? [] },
            dependencies: { missing: records.length && !complete ? [parent.name] : [] },
            records: records.length && !complete ? null : complete ? [raw(parent), raw(child)] : []
        } };
    };
    const transport = {
        namespace: binding.pin.namespace,
        async list() { return [child.name]; },
        async read(name) {
            requests.push(name);
            return name === child.name ? child.content : parent.content;
        },
        async write() { assert.fail('没有待上传项'); }
    };
    await assert.rejects(syncRecordJournal(invoke, binding, { ...transport, namespace: 'other/' }), /RECORD_TRANSPORT_TARGET_MISMATCH/);
    assert.deepEqual(requests, []);
    const synced = await syncRecordJournal(invoke, binding, transport);
    assert.deepEqual(requests, [child.name, parent.name]);
    assert.deepEqual(synced.view, sample.expected);
});

test('文件夹入口固定目标并读取经过原生校验的冲突副本', async () => {
    const pin = structuredClone(binding.pin);
    const commands = [];
    const folder = createRecordFolderTransport(async (command, args) => {
        commands.push(command);
        assert.deepEqual(args.binding, { root: 'D:/isolated', pin: binding.pin });
        if (command === 'list_record_folder') return { names: [parent.name], aliases: [parent] };
        assert.equal(args.name, parent.name);
        return null;
    }, 'D:/isolated', pin);
    pin.namespace = 'other/';
    assert.deepEqual(await folder.list(), [parent.name]);
    assert.equal(await folder.read(parent.name), parent.content);
    assert.deepEqual(commands, ['list_record_folder', 'read_record_folder']);
});

test('文件夹身份或内容异常阻止本轮上传', async () => {
    const folder = createRecordFolderTransport(async command => {
        assert.equal(command, 'list_record_folder');
        throw 'RECORD_FOLDER_TARGET_MISMATCH';
    }, 'D:/isolated', binding.pin);
    const invoke = async command => {
        assert.equal(command, 'prepare_record_recovery_commit');
        return { receipt: {}, preview: {
            operation_set: 'lab-collaboration/2', baseline: base,
            journal: { ...sample.journal, records: [parent], pending: [parent.name] },
            dependencies: { missing: [] }, records: [raw(parent)]
        } };
    };
    await assert.rejects(syncRecordJournal(invoke, binding, folder), /RECORD_FOLDER_TARGET_MISMATCH/);
});
