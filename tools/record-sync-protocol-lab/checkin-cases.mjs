// 当前打卡额外归并规则的独立样本；不定义新胜出策略。
export function checkinCases() {
    const date='2026-11-05',early='2026-11-05T09:00:00+08:00',late='2026-11-05T11:00:00+08:00';
    const cases=[];
    const add=(id,local_dates,cloud_dates,local_updated,cloud_updated,expected)=>cases.push({id,local_dates,cloud_dates,local_updated,cloud_updated,expected});
    add('legacy-local-calendar',[date],[],early,late,[date]);
    add('legacy-cloud-calendar',[],[date],late,early,[date]);
    add('same-calendar-both',[date],[date],early,late,[date]);
    add('local-mark-after-cloud-update',[late],[],early,early,[late]);
    add('cloud-mark-after-local-update',[],[late],early,early,[late]);
    add('local-mark-before-cloud-update',[early],[],early,late,[]);
    add('cloud-mark-before-local-update',[],[early],late,early,[]);
    add('mark-exactly-at-other-update',[late],[],early,late,[]);
    add('timed-record-longer-than-calendar',[date],[early],early,late,[early]);
    const detailed='2026-11-05T09:00:00.000+08:00';
    add('longer-format-before-shorter-later',[detailed],[late],early,late,[detailed]);
    const markA='2026-11-05T10:00:00+08:00',markB='2026-11-05T11:00:00+08:00';
    add('equal-length-local-A',[markA],[markB],early,early,[markA]);
    add('equal-length-local-B',[markB],[markA],early,early,[markB]);
    add('submillisecond-boundary',['2026-11-05T10:00:00.0002+08:00'],[],early,'2026-11-05T10:00:00.0001+08:00',null);
    add('multiple-calendar-output-order',['2026-11-06','2026-11-05'],[],early,late,null);
    return cases;
}
