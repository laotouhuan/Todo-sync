import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, canonicalJsonDigest, sha256Hex } from '../src/stableJsonDigest.js';
import { choosePeriodTodoBase, normalizeNormalTodo, normalizePeriodTodo, todoTimestampMillis } from '../src/normalTodoConflict.js';

describe('普通任务规范字节与同步摘要', () => {
    for (const size of [0, 1, 3, 55, 56, 63, 64, 65, 1000, 10000]) {
        it(`SHA-256 与独立标准实现一致：${size} 字节边界`, () => {
            const bytes = Uint8Array.from({ length: size }, (_, index) => index * 131 + 17 & 255);
            assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
        });
    }
    it('规范 JSON 固定整数形键、Unicode 与 binary64 数字表示', () => {
        const value = JSON.parse('{"2":1e-7,"10":-0,"😀":"字","__proto__":{"n":1e21}}');
        const expected = '{"10":0,"2":1e-7,"__proto__":{"n":1e+21},"😀":"字"}';
        assert.equal(canonicalJson(value), expected);
        assert.equal(canonicalJsonDigest(value), createHash('sha256').update(expected).digest('hex'));
    });
    it('非法日期与无时区时间明确报错，不用当前时间兜底', () => {
        for (const value of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00', '坏时间']) {
            assert.throws(() => todoTimestampMillis(value), /INVALID_TODO_TIMESTAMP/);
        }
        assert.equal(todoTimestampMillis('1969-12-31T23:59:59.9999Z'), -1);
    });
    it('保留旧字符串 ID，坏业务类型报错', () => {
        const todo = { id: '旧id', content: '任务', created_at: '2026-11-05T00:00:00Z' };
        assert.equal(normalizeNormalTodo(todo).id, '旧id');
        assert.throws(() => normalizeNormalTodo({ ...todo, subtasks: [null] }), /INVALID_TODO_SUBTASK/);
        assert.throws(() => normalizeNormalTodo({ ...todo, order: Infinity }), /INVALID_NORMAL_TODO/);
    });
    it('周期业务键归一相同、原字段不同，仍用实际候选摘要稳定选择', () => {
        const raw = { id: 'period-zero', content: '任务', task_type: 'weekly_checkin', date: '2026-W45',
            created_at: '2026-11-01T00:00:00Z', updated_at: '', target_count: 0 };
        const a = normalizePeriodTodo(raw), b = normalizePeriodTodo({ ...raw, target_count: null });
        assert.equal(a.target_count, 0);
        assert.equal(a.updated_at, '');
        assert.deepEqual(choosePeriodTodoBase(a, b), choosePeriodTodoBase(b, a));
    });
});
