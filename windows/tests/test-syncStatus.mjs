import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const names = ['SyncState', 'todoSyncState', 'planningSyncState', 'todoSyncError', 'planningSyncError',
    'setSyncStatus', 'setPlanningSyncStatus', 'renderSyncStatus'];
const declarations = parse(source, { sourceType: 'module', ecmaVersion: 'latest' }).body
    .filter(node => names.includes(node.id?.name ?? node.declarations?.[0]?.id.name))
    .map(node => source.slice(node.start, node.end)).join('\n');

function harness() {
    const classes = new Set();
    const status = { title: '', setAttribute() {}, classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
    } };
    const state = { activeSource: { type: 'personal' } };
    const api = runInNewContext(declarations + ';({setSyncStatus,setPlanningSyncStatus,renderSyncStatus})', {
        statusEl: status, appState: state
    });
    return { ...api, status, state, classes };
}

test('待办同步成功不能覆盖计划失败，黄灯保留具体原因', () => {
    const h = harness();
    h.setPlanningSyncStatus('error', '计划云端目录读取失败');
    h.setSyncStatus('syncing');
    h.setSyncStatus('idle');
    assert.ok(h.classes.has('error'));
    assert.equal(h.classes.has('syncing'), false);
    assert.equal(h.status.title, '计划云端目录读取失败');
    h.setPlanningSyncStatus('idle');
    assert.equal(h.classes.has('error'), false);
    assert.equal(h.status.title, '同步正常');
});

test('切换协作清单时隐藏个人计划失败，返回个人时仍可查看', () => {
    const h = harness();
    h.setPlanningSyncStatus('error', '本机计划尚未接入云端');
    h.state.activeSource.type = 'collaboration';
    h.renderSyncStatus();
    assert.equal(h.classes.has('error'), false);
    assert.equal(h.status.title, '同步正常');
    h.state.activeSource.type = 'personal';
    h.renderSyncStatus();
    assert.ok(h.classes.has('error'));
    assert.equal(h.status.title, '本机计划尚未接入云端');
});

test('多类失败分别保留，清除一项后仍显示另一项', () => {
    const h = harness();
    h.setSyncStatus('error', '待办读取失败');
    h.setPlanningSyncStatus('error', '计划上传失败');
    assert.equal(h.status.title, '待办读取失败；计划上传失败');
    h.setPlanningSyncStatus('idle');
    assert.equal(h.status.title, '待办读取失败');
    assert.ok(h.classes.has('error'));
});
