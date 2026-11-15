// 人工固定期望，描述已批准的整条Todo规则；不依赖被测比较函数生成winner。
const time='2026-11-05T00:00:00.000Z';
const id='10000000-0000-4000-8000-000000000001';
export const normalTodo=(fields={})=>({id,content:'任务',created_at:time,updated_at:time,date:null,time:null,completed:false,completed_at:null,
    order:0,deleted:false,recurring:'none',task_type:'normal',completed_dates:[],target_count:null,reminder:null,subtasks:[],label:null,...fields});

export function normalTodoVectors() {
    const cases=[];
    const add=(id,records,winners,note)=>cases.push({id,domain:'todo',records,winners,note});
    let a=normalTodo({content:'甲的新内容',updated_at:'2026-11-05T00:01:00Z',completed:true}),b=normalTodo({label:'课程',updated_at:'2026-11-05T00:02:00Z'});
    add('todo-later-whole',[a,b],[b],'只选较新整条，不能拼甲内容／完成与乙标签');
    a=normalTodo({content:'z'});b=normalTodo({content:'aa'});
    add('todo-tie-business-key',[a,b],[b],'同时间业务内容固定排序，UTF16长度编码使aa胜');
    a=normalTodo({content:'z',updated_at:'2026-11-05T08:00:00+08:00'});b=normalTodo({content:'aa',updated_at:'2026-11-05T00:00:00Z'});
    add('todo-offset-same-instant',[a,b],[b],'时间字符串词序不能压过业务内容，实际时间相同');
    a=normalTodo({content:'aaaaaaaa',updated_at:'2026-11-05T09:00:00+08:00'});b=normalTodo({content:'b',updated_at:'2026-11-05T01:30:00Z'});
    add('todo-offset-later-instant',[a,b],[b],'UTC实际01:30晚于01:00，不能按09和01的字符串排序');
    a=normalTodo({content:'z',updated_at:'2026-11-05T00:00:00.0009Z'});b=normalTodo({content:'aa',updated_at:'2026-11-05T00:00:00.0001Z'});
    add('todo-millisecond-tie',[a,b],[b],'小数毫秒截去后形成平局，不改成纳秒优先');
    a=normalTodo({content:'旧删除',deleted:true,updated_at:'1969-12-31T23:59:59.9999Z'});b=normalTodo({content:'后续未删',updated_at:'1970-01-01T00:00:00Z'});
    add('todo-epoch-zero',[a,b],[b],'epoch0是有效时间，不得用falsy判定为无时间');
    a=normalTodo({content:'删除旧版',deleted:true});b=normalTodo({content:'较新未删版',updated_at:'2026-11-05T00:00:01Z'});
    add('todo-delete-not-monotonic',[a,b],[b],'保留原整条时间优先，删除不永久获胜');
    a=normalTodo({content:'z',deleted:true});b=normalTodo({content:'aa',deleted:false});
    add('todo-delete-not-tie-priority',[a,b],[b],'同时间也不额外加deleted rank，内容排序可让未删版胜');
    const partial={id,content:'任务',created_at:time};
    add('todo-missing-defaults',[partial],[normalTodo()],'缺字段补默认值，缺更新时间回退created_at');
    add('todo-null-updated',[{...partial,updated_at:null}],[normalTodo()],'显式null更新时间兼容回退创建时间');
    add('todo-empty-updated',[{...partial,updated_at:''}],[normalTodo()],'空更新时间兼容回退创建时间');
    a=normalTodo({label:' \ufeffe\u0301\u3000'});
    add('todo-label-nfc-trim',[a],[normalTodo({label:'é'})],'固定JS空白集合与NFC，不改正文');
    a=normalTodo({label:' 未分类 '});add('todo-label-unclassified',[a],[normalTodo()],'未分类与空标签统一null');
    a=normalTodo({label:3,target_count:0});add('todo-legacy-label-target',[a],[normalTodo()],'沿现有归一化，非字符串label及非正安全整数目标归null');
    const subtask={id:'子任务可保留旧ID',content:'原样',custom:{keep:true}};
    const reminder={reminder_time:'08:30',custom:['原扩展']};
    a=normalTodo({subtasks:[subtask],reminder,extension:{future:'完整保留'}});
    b=normalTodo({subtasks:[{...subtask,completed:false,completed_at:null}],reminder:{...reminder,reminder_date:null,repeat_daily:false},extension:{future:'完整保留'}});
    add('todo-nested-defaults-extensions',[a],[b],'补嵌套默认值但不丢未知字段');
    a=normalTodo({extension:{key:'z'}});b=normalTodo({extension:{key:'aa'}});
    add('todo-extension-tie',[a,b],[b],'扩展业务内容也参与固定排序，获胜整条保留扩展');
    a=normalTodo({subtasks:[{id:'2',content:'第二',completed:false,completed_at:null},{id:'1',content:'第一',completed:true,completed_at:time}],completed_dates:['2026-11-04','2026-11-03']});
    add('todo-array-order',[a],[a],'子任务与历史数组保持原顺序，不为排序改变业务列表');
    a=normalTodo();b=normalTodo({updated_at:'2026-11-05T08:00:00.000+08:00'});
    add('todo-equivalent-business-metadata',[a,b],[a],'业务完全相等后按完整规范字节摘要兜底，两个方向选同一表示，不比较时间字符串词序');
    a=normalTodo({id:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'});
    add('todo-uppercase-identity',[a],[a],'兼容大小写UUID但不改身份字符串或原匹配规则');
    a=normalTodo({id:'10000000-0000-4000-8000-000000000002'});b=normalTodo();
    add('todo-id-order',[a,b],[b,a],'按身份序输出，不依赖系统区域排序');
    return cases;
}

export function invalidNormalTodoVectors() {
    const cases=[{task_type:'weekly_checkin'},{task_type:'monthly_checkin'},{updated_at:'2026-11-05T00:00:00'},
        {created_at:'2026-02-30T00:00:00Z'},{updated_at:'2026-11-05T24:00:00Z'},{completed:null},{deleted:1},{order:'1'},
        {subtasks:null},{subtasks:[{id:'x',content:'y',completed:null}]},{subtasks:[{id:'x',content:'y',completed_at:''}]},
        {reminder:{reminder_time:'08:00',repeat_daily:null}},{reminder:{reminder_time:'08:00',reminder_date:1}},
        {completed_at:''},{id:'invalid-id'},{content:null},{completed_dates:[false]}];
    return cases.map((fields,index)=>({id:'invalid-todo-'+index,records:[normalTodo(fields)]}));
}
