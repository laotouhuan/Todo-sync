import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode, hash } from '../codec.mjs';

const vectors = JSON.parse(readFileSync(new URL('../vectors.json', import.meta.url), 'utf8'));
for (const [hex, expected] of vectors.numbers) {
    test(`RFC 数值样本 ${hex}`, () => {
        assert.equal(encode(Buffer.from(hex, 'hex').readDoubleBE()).toString(), expected);
        assert.equal(encode(decode(Buffer.from(expected))).toString(), expected);
    });
}
test('键顺序使用 UTF-16 而不是整数键枚举、区域或 UTF-8 顺序', () => {
    const value = { '2': '二', '10': '十', '\ue000': '后', '😀': '前', nested: [{ z: 2, a: 1 }] };
    assert.equal(encode(value).toString(), '{"10":"十","2":"二","nested":[{"a":1,"z":2}],"😀":"前","":"后"}');
});
test('文本保持 Unicode 和日历字符串；数组不排序', () => {
    const value = ['2026-11-05', 'é', 'e\u0301', '中😀', null, false, '\n\t"\\'];
    assert.equal(JSON.stringify(decode(encode(value))), JSON.stringify(value));
    assert.notEqual(hash(encode('é')), hash(encode('e\u0301')));
});
for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}']) {
    test(`解析前拒绝重复键 ${raw}`, () => assert.throws(() => decode(Buffer.from(raw)), /DUPLICATE_JSON_KEY/));
}
for (const raw of [' {"a":1}', '{"b":2,"a":1}', '{"a":1}\n', '1.0', '-0', '1E+23', '9007199254740993', '"\\u0061"']) {
    test(`不悄悄修复非规范字节 ${raw}`, () => assert.throws(() => decode(Buffer.from(raw)), /NON_CANONICAL_JSON/));
}
for (const raw of ['{"a":}', '[1,]', '{"a":1,}', '[01]', 'truefalse', '1e', '"\\x"', '"\n"', '\ufeff{}']) {
    test(`拒绝无效 JSON ${JSON.stringify(raw)}`, () => assert.throws(() => decode(Buffer.from(raw)), /INVALID_JSON/));
}
test('拒绝无效 UTF-8 与截断字节', () => {
    for (const bytes of [[0xff], [0x22, 0xc0, 0xaf, 0x22], [0x22, 0xf0, 0x9f]]) assert.throws(() => decode(Uint8Array.from(bytes)), /INVALID_UTF8/);
});
for (const char of ['\ud800', '\udfff', '\ufdd0', '\uffff', String.fromCodePoint(0x10ffff)]) {
    test(`拒绝非法字符 ${char.charCodeAt(0).toString(16)}`, () => {
        assert.throws(() => encode(char), /INVALID_UNICODE/);
        assert.throws(() => decode(Buffer.from(JSON.stringify(char))), /INVALID_UNICODE/);
    });
}
test('拒绝非 JSON 值且不执行 getter 或 toJSON', () => {
    for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(), [undefined]]) assert.throws(() => encode(value));
    let called = false;
    const value = Object.defineProperty({}, 'a', { enumerable: true, get() { called = true; return 1; } });
    assert.throws(() => encode(value), /INVALID_JSON_PROPERTY/);
    assert.throws(() => encode({ toJSON() { called = true; return {}; } }));
    assert.equal(called, false);
});
test('拒绝循环、稀疏数组及额外属性', () => {
    const circular = {}; circular.x = circular;
    assert.throws(() => encode(circular), /CYCLIC_JSON/);
    assert.throws(() => encode(new Array(2)), /INVALID_JSON_ARRAY/);
    const array = [1]; array.other = true;
    assert.throws(() => encode(array), /INVALID_JSON_ARRAY/);
    assert.throws(() => encode({ [Symbol('x')]: 1 }), /INVALID_JSON_PROPERTY/);
});
test('特殊键无原型污染；允许重复引用的非循环值', () => {
    const value = decode(Buffer.from('{"__proto__":{"polluted":true},"constructor":1}'));
    assert.equal(Object.getPrototypeOf(value), null);
    assert.equal({}.polluted, undefined);
    const shared = { a: 1 };
    assert.equal(encode([shared, shared]).toString(), '[{"a":1},{"a":1}]');
});
test('大小和嵌套深度有明确实验限制', () => {
    assert.throws(() => encode('x'.repeat(1024 * 1024)), /JSON_SIZE_LIMIT/);
    assert.throws(() => decode(Buffer.alloc(1024 * 1024 + 1)), /JSON_SIZE_LIMIT/);
    assert.throws(() => decode(Buffer.from('['.repeat(130) + '0' + ']'.repeat(130))), /JSON_DEPTH_LIMIT/);
});
