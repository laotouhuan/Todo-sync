import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTimelineSubtask, selectTimelineRecord } from '../src/timelineEditor.js';

// 运行真实弹窗事件，验证选择隔离、取消及保存失败时的行为。
function setup() {
    const createElement = tag => ({ tag, children: [], value: '', validity: {}, listeners: {},
        append(...nodes) { this.children.push(...nodes); },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        showModal() {}, remove() {}, close() { this.closed = true; this.listeners.close?.(); }
    });
    globalThis.document = { createElement, body: createElement('body') };
    return () => document.body.children.at(-1);
}
test('单条及同一次跨日计时直接编辑，重叠时仅打开所选记录', () => {
    const dialog = setup(), opened = [];
    const a = { id: 'a', task_content_snapshot: '任务 A', started_at: '2026-09-16T12:00:00Z' };
    const b = { ...a, id: 'b' };
    selectTimelineRecord([a, a], e => opened.push(e));
    assert.deepEqual(opened, [a]); assert.equal(dialog(), undefined);
    selectTimelineRecord([a, b], e => opened.push(e));
    dialog().children.filter(n => n.tag === 'button')[1].onclick();
    assert.deepEqual(opened, [a, b]); assert.equal(dialog().closed, true);
});
test('子步骤保存只提交内容和时间，未改时间保留原始精度，取消不保存', async () => {
    const dialog = setup(), patches = [];
    const task = { content: '所属任务' }, step = { content: '原内容', completed_at: '2026-09-16T12:00:00.123Z' };
    editTimelineSubtask(task, step, async patch => patches.push(patch));
    const fields = dialog().children.filter(n => n.tag === 'label').map(n => n.children[0]);
    fields[0].value = '修改内容';
    await dialog().children.find(n => n.textContent === '保存').onclick();
    assert.deepEqual(patches, [{ content: '修改内容', completed_at: step.completed_at }]);
    assert.equal(step.content, '原内容');
    editTimelineSubtask(task, step, async patch => patches.push(patch));
    dialog().children.find(n => n.textContent === '取消').onclick();
    assert.equal(patches.length, 1);
});
test('空内容和保存失败保持详情打开，无时间的旧记录不伪造时间', async () => {
    const dialog = setup(); let saved;
    editTimelineSubtask({ content: '任务' }, { content: '子步骤', completed_at: null }, async patch => { saved = patch; throw new Error('保存失败'); });
    const content = dialog().children.find(n => n.tag === 'label').children[0];
    const save = dialog().children.find(n => n.textContent === '保存');
    content.value = '  '; await save.onclick(); assert.equal(saved, undefined);
    content.value = '更新'; await save.onclick();
    assert.deepEqual(saved, { content: '更新', completed_at: null });
    assert.equal(dialog().closed, undefined); assert.equal(save.disabled, false);
    assert.equal(dialog().children.find(n => n.className === 'learning-error').textContent, '保存失败');
});
