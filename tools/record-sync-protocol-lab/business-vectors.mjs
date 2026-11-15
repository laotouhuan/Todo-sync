// 第一版原业务规则的人工期望样本；不定义或接入正式记录操作。
const earlier = '2026-11-05T00:00:00.000Z', later = '2026-11-05T00:01:00.000Z';
const review = (id, fact, updated_at = earlier, extra = {}) => ({ id, date: '2026-11-05', created_at: earlier, updated_at,
    deleted: false, fact, obstacle: '', effective_action: '', next_step: '', ...extra });
const rating = (id, score, updated_at = earlier, extra = {}) => ({ id, date: '2026-11-05', created_at: earlier, updated_at, deleted: false, score, ...extra });

export function businessVectors() {
    const cases = [];
    const add = (id, domain, records, winners, note) => cases.push({ id, domain, records, winners, note });
    let a = rating('a', null), b = rating('b', 5, later);
    add('rating-newer-score', 'rating', [a,b], [b], '较新评分可覆盖旧清除，清除不是永久获胜');
    a = rating('a', 5); b = rating('b', null, later);
    add('rating-newer-clear', 'rating', [a,b], [b], '较新清除保留为null记录');
    a = rating('a', null); b = rating('b', 5);
    add('rating-tie-clear', 'rating', [a,b], [a], '同时间明确清除优先，不以记录枚举次序赋值');
    a = rating('a', null); b = rating('b', 5, earlier, { deleted: true });
    add('rating-tie-delete-before-clear', 'rating', [a,b], [b], '同时间先比较deleted，再比较清除');
    a = rating('a', 1); b = rating('b', 5);
    add('rating-tie-content', 'rating', [a,b], [b], '其余按原业务规范内容排序，样本b胜');
    a = rating('a', null, later); b = rating('b', 5, earlier);
    add('rating-clock-skew', 'rating', [a,b], [a], '即使后写评分在数组最后，时钟更早仍按原规则不生效');
    a = review('a', '较新整篇', later); b = review('b', '旧正文', earlier, { next_step: '另一端只改下一步' });
    add('review-whole-newer', 'review', [a,b], [a], '整篇选择，不把较新事实与旧篇下一步拼接');
    a = review('a', 'z'); b = review('b', 'aa');
    add('review-tie-business-not-jcs', 'review', [a,b], [b], '业务字符串长度前缀使aa胜，JCS对象字符串排序会错误选z');
    a = review('a', '中'); b = review('b', 'aa');
    add('review-utf16-length', 'review', [a,b], [b], '字符串长度按UTF16，不能按UTF8字节数或Unicode码点数');
    a = review('a', '😀'); b = review('b', 'abc');
    add('review-surrogate-length', 'review', [a,b], [b], 'emoji占两个UTF16单元，仍短于abc');
    a = review('a', '旧篇', earlier, { deleted: true }); b = review('b', '较新重新填写', later);
    add('review-newer-after-delete', 'review', [a,b], [b], '复盘沿用较新整篇，不能误套Todo删除单调规则');
    a = review('a', '存活'); b = review('b', '删篇', earlier, { deleted: true });
    add('review-tie-delete', 'review', [a,b], [b], '同时间复盘deleted优先');
    a = review('a', '时钟靠后的旧修改', later); b = review('b', '后写但时钟较早', earlier);
    add('review-clock-skew', 'review', [a,b], [a], '保留原时间策略，不以因果或到达顺序改变展示胜者');
    a = review('a', 'z', '2026-11-05T00:00:00.0009Z'); b = review('b', 'aa', '2026-11-05T00:00:00.0001Z');
    add('review-millisecond-tie', 'review', [a,b], [b], '现有两端按毫秒比较，小数毫秒差异不改用纳秒裁决');
    a = review('a', '另一天', later, { date: '2026-11-06' }); b = review('b', '当天', earlier);
    add('review-date-order', 'review', [a,b], [b,a], '按date分别保留且结果日期升序');
    return cases;
}
