import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { it } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const statements = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
function findNode(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of Object.values(node)) {
        const found = findNode(child, predicate);
        if (found) return found;
    }
    return null;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function loadHarness() {
    const node = statements.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'loadCollabData');
    const pending = [];
    const state = { activeSource: { type: 'collaboration', id: 'same' } };
    const load = runInNewContext('let collabLoadRequest = 0;\n' + source.slice(node.start, node.end) + ';loadCollabData', {
        appState: state, render() {}, migrateAndNormalize() {}, console: { error() {} },
        invoke() { const request = deferred(); pending.push(request); return request.promise; }
    });
    return { state, pending, load };
}

it('同 ID 重新导入后的新请求结果不被旧 401 或成功响应覆盖', async () => {
    for (const oldFailure of [true, false]) {
        const { state, pending, load } = loadHarness();
        const old = load('same'), current = load('same');
        pending[1].resolve({ data: '{"todos":[],"marker":"new"}' });
        await current;
        if (oldFailure) pending[0].reject('401');
        else pending[0].resolve({ data: '{"todos":[],"marker":"old"}' });
        await old;
        assert.equal(state.collabData.marker, 'new');
        assert.equal(state.collabError, null);
        assert.equal(state.collabLoading, false);
    }
});

it('切回个人清单后旧请求不写入协作数据', async () => {
    const { state, pending, load } = loadHarness();
    const old = load('same');
    state.activeSource = { type: 'personal' };
    pending[0].resolve({ data: '{"todos":[],"marker":"old"}' });
    await old;
    assert.equal(state.collabData, null);
});

function shareHarness(buttonName, invoke) {
    const ifNode = findNode(statements, node => node.type === 'IfStatement' && node.test.name === buttonName);
    const callback = ifNode.consequent.body[0].expression.arguments[1];
    const fields = Object.fromEntries(['generateShareBtn', 'importShareBtn', 'importCodeInput', 'importKeyInput',
        'importNameInput', 'shareExpireSelect', 'shareCodeOutput', 'shareKeyOutput', 'shareOutputContainer'].map(name =>
        [name, { value: 'fake', textContent: '', disabled: false, style: {} }]));
    fields.shareExpireSelect.value = '';
    const toasts = [], refreshed = [];
    const state = { activeSource: { type: 'collaboration', id: 'same' }, appConfig: { sync_mode: 'local' } };
    const context = {
        ...fields, appState: state, invoke, showToast: message => toasts.push(message),
        hasUnsavedConnection: () => false,
        clearShareOutput() { fields.shareCodeOutput.textContent = ''; fields.shareKeyOutput.textContent = ''; },
        loadCollabData: async id => refreshed.push(id), renderCollabListInSettings() {}, updateSourceSelector() {}
    };
    const api = runInNewContext(`let shareRevision = 0; ({ click: ${source.slice(callback.start, callback.end)}, invalidate() { shareRevision++; } })`, context);
    return { fields, toasts, refreshed, state, context, api };
}

it('生成期间禁用重复点击，配置改动后丢弃旧分享码', async () => {
    const response = deferred();
    let requests = 0;
    const { fields, api } = shareHarness('generateShareBtn', () => { requests++; return response.promise; });
    const first = api.click();
    assert.equal(fields.generateShareBtn.disabled, true);
    await api.click();
    api.invalidate();
    response.resolve(['old-code', 'old-key']);
    await first;
    assert.equal(requests, 1);
    assert.equal(fields.shareCodeOutput.textContent, '');
    assert.equal(fields.shareKeyOutput.textContent, '');
    assert.equal(fields.generateShareBtn.disabled, false);
});

it('未保存配置时生成不调用后端', async () => {
    let requests = 0;
    const { context, api, toasts } = shareHarness('generateShareBtn', () => { requests++; });
    context.hasUnsavedConnection = () => true;
    await api.click();
    assert.equal(requests, 0);
    assert.match(toasts[0], /先保存/);
});

it('导入验证失败保留输入，成功重新导入立即刷新同源页面', async () => {
    for (const fails of [true, false]) {
        const { fields, api, refreshed, toasts } = shareHarness('importShareBtn', async command => {
            if (command === 'import_share_code') {
                if (fails) throw '认证失败（401）';
                return { id: 'same' };
            }
            if (command === 'read_collaborations_data') return '{"collaborations":[]}';
            return [];
        });
        await api.click();
        assert.equal(fields.importCodeInput.value, fails ? 'fake' : '');
        assert.equal(fields.importKeyInput.value, fails ? 'fake' : '');
        assert.equal(fields.importShareBtn.disabled, false);
        assert.deepEqual(refreshed, fails ? [] : ['same']);
        assert.match(toasts[0], fails ? /401/ : /已验证并导入/);
    }
});
