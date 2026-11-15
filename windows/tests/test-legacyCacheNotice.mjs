import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { mergeTodoData } from '../src/dataMerge.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const tree = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
const declarations = ['parsePersonalData', 'showLegacyCache', 'reviewLegacyCache'].map(name => {
    const node = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    return source.slice(node.start, node.end);
}).join('\n');

// 每次创建全新的 DOM 和脚本上下文，只保留本机存储，模拟关闭应用后重启。
function harness(storage = new Map(), target = 'A') {
    const elements = [];
    function element(tagName) {
        const node = { tagName, children: [], textContent: '', listeners: {},
            append(...children) { this.children.push(...children); children.forEach(child => { child.parent = this; }); },
            before(child) { this.parent.children.splice(this.parent.children.indexOf(this), 0, child); child.parent = this.parent; },
            remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
            addEventListener(name, handler) { this.listeners[name] = handler; },
            showModal() { this.open = true; },
            close() { this.open = false; this.listeners.close?.(); },
            click() { if (!this.disabled) return this.onclick?.(); },
            querySelector(tag) { return this.children.find(child => child.tagName === tag); }
        };
        elements.push(node);
        return node;
    }
    const body = element('body'), main = element('main'); body.append(main);
    function attached(node) { return node === body || (node.parent && node.parent.children.includes(node) && attached(node.parent)); }
    const document = { body, createElement: element, createTextNode: textContent => ({ textContent }),
        getElementById: id => elements.find(node => node.id === id && attached(node)) || null,
        querySelector: selector => selector === 'main' ? main : null };
    const state = { target, generation: 1, todoData: { version: 1, todos: [] }, commits: [], notices: [] };
    const context = { document, mergeTodoData, structuredClone, TextEncoder, Uint8Array, crypto: webcrypto,
        appState: { appConfig: { webdav_filepath: `${target}.json` } },
        dataStore: { ticket: () => ({ target: state.target, generation: state.generation }),
            current: ticket => ticket.target === state.target && ticket.generation === state.generation },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } },
        showToast: message => state.notices.push(message),
        commitPersonal: async (change, { ticket }) => {
            if (ticket.target !== state.target || ticket.generation !== state.generation) throw new Error('清单已切换');
            if (state.failure) throw state.failure;
            state.todoData = change(structuredClone(state.todoData)); state.commits.push(state.todoData);
        }
    };
    const api = runInNewContext(declarations + ';({ showLegacyCache, reviewLegacyCache })', context);
    return { api, state, storage, context, document,
        get banner() { return document.getElementById('legacy-cache-notice'); },
        get dialog() { return elements.find(node => node.tagName === 'dialog' && node.open); },
        button(pattern, parent = body) {
            function find(node) {
                if (node.tagName === 'button' && pattern.test(node.textContent)) return node;
                return node.children?.map(find).find(Boolean);
            }
            return find(parent);
        }
    };
}

const legacy = JSON.stringify({ version: 1, last_updated: '2026-10-01T00:00:00Z', todos: [{
    id: 'old-task', content: '旧缓存中的任务', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z'
}] });

test('保留旧缓存后，刷新和重新打开都不再重复提醒，且不导入数据', async () => {
    const first = harness();
    await first.api.showLegacyCache(legacy);
    await first.button(/查看与导入/).click();
    await first.button(/暂不导入|不再提醒/, first.dialog).click();
    assert.equal(first.banner, null, '选择保留后应立即关闭横幅');
    await first.api.showLegacyCache(legacy);
    assert.equal(first.banner, null, '自动刷新不能再次提示');
    const reopened = harness(first.storage);
    await reopened.api.showLegacyCache(legacy);
    assert.equal(reopened.banner, null, '重新打开应用后应记住选择');
    assert.equal(first.state.commits.length, 0);
    assert.deepEqual(first.state.todoData, { version: 1, todos: [] });
    assert.ok([...first.storage.values()].every(value => !value.includes('旧缓存中的任务')), '偏好中不保存任务正文');
});

