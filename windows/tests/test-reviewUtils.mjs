import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportReviews, reviewPreview } from '../src/reviewUtils.js';

process.env.TZ='Asia/Shanghai';
const review={id:'r',date:'2026-09-10',fact:'推导第一步\n理解第二步\n第三行',obstacle:'',effective_action:'放下手机',next_step:'再检查条件',deleted:false};
const entry={id:'t',started_at:'2026-09-10T23:40:00+08:00',ended_at:'2026-09-11T00:20:00+08:00',label_snapshot:'数学|证明',deleted:false};
test('预览原文前两行，空事实回退',()=>{
    assert.equal(reviewPreview(review),'事实：推导第一步\n理解第二步');
    assert.equal(reviewPreview({...review,fact:''}),'有效动作：放下手机');
});
test('默认逐日附带统计及跨日次数，文本和标签可导出',()=>{
    const result=exportReviews({daily_reviews:[review],time_entries:[entry]},'week',new Date('2026-09-10T12:00:00'));
    assert.equal(result.filename,'2026-09-07_2026-09-13-复盘.md');
    assert.match(result.content,/数学\\\|证明/);assert.match(result.content,/当日未填写复盘/);
    assert.match(result.content,/## 2026-09-11/);assert.match(result.content,/20 分钟，1 次/);
    assert.match(result.content,/未填写/);
});
test('关闭统计不包含只有计时的日期，空范围不给空文件',()=>{
    const result=exportReviews({daily_reviews:[review],time_entries:[entry]},'month',new Date('2026-09-10T12:00:00'),false);
    assert.equal(result.filename,'2026-09-复盘.md');assert.doesNotMatch(result.content,/学习投入|2026-09-11/);
    assert.throws(()=>exportReviews({daily_reviews:[],time_entries:[]},'day',new Date()),/没有可导出/);
});
