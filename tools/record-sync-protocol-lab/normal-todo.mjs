import { encode, decode, hash } from './codec.mjs';
import { canonicalLearning, normalizeLabel } from '../../windows/src/timeTracking.js';

// 已批准规则的独立实验实现；尚不接入生产Todo加载／保存或记录操作目录。
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=code=>{throw new Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const string=value=>typeof value==='string';
const nullableString=value=>value===null||string(value);

/** 比较实际时间点，精度固定毫秒；更细小数截去，不比较ISO字符串词序。 */
export function todoTimestampMillis(value) {
    if(!string(value)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail('INVALID_TODO_TIMESTAMP');
    const day=value.slice(0,10),dayTime=Date.parse(day+'T00:00:00Z');
    if(!Number.isFinite(dayTime)||new Date(dayTime).toISOString().slice(0,10)!==day||+value.slice(11,13)>23||+value.slice(14,16)>59||+value.slice(17,19)>59||
        value.at(-1)!=='Z'&&(+value.slice(-5,-3)>23||+value.slice(-2)>59))fail('INVALID_TODO_TIMESTAMP');
    const result=Date.parse(value);
    if(!Number.isFinite(result))fail('INVALID_TODO_TIMESTAMP');
    return result;
}

export function normalizeNormalTodo(raw) {
    const todo=decode(encode(raw));
    if(!object(todo)||!string(todo.id)||!UUID.test(todo.id)||!string(todo.content))fail('INVALID_NORMAL_TODO');
    todoTimestampMillis(todo.created_at);
    if(!Object.hasOwn(todo,'updated_at')||todo.updated_at===null||todo.updated_at==='')todo.updated_at=todo.created_at;
    todoTimestampMillis(todo.updated_at);
    const defaults={date:null,time:null,completed:false,completed_at:null,order:0,deleted:false,recurring:'none',task_type:'normal',completed_dates:[],target_count:null,reminder:null,subtasks:[],label:null};
    for(const [field,value]of Object.entries(defaults))if(!Object.hasOwn(todo,field))todo[field]=structuredClone(value);
    todo.label=normalizeLabel(todo.label);
    todo.target_count=Number.isSafeInteger(todo.target_count)&&todo.target_count>0?todo.target_count:null;
    if(todo.task_type!=='normal')fail('UNSUPPORTED_TODO_TYPE');
    if(!nullableString(todo.date)||!nullableString(todo.time)||typeof todo.completed!=='boolean'||typeof todo.deleted!=='boolean'||
        typeof todo.order!=='number'||!Number.isFinite(todo.order)||!string(todo.recurring)||
        !Array.isArray(todo.completed_dates)||todo.completed_dates.some(value=>!string(value))||!Array.isArray(todo.subtasks))fail('INVALID_NORMAL_TODO');
    if(todo.completed_at!==null)todoTimestampMillis(todo.completed_at);
    for(const subtask of todo.subtasks) {
        if(!object(subtask)||!string(subtask.id)||!string(subtask.content))fail('INVALID_TODO_SUBTASK');
        if(!Object.hasOwn(subtask,'completed'))subtask.completed=false;
        if(!Object.hasOwn(subtask,'completed_at'))subtask.completed_at=null;
        if(typeof subtask.completed!=='boolean')fail('INVALID_TODO_SUBTASK');
        if(subtask.completed_at!==null)todoTimestampMillis(subtask.completed_at);
    }
    if(todo.reminder!==null) {
        if(!object(todo.reminder)||!string(todo.reminder.reminder_time))fail('INVALID_TODO_REMINDER');
        if(!Object.hasOwn(todo.reminder,'reminder_date'))todo.reminder.reminder_date=null;
        if(!Object.hasOwn(todo.reminder,'repeat_daily'))todo.reminder.repeat_daily=false;
        if(!nullableString(todo.reminder.reminder_date)||typeof todo.reminder.repeat_daily!=='boolean')fail('INVALID_TODO_REMINDER');
    }
    return todo;
}

function rank(todo) {
    const business={...todo};
    delete business.id;delete business.created_at;delete business.updated_at;
    // 业务完全相同后只按固定字节摘要消除表示歧义；不拿原始时间字符串排时间先后。
    return [todoTimestampMillis(todo.updated_at),canonicalLearning(business),hash(encode(todo))];
}

export function mergeNormalTodos(records) {
    if(!Array.isArray(records))fail('INVALID_NORMAL_TODOS');
    const winners=new Map();
    for(const raw of records) {
        const todo=normalizeNormalTodo(raw),previous=winners.get(todo.id),currentRank=rank(todo),oldRank=previous&&rank(previous);
        let greater=!previous;
        if(previous)for(let index=0;index<currentRank.length;index++)if(currentRank[index]!==oldRank[index]) {greater=currentRank[index]>oldRank[index];break;}
        if(greater)winners.set(todo.id,todo);
    }
    return [...winners.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
