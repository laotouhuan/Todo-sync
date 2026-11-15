import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataCoordinator } from '../src/dataCoordinator.js';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('首次保存失败不丢掉后续新增，调用者收到失败且可以保留草稿重试', async () => {
    let data = { todos: [{ id: 'original', content: '原任务' }] };
    const started = deferred(), release = deferred(); let writes = 0;
    const store = createDataCoordinator({ getData: () => data, install: next => { data = next; },
        persist: async () => { if (++writes === 1) { started.resolve(); await release.promise; throw new Error('磁盘满'); } } });
    store.activate('A', data);
    const first = store.commit(d => { d.todos[0].content = '编辑'; });
    const failure = assert.rejects(first, /磁盘满/);
    await started.promise;
    const second = store.commit(d => { d.todos.push({ id: 'new', content: '等待保存时新增' }); });
    release.resolve(); await failure; await second;
    assert.deepEqual(data.todos.map(t => t.content), ['原任务', '等待保存时新增']);
    assert.equal(store.revision, 2);
});
