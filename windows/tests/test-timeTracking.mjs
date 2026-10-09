import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabel, normalizeLearningData, mergeLearningRecords, canonicalLearning, splitTimeEntry, summarizeLearning, validateTimeEntry, overlappingEntries, learningRange, formatDuration, sameTask, taskReference, finishTimeEntry, SHORT_TIME_ENTRY_MESSAGE, canTimeTodo, recentTimingTasks } from '../src/timeTracking.js';

const entry = (id, start, end, label = '数学') => ({ id, task_ref: {source_type:'personal',source_id:null,todo_id:'task'}, task_content_snapshot:'定理', label_snapshot:label, started_at:start, ended_at:end, created_at:start, updated_at:end || start, deleted:false });
process.env.TZ = 'Asia/Shanghai';

const timingTodo = (id, extra = {}) => ({ id, content: `当前任务 ${id}`, completed: false, deleted: false, task_type: 'normal', ...extra });
function history(todoId, startedAt, extra = {}) {
    const endedAt = new Date(Date.parse(startedAt) + 60000).toISOString();
    return { ...entry(`record-${todoId}-${startedAt}`, startedAt, endedAt), task_ref: taskReference({ id: todoId }), ...extra };
}

test('最近任务先过滤、去重和按实际开始时间排序，再取最多五个', () => {
    const todos = Array.from({ length: 8 }, (_, i) => timingTodo(String(i)));
    const records = todos.map((todo, i) => history(todo.id, `2026-09-10T0${i}:00:00Z`));
    records.push(history('0', '2026-09-10T08:00:00Z'), history('0', '2026-09-10T09:00:00Z'));
    const original = structuredClone({ todos, records });
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['0', '7', '6', '5', '4']);
    todos[0].deleted = true; todos[7].completed = true;
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['6', '5', '4', '3', '2']);
    todos[0].deleted = false; todos[7].completed = false;
    assert.deepEqual({ todos, records }, original);
    assert.equal(recentTimingTasks(todos, records)[0].todo.content, '当前任务 0');
    assert.equal(recentTimingTasks(todos.slice(0, 1), records).length, 1);
    assert.deepEqual(recentTimingTasks(todos, []), []);
    assert.deepEqual(recentTimingTasks([], records), []);
});

test('最近任务排除短计时、无效、删除、协作及不可用记录，运行时不提供候选', () => {
    const todos = [timingTodo('a'), timingTodo('b')];
    const valid = history('a', '2026-09-10T01:00:00Z');
    const excluded = [
        { ...valid, deleted: true },
        { ...valid, started_at: 'bad' },
        { ...valid, ended_at: 'bad' },
        { ...valid, ended_at: valid.started_at },
        { ...valid, ended_at: '2026-09-10T01:00:30Z' },
        { ...valid, started_at: '2026-02-30T01:00:00Z' },
        { ...valid, task_ref: { todo_id: 'a', source_type: 'collaboration', source_id: 'source' } },
        { ...valid, task_ref: { todo_id: 'a', source_type: 'personal', source_id: 'source' } },
        { ...valid, task_ref: taskReference({ id: 'missing' }) }
    ];
    assert.deepEqual(recentTimingTasks(todos, excluded), []);
    const newerShort = history('b', '2026-09-10T02:00:00Z', { ended_at: '2026-09-10T02:00:30Z' });
    assert.deepEqual(recentTimingTasks(todos, [valid, ...excluded, newerShort]).map(x => x.todo.id), ['a']);
    assert.equal(recentTimingTasks(todos, [{ ...valid, ended_at: '2026-09-10T01:00:30.001Z' }]).length, 1);
    assert.deepEqual(recentTimingTasks(todos, [valid, { ...newerShort, ended_at: null }]), []);
});

test('最近任务支持不同时区、同时间按 ID 稳定排序，补录及编辑按开始时间排名', () => {
    const todos = ['a', 'b', 'c'].map(id => timingTodo(id));
    const records = [history('b', '2026-09-10T10:00:00+08:00'), history('a', '2026-09-10T02:00:00Z'),
        history('c', '2026-09-10T03:00:00Z')];
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['c', 'a', 'b']);
    records[0].updated_at = '2026-10-01T00:00:00Z';
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['c', 'a', 'b']);
    records.push(history('b', '2026-09-10T04:00:00Z'));
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['b', 'c', 'a']);
    records[3].deleted = true;
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['c', 'a', 'b']);
    records[0].started_at = '2026-09-10T01:00:00Z';
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['c', 'a', 'b']);
    records[2].started_at = '2026-09-10T00:00:00Z';
    assert.deepEqual(recentTimingTasks(todos, records).map(x => x.todo.id), ['a', 'b', 'c']);
});

