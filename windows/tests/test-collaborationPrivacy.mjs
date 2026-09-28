import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { mergeCollaborations } from '../src/dataMerge.js';

const local = {
    id: 'a', name: '本机清单', webdav_url: 'https://example.invalid/dav/',
    webdav_username: 'dummy-user', webdav_filepath: 'todo.json', webdav_password: 'dummy-local-password',
    updated_at: '2026-09-27T00:00:00Z', deleted: false
};
function merge(cloud, localItems = [local]) {
    return mergeCollaborations({ collaborations: localItems }, { collaborations: [cloud] }).data.collaborations[0];
}

describe('协作密码不参与云端合并', () => {
    it('新设备不接受云端遗留凭据', () => {
        assert.equal(merge(local, []).webdav_password, '');
    });
    it('同目标的新元数据保留本机密码，拒绝云端提供的密码', () => {
        const result = merge({ ...local, name: '新名称', webdav_password: 'cloud-secret', updated_at: '2026-09-28T00:00:00Z' });
        assert.equal(result.name, '新名称');
        assert.equal(result.webdav_password, 'dummy-local-password');
        assert.equal(local.name, '本机清单');
    });
    it('云端变更地址、账号或路径后不再携带旧密码', () => {
        for (const field of ['webdav_url', 'webdav_username', 'webdav_filepath']) {
            const result = merge({ ...local, [field]: 'other', updated_at: '2026-09-28T00:00:00Z' });
            assert.equal(result.webdav_password, '', field);
        }
    });
    it('云端删除状态仍传播且不覆盖本机密码', () => {
        const result = merge({ ...local, deleted: true, webdav_password: '', updated_at: '2026-09-28T00:00:00Z' });
        assert.equal(result.deleted, true);
        assert.equal(result.webdav_password, local.webdav_password);
    });
});

describe('实际页面的旧凭据清理与失败保护', () => {
    const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    const node = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .find(item => item.type === 'FunctionDeclaration' && item.id.name === 'loadData');
    async function run(failingCommand) {
        const commands = [];
        const statuses = [];
        const messages = [];
        const load = runInNewContext(source.slice(node.start, node.end) + ';loadData', {
            invoke: async command => {
                commands.push(command);
                if (command === failingCommand) throw new Error('模拟失败');
                if (command === 'get_app_config') return { sync_mode: 'webdav' };
                if (command === 'read_todo_data' || command === 'fetch_from_cloud') return '{"todos":[]}';
                if (command === 'read_collaborations_data') return JSON.stringify({ collaborations: [local] });
                if (command === 'fetch_collaborations_from_cloud') return JSON.stringify({ collaborations: [{ ...local, webdav_password: '' }] });
                if (command === 'get_collaborations') return [];
            },
            appState: {}, setSyncStatus: state => statuses.push(state),
            SyncState: { SYNCING: 'syncing', ERROR: 'error' },
            normalizeLearningData: data => data, migrateAndNormalize() {}, render() {},
            mergeTodoData: localData => ({ data: localData, changed: false, cloudChanged: false }),
            mergeCollaborations, showToast: message => messages.push(message),
            updateSourceSelector() {}, statusEl: null, console: { error() {}, log() {} }
        });
        await load();
        return { commands, statuses, messages };
    }
    it('元数据不变时也执行云端脱敏上传', async () => {
        const { commands } = await run();
        assert.ok(commands.includes('sync_collaborations_to_cloud'));
        assert.ok(!commands.includes('write_collaborations_data'));
    });
    it('本机凭据迁移失败时不继续拉取或上传协作配置', async () => {
        const { commands, statuses } = await run('read_collaborations_data');
        assert.ok(!commands.includes('fetch_collaborations_from_cloud'));
        assert.ok(!commands.includes('sync_collaborations_to_cloud'));
        assert.ok(statuses.includes('error'));
    });
    it('清理上传失败时提示用户重试', async () => {
        const { statuses, messages } = await run('sync_collaborations_to_cloud');
        assert.ok(statuses.includes('error'));
        assert.ok(messages.some(message => message.includes('尚未清理')));
    });
});