test('成功合并后记住处理状态，重启不再重复提示', async () => {
    const first = harness();
    await first.api.showLegacyCache(legacy);
    await first.button(/查看与导入/).click();
    await first.button(/确认合并/, first.dialog).click();
    assert.equal(first.state.todoData.todos[0].id, 'old-task');
    const reopened = harness(first.storage);
    await reopened.api.showLegacyCache(legacy);
    assert.equal(reopened.banner, null);
});

test('横幅上可直接选择不再提醒，保留旧文件并记住选择', async () => {
    const first = harness();
    await first.api.showLegacyCache(legacy);
    await first.button(/不再提醒/, first.banner).click();
    assert.equal(first.banner, null);
    assert.equal(first.dialog, undefined);
    const reopened = harness(first.storage);
    await reopened.api.showLegacyCache(legacy);
    assert.equal(reopened.banner, null);
    assert.equal(first.state.commits.length, 0);
});

test('忽略决定按同步目标隔离，旧缓存变化后重新提示', async () => {
    const first = harness();
    await first.api.showLegacyCache(legacy);
    await first.button(/不再提醒/, first.banner).click();
    const otherTarget = harness(first.storage, 'B');
    await otherTarget.api.showLegacyCache(legacy);
    assert.ok(otherTarget.banner, 'A 的选择不应用到 B');
    const changed = JSON.parse(legacy); changed.todos[0].content = '旧缓存新增内容';
    const reopened = harness(first.storage);
    await reopened.api.showLegacyCache(JSON.stringify(changed));
    assert.ok(reopened.banner, '旧缓存内容变化后需要重新核对');
});

test('合并失败保留错误和旧缓存提示，不记录为已处理', async () => {
    const first = harness(); first.state.failure = new Error('模拟写入失败');
    await first.api.showLegacyCache(legacy);
    await first.button(/查看与导入/).click();
    await first.button(/确认合并/, first.dialog).click();
    assert.ok(first.banner);
    assert.ok(first.dialog.children.some(node => node.textContent === '模拟写入失败'));
    assert.equal(first.storage.size, 0);
    assert.equal(first.state.commits.length, 0);
    const reopened = harness(first.storage);
    await reopened.api.showLegacyCache(legacy);
    assert.ok(reopened.banner);
});

test('仅关闭预览不会视为忽略，设置入口可重新查看已忽略的旧缓存', async () => {
    const first = harness();
    await first.api.showLegacyCache(legacy);
    await first.button(/查看与导入/).click(); first.dialog.close();
    assert.ok(first.banner);
    assert.equal(first.storage.size, 0);
    await first.button(/不再提醒/, first.banner).click();
    const reopened = harness(first.storage);
    reopened.context.invoke = async command => {
        assert.equal(command, 'read_personal_target');
        return { legacy_data: legacy };
    };
    await reopened.api.reviewLegacyCache();
    assert.ok(reopened.dialog);
    assert.equal(reopened.banner, null, '主动查看不应恢复自动提醒');
    reopened.dialog.close();
    await reopened.api.showLegacyCache(legacy);
    assert.equal(reopened.banner, null);
    assert.equal(reopened.state.commits.length, 0);
});

test('读取或计算摘要期间切换清单，不显示旧目标的提示', async () => {
    const first = harness();
    const showing = first.api.showLegacyCache(legacy);
    first.state.target = 'B'; first.state.generation++;
    await showing;
    assert.equal(first.banner, null);
    first.context.invoke = async () => {
        first.state.target = 'C'; first.state.generation++;
        return { legacy_data: legacy };
    };
    await first.api.reviewLegacyCache();
    assert.equal(first.dialog, undefined);
    assert.equal(first.storage.size, 0);
});

test('本机存储不可用时仍能查看，并明确告知选择未保存', async () => {
    const first = harness();
    first.context.localStorage = {
        getItem() { throw new Error('存储不可用'); },
        setItem() { throw new Error('存储不可用'); }
    };
    await first.api.showLegacyCache(legacy);
    await first.button(/不再提醒/, first.banner).click();
    assert.equal(first.banner, null);
    assert.ok(first.state.notices[0].includes('无法保存'));
    assert.equal(first.state.commits.length, 0);
});
