import test from 'node:test';
import assert from 'node:assert/strict';
import { encode,canonicalize } from '../codec.mjs';
import { buildCorpus } from '../interop-corpus.mjs';
import { evaluate } from '../interop-node.mjs';
import { compareResponses } from '../run-interop.mjs';
import { businessVectors } from '../business-vectors.mjs';

test('共享语料Node参考全部符合固定期望，不依赖目录或当前时间',()=>{
    const corpus=buildCorpus(),again=buildCorpus();
    assert.deepEqual(encode(corpus),encode(again));
    assert.equal(new Set(corpus.cases.map(item=>item.request.id)).size,corpus.cases.length);
    assert.deepEqual(compareResponses(corpus.cases,corpus.cases.map(item=>evaluate(item.request))),[]);
});
test('原评分复盘规则的人工样本含正反序和重复，业务平局不是JCS',()=>{
    const samples=businessVectors();assert.equal(samples.length,15);
    const tied=samples.find(item=>item.id==='review-tie-business-not-jcs');
    assert.ok(encode(tied.records[0]).toString()>encode(tied.records[1]).toString());
    assert.equal(tied.winners[0].fact,'aa');
    const clear=samples.find(item=>item.id==='rating-tie-clear');
    assert.equal(clear.winners[0].score,null);
});
test('显式规范化可编码输入，但仍拒绝重复键，不放宽decode',()=>{
    assert.equal(canonicalize(Buffer.from(' { "b": 1.0, "a": -0 } ')).toString(),'{"a":0,"b":1}');
    assert.throws(()=>canonicalize(Buffer.from('{"a":1,"a":2}')),/DUPLICATE_JSON_KEY/);
});
test('Node接口先拒绝实际孤立UTF16字符，不在转换UTF8时替换为U+FFFD',()=>{
    for(const input of ['"\ud800"','"\udfff"','{"\ud800":1}','{"key":"\udfff"}']) {
        const response=evaluate({id:'raw-surrogate',kind:'canonicalize',input});
        assert.equal(response.ok,false);assert.equal(response.error_code,'INVALID_UNICODE');
    }
});
test('互通比较拒绝缺失、重复、乱序、错误状态与错误哈希回复',()=>{
    const cases=buildCorpus().cases.slice(0,2),replies=cases.map(item=>evaluate(item.request));
    assert.equal(compareResponses(cases,replies).length,0);
    for(const invalid of [replies.slice(0,1),[replies[1],replies[0]],[replies[0],replies[0]],
        [{...replies[0],ok:false},replies[1]],[{...replies[0],sha256:'0'.repeat(64)},replies[1]],
        [{id:replies[0].id,ok:true},replies[1]],[null,replies[1]]])assert.ok(compareResponses(cases,invalid).length>0);
});
