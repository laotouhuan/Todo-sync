import test from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../codec.mjs';
import { normalizeNormalTodo,mergeNormalTodos,todoTimestampMillis } from '../normal-todo.mjs';
import { normalTodo,normalTodoVectors,invalidNormalTodoVectors } from '../normal-todo-vectors.mjs';

for(const vector of normalTodoVectors())test(vector.id+'：'+vector.note,()=>{
    const before=encode(vector.records);
    for(const records of [vector.records,[...vector.records].reverse(),[...vector.records,...vector.records]])assert.deepEqual(encode(mergeNormalTodos(records)),encode(vector.winners));
    assert.deepEqual(encode(vector.records),before);
    for(const winner of vector.winners)assert.deepEqual(encode(normalizeNormalTodo(winner)),encode(winner));
});
for(const vector of invalidNormalTodoVectors())test(vector.id+'：非法结构明确拒绝',()=>assert.throws(()=>mergeNormalTodos(vector.records)));
test('统一实际时间点与毫秒精度，日历字符串保持原值',()=>{
    assert.equal(todoTimestampMillis('2026-11-05T08:00:00+08:00'),todoTimestampMillis('2026-11-05T00:00:00Z'));
    assert.equal(todoTimestampMillis('2026-11-05T00:00:00.0009Z'),todoTimestampMillis('2026-11-05T00:00:00.0001Z'));
    const value=normalizeNormalTodo(normalTodo({date:'2026-11-05',time:'08:00'}));
    assert.equal(value.date,'2026-11-05');assert.equal(value.time,'08:00');
});
test('整条选择满足方向交换、幂等和分批结合，不生成更新时间',()=>{
    const a=normalTodo({content:'甲',updated_at:'2026-11-05T00:01:00Z'}),b=normalTodo({content:'乙乙',updated_at:'2026-11-05T00:01:00+00:00'}),c=normalTodo({content:'较新',updated_at:'2026-11-05T00:02:00Z'});
    assert.deepEqual(encode(mergeNormalTodos([a,b,c])),encode(mergeNormalTodos([c,b,a])));
    assert.deepEqual(encode(mergeNormalTodos([...mergeNormalTodos([a,b]),c])),encode(mergeNormalTodos([a,...mergeNormalTodos([b,c])])));
    assert.deepEqual(encode(mergeNormalTodos([a,a])),encode([normalizeNormalTodo(a)]));
});
