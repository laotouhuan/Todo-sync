import { it } from 'node:test';
import assert from 'node:assert/strict';
import { editorProgressSections } from '../src/editorSections.js';

it('三段分区覆盖全部八种组合、来源隔离和计时开关，不修改草稿', () => {
    const ref = { todo_id: 'todo', source_type: 'personal', source_id: null };
    for (let mask = 0; mask < 8; mask++) {
        const todo = { task_type: 'weekly_checkin', subtasks: mask & 1 ? [{ completed: true }] : [], completed_dates: mask & 4 ? ['2026-10-15'] : [] };
        const entries = mask & 2 ? [{ task_ref: ref, ended_at: null }] : [];
        const before = structuredClone(todo), sections = editorProgressSections(todo, entries, ref);
        assert.equal(sections.includes('subtasks'), !!(mask & 1)); assert.equal(sections.includes('timing'), !!(mask & 2)); assert.equal(sections.includes('checkins'), !!(mask & 4));
        assert.equal(editorProgressSections(todo, entries, ref, false).includes('timing'), false);
        assert.equal(editorProgressSections(todo, [{ task_ref: { ...ref, source_type: 'collaboration', source_id: 'shared' } }], ref).includes('timing'), false);
        assert.deepEqual(todo, before);
    }
});
