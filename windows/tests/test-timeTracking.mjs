import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabel, normalizeLearningData, mergeLearningRecords, canonicalLearning, splitTimeEntry, summarizeLearning, validateTimeEntry, overlappingEntries, learningRange, formatDuration, sameTask, taskReference } from '../src/timeTracking.js';

const entry = (id, start, end, label = '数学') => ({ id, task_ref: {source_type:'personal',source_id:null,todo_id:'task'}, task_content_snapshot:'定理', label_snapshot:label, started_at:start, ended_at:end, created_at:start, updated_at:end || start, deleted:false });
process.env.TZ = 'Asia/Shanghai';

test('跨午夜每天计次，周次数累加，午夜边界不产生空记录', () => {
    const e = entry('1','2026-09-10T23:40:00+08:00','2026-09-11T00:20:00+08:00');
    assert.deepEqual(splitTimeEntry(e).map(p=>[p.date,p.duration]), [['2026-09-10',1200000],['2026-09-11',1200000]]);
    assert.equal(summarizeLearning([e],'2026-09-07','2026-09-14').count,2);
    assert.equal(summarizeLearning([e],'2026-09-10','2026-09-11').duration,1200000);
    assert.equal(splitTimeEntry({...e,ended_at:'2026-09-11T00:00:00+08:00'}).length,1);
    const midnight = {...e, ended_at:'2026-09-11T00:00:00+08:00'};
    assert.equal(summarizeLearning([midnight,{...midnight,id:'2'}],'2026-09-11','2026-09-12').pending,0);
});
test('本地切日支持夏令时、闰日、月末及零时长', () => {
    process.env.TZ='America/New_York';
    const e=entry('1','2026-03-08T00:00:00-05:00','2026-03-09T00:00:00-04:00');
    assert.equal(splitTimeEntry(e)[0].duration,23*3600000);
    process.env.TZ='Asia/Shanghai';
    assert.equal(splitTimeEntry(entry('2','2024-02-29T23:00:00+08:00','2024-03-01T01:00:00+08:00')).length,2);
    assert.equal(splitTimeEntry({...e,ended_at:e.started_at}).length,0);
    assert.equal(splitTimeEntry({...e,deleted:true}).length,0);
    assert.equal(splitTimeEntry({...e,ended_at:null}).length,0);
});
test('重叠记录排除，连续记录不重叠，运行状态不伪造结束', () => {
    const a=entry('a','2026-09-10T09:00:00+08:00','2026-09-10T10:00:00+08:00');
    const b=entry('b',a.ended_at,'2026-09-10T11:00:00+08:00',null);
    assert.equal(overlappingEntries([a,b]).size,0);
    assert.equal(summarizeLearning([a,b],'2026-09-10','2026-09-11').count,2);
    const active={...b,started_at:a.started_at,ended_at:null};
    assert.equal(summarizeLearning([a,active],'2026-09-10','2026-09-11').count,0);
    assert.equal(summarizeLearning([a,active],'2026-09-10','2026-09-11').pending,2);
    assert.equal(active.ended_at,null);
    assert.match(validateTimeEntry(active,[a],Date.parse('2026-09-11')),/重叠/);
    assert.match(validateTimeEntry({...a,ended_at:a.started_at},[],Date.parse('2026-09-11')),/晚于/);
    assert.match(validateTimeEntry(a,[],Date.parse('2020-01-01')),/未来/);
});
test('标签、时段、时长和任务来源边界',()=>{
    assert.equal(normalizeLabel(' 未分类 '),null); assert.equal(normalizeLabel(' 数学 '),'数学');
    assert.equal(normalizeLabel('e\u0301'),'é');
    assert.deepEqual(learningRange('week',new Date('2026-09-10T12:00:00')), {start:'2026-09-07',end:'2026-09-14'});
    assert.deepEqual(learningRange('month',new Date('2026-12-31T12:00:00')), {start:'2026-12-01',end:'2027-01-01'});
    assert.equal(formatDuration(90061000,true),'25:01:01');
    assert.equal(formatDuration(59000),'59 秒');
    assert.equal(sameTask(taskReference({id:'x'}), taskReference({id:'x'},{type:'collaboration',id:'source'})),false);
});
test('按日期归并异 ID 复盘、同时间墓碑优先、双向及重复合并稳定',()=>{
    const a={id:'a',date:'2026-09-10',fact:'旧内容',updated_at:'2026-09-10T01:00:00Z',deleted:false};
    const b={...a,id:'b',fact:'新内容',updated_at:'2026-09-10T02:00:00Z'};
    const merged=mergeLearningRecords([a],[b],'date');assert.equal(merged.length,1);assert.equal(merged[0].id,'b');
    assert.deepEqual(merged,mergeLearningRecords([b],[a],'date'));
    assert.deepEqual(merged,mergeLearningRecords(merged,[b],'date'));
    assert.equal(mergeLearningRecords([b],[{...b,deleted:true}],'date')[0].deleted,true);
    assert.equal(canonicalLearning({b:null,a:'😀'}),'os1:as2:😀s1:bne');
    assert.deepEqual(normalizeLearningData({todos:[]}),{todos:[],time_entries:[],daily_reviews:[]});
});