test('计时资格仅按本地周期目标排除打卡任务，不依赖或修改旧完成状态', () => {
    const weekly = timingTodo('week', { task_type: 'weekly_checkin', date: '2026-W41', target_count: 2,
        completed: true, completed_dates: ['2026-10-04T16:30:00Z', '2026-10-06Tbad'] });
    const original = structuredClone(weekly);
    assert.equal(canTimeTodo(weekly), true);
    assert.deepEqual(weekly, original);
    weekly.completed_dates.push('2026-10-06'); weekly.completed = false;
    assert.equal(canTimeTodo(weekly), false);
    assert.equal(canTimeTodo({ ...weekly, target_count: null, completed: true }), true);
    const monthly = { ...weekly, task_type: 'monthly_checkin', date: '2026-10', completed_dates:
        ['2026-09-30T16:30:00Z', '2026-09-30', '2026-10-01Tinvalid', '2026-10-99', '2026-10-01T12:99:00Z'] };
    assert.equal(canTimeTodo(monthly), true);
    monthly.completed_dates.push('2026-10-02T10:00:00+08:00');
    assert.equal(canTimeTodo(monthly), false);
    assert.equal(canTimeTodo(timingTodo('normal', { completed: true })), false);
    assert.equal(canTimeTodo(timingTodo('daily', { recurring: 'daily_repeat', completed: true })), false);
    assert.equal(canTimeTodo({ ...weekly, deleted: true }), false);
    const daily = timingTodo('new', { recurring: 'daily_repeat', content: '同名任务' });
    assert.deepEqual(recentTimingTasks([daily], [history('old', '2026-09-10T01:00:00Z')]), []);
});

test('结束计时的 30 秒边界、同步删除标记和统计排除', () => {
    const running = entry('short', '2026-09-18T23:59:45+08:00', null);
    for (const duration of [0, 29999, 30000, 30001, 60000]) {
        const end = new Date(Date.parse(running.started_at) + duration).toISOString();
        const finished = finishTimeEntry(running, end);
        assert.equal(finished.deleted, duration <= 30000);
        assert.equal(finished.ended_at, end);
        assert.equal(finished.updated_at, end);
        assert.equal(finished.created_at, running.created_at);
        assert.equal(running.ended_at, null);
        for (const merged of [mergeLearningRecords([running], [finished]), mergeLearningRecords([finished], [running])]) {
            assert.equal(merged[0].deleted, duration <= 30000);
            const summary = summarizeLearning(merged, '2026-09-18', '2026-09-20');
            assert.equal(summary.duration, duration <= 30000 ? 0 : duration);
            assert.equal(summary.running, 0);
            if (duration <= 30000) assert.equal(summary.count, 0);
        }
    }
});

test('结束操作不改写历史或已删除记录，异常时间不会丢弃记录', () => {
    const old = entry('old', '2026-09-18T00:00:00Z', '2026-09-18T00:00:01Z');
    assert.equal(finishTimeEntry(old, '2026-09-18T00:02:00Z'), old);
    const deleted = { ...old, ended_at: null, deleted: true };
    assert.equal(finishTimeEntry(deleted, '2026-09-18T00:02:00Z'), deleted);
    const running = { ...old, ended_at: null };
    for (const end of ['invalid', '2026-09-17T23:59:59Z']) assert.throws(() => finishTimeEntry(running, end), /计时时间异常/);
    assert.throws(() => finishTimeEntry({ ...running, started_at: 'invalid' }, old.ended_at), /计时时间异常/);
});

test('手动保存计时也检查 30 秒边界，运行中的记录不受阈值限制', () => {
    const start = '2026-09-18T00:00:00Z', now = Date.parse('2026-09-19T00:00:00Z');
    for (const duration of [1000, 30000, 30001]) {
        const e = entry('manual', start, new Date(Date.parse(start) + duration).toISOString());
        assert.equal(validateTimeEntry(e, [], now), duration <= 30000 ? SHORT_TIME_ENTRY_MESSAGE : null);
    }
    assert.equal(validateTimeEntry(entry('running', start, null), [], now), null);
});

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
