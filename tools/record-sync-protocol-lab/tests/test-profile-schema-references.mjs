import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const name of ['normal-record-profile', 'personal-record-profile', 'learning-record-profile', 'checkin-record-profile', 'period-record-profile', 'series-record-profile', 'series-workflow-profile', 'series-workflow-v2-profile', 'collaboration-record-profile']) {
    test(`${name} 实验 Schema 按有效基准 URI 递归解析引用`, () => {
        const visited = new Set();
        const document = url => JSON.parse(readFileSync(url, 'utf8'));
        function visit(value, base) {
            if (!value || typeof value !== 'object') return;
            if (value.$id) base = new URL(value.$id, base);
            if (value.$ref) {
                const target = new URL(value.$ref, base);
                assert.equal(target.protocol, 'file:', target.href);
                if (visited.has(target.href)) return;
                visited.add(target.href);
                const file = new URL(target); file.hash = '';
                const root = document(file);
                const pointer = decodeURIComponent(target.hash.slice(1));
                let found = root, childBase = file;
                for (const part of pointer ? pointer.slice(1).split('/') : []) {
                    if (found.$id) childBase = new URL(found.$id, childBase);
                    found = found[part.replaceAll('~1', '/').replaceAll('~0', '~')];
                    assert.notEqual(found, undefined, target.href);
                }
                visit(found, childBase);
            }
            Object.values(value).forEach(child => visit(child, base));
        }
        const root = new URL(`../${name}.schema.json`, import.meta.url);
        visit(document(root), root);
        assert.ok(visited.size > 0);
        assert.ok([...visited].some(ref => ref.includes('/todo_data.schema.json#')));
    });
}
