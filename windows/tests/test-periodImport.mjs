import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createTodo, sortFunc } from '../src/dateUtils.js';
import { importCandidates, importPeriods, currentPeriod } from '../src/taskSeries.js';
const now = '2026-10-15T12:00:00+08:00';
for (const type of ['week', 'month']) for (const selected of [[0, 1, 2], [0, 2]]) {
    it(`从往期导入 ${type} 的 ${selected.length} 项保持源排序与本期独立状态`, () => {
        const period = type === 'week' ? '2026-W40' : '2026-08';
        const todos = [{content:'第二项',order:20,completed:false},{content:'第三项',order:5,completed:true},{content:'第一项',order:10,completed:false}]
            .map(t => ({...createTodo(t.content,period),...t,task_type:type==='week'?'weekly_checkin':'monthly_checkin',time:'17:30',label:'数学',target_count:3,subtasks:[{id:crypto.randomUUID(),content:'章节',completed:true,completed_at:now}]}));
        const original = {todos,time_entries:[],daily_reviews:[{id:'review',fact:'保留'}]}, before=structuredClone(original);
        const refs=importCandidates(original,type,new Date(now)).filter((_,i)=>selected.includes(i)).map(c=>c.todo);
        assert.equal(refs.length,selected.length);
        const target=currentPeriod(type,new Date(now)), result=importPeriods(original,refs,target,now);
        const imported=result.todos.filter(t=>t.date===target).sort(sortFunc);
        assert.deepEqual(imported.map(t=>t.content),refs.map(t=>t.content));
        assert.ok(imported.every(t=>!t.completed && !t.completed_dates.length && t.time==='17:30' && t.label==='数学'));
        assert.ok(imported.every(t=>!t.subtasks[0].completed && t.subtasks[0].completed_at===null && !todos.some(s=>s.subtasks[0].id===t.subtasks[0].id)));
        assert.deepEqual(original,before); assert.deepEqual(result.daily_reviews,original.daily_reviews);
    });
}
