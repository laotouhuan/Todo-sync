import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { it } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function element(value = '') {
    const listeners = new Map();
    return { value, listeners, textContent: '', style: {}, disabled: false,
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        addEventListener(event, callback) { listeners.set(event, callback); },
        setAttribute() {}, querySelector() { return null; } };
}

function startup(readyState) {
    const ids = ['setting-sync-mode', 'setting-webdav-url', 'setting-webdav-user', 'setting-webdav-pass',
        'setting-webdav-filepath', 'settings-save-btn', 'generate-share-btn', 'share-expire',
        'share-code-output', 'share-key-output', 'share-output-container', 'todo-list', 'add-form', 'todo-input'];
    const elements = new Map(ids.map(id => [id, element()]));
    const events = new Map(), calls = [], toasts = [];
    const stateConfig = { sync_mode: 'webdav', webdav_url: 'https://example.test/dav/',
        webdav_username: 'fake', webdav_password: 'fake-password', webdav_filepath: 'todo_data.json' };
    ['sync_mode', 'webdav_url', 'webdav_username', 'webdav_password', 'webdav_filepath'].forEach((key, index) => {
        elements.get(ids[index]).value = stateConfig[key];
    });
    const context = {
        document: { readyState, getElementById: id => elements.get(id) ?? null,
            querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
        window: { addEventListener: (event, callback) => events.set(event, callback),
            __TAURI__: { core: { invoke: async command => {
                calls.push(command);
                if (command === 'generate_share_code') return ['verified-code', 'verified-key'];
            } }, event: { listen() {} } } },
        console, setTimeout() {}, clearTimeout() {}, setInterval() {},
        createLearningView: () => ({ install() {}, refresh() {} }),
        createLabelManager: () => ({ mount() {}, refresh() {} }),
        loadData() { calls.push('loadData'); }, render() {}, showToast: message => toasts.push(message)
    };
    // 用边界替身隔离文件加载与绘制，实际模块作用域及初始化入口保持原样。
    const replacedFunctions = new Set(['loadData', 'render', 'showToast']);
    const script = ast.body.filter(node => node.type !== 'ImportDeclaration' &&
        !(node.type === 'FunctionDeclaration' && replacedFunctions.has(node.id.name)))
        .map(node => source.slice(node.start, node.end)).join('\n') +
        '\nappState.appConfig = startupConfig;';
    for (const node of ast.body.filter(node => node.type === 'ImportDeclaration')) {
        for (const specifier of node.specifiers) {
            const name = specifier.local.name;
            if (!(name in context)) context[name] = () => {};
        }
    }
    context.startupConfig = stateConfig;
    runInNewContext(script, context);
    return { elements, events, calls, toasts };
}

for (const readyState of ['loading', 'complete']) {
    it(`实际模块在 DOM ${readyState} 时启动，无作用域异常且协作生成可用`, async () => {
        const { elements, events, calls, toasts } = startup(readyState);
        if (readyState === 'loading') {
            assert.equal(elements.get('add-form').listeners.has('submit'), false);
            events.get('DOMContentLoaded')();
        }
        assert.ok(calls.includes('loadData'));
        assert.equal(elements.get('add-form').listeners.has('submit'), true);
        const generate = elements.get('generate-share-btn').listeners.get('click');
        assert.equal(typeof generate, 'function');
        await generate();
        assert.ok(calls.includes('generate_share_code'));
        assert.equal(elements.get('share-code-output').textContent, 'verified-code');
        assert.equal(elements.get('share-key-output').textContent, 'verified-key');
        assert.match(toasts.at(-1), /已验证并生成/);
        elements.get('setting-webdav-pass').listeners.get('input')();
        assert.equal(elements.get('share-code-output').textContent, '');
        assert.equal(elements.get('share-key-output').textContent, '');
    });
}
