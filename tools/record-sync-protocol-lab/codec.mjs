import { createHash } from 'node:crypto';

// 仅供协议实验；按 JCS 编码，并在对象解析丢失信息前拒绝重复键。
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 128;
const fail = code => { throw new Error(code); };

function validString(text) {
    for (const char of text) {
        const code = char.codePointAt(0);
        if (code >= 0xd800 && code <= 0xdfff || code >= 0xfdd0 && code <= 0xfdef ||
            (code & 0xffff) >= 0xfffe) fail('INVALID_UNICODE');
    }
    return text;
}

export function validateUnicode(text) {
    if(typeof text!=='string')fail('EXPECTED_STRING');
    return validString(text);
}

export function encode(value) {
    const ancestors = new Set();
    function visit(item, depth) {
        if (depth > MAX_DEPTH) fail('JSON_DEPTH_LIMIT');
        if (item === null || typeof item === 'boolean') return JSON.stringify(item);
        if (typeof item === 'string') return JSON.stringify(validString(item));
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) fail('INVALID_JSON_NUMBER');
            return JSON.stringify(item);
        }
        if (!item || typeof item !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item))) fail('INVALID_JSON_VALUE');
        if (ancestors.has(item)) fail('CYCLIC_JSON');
        ancestors.add(item);
        const keys = Reflect.ownKeys(item);
        if (keys.some(key => typeof key !== 'string')) fail('INVALID_JSON_PROPERTY');
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable && !(Array.isArray(item) && key === 'length')) fail('INVALID_JSON_PROPERTY');
        }
        let result;
        if (Array.isArray(item)) {
            if (keys.length !== item.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) fail('INVALID_JSON_ARRAY');
            result = '[' + Array.from({ length: item.length }, (_, index) => {
                if (!Object.hasOwn(item, index)) fail('INVALID_JSON_ARRAY');
                return visit(item[index], depth + 1);
            }).join(',') + ']';
        } else {
            if (Object.getPrototypeOf(item) === Array.prototype) fail('INVALID_JSON_VALUE');
            result = '{' + keys.sort().map(key => JSON.stringify(validString(key)) + ':' + visit(item[key], depth + 1)).join(',') + '}';
        }
        ancestors.delete(item);
        if (Buffer.byteLength(result) > MAX_BYTES) fail('JSON_SIZE_LIMIT');
        return result;
    }
    const result = Buffer.from(visit(value, 0), 'utf8');
    if (result.byteLength > MAX_BYTES) fail('JSON_SIZE_LIMIT');
    return result;
}

export function hash(bytes) {
    if (!(bytes instanceof Uint8Array)) fail('EXPECTED_BYTES');
    return createHash('sha256').update(bytes).digest('hex');
}

function parse(bytes, requireCanonical) {
    if (!(bytes instanceof Uint8Array)) fail('EXPECTED_BYTES');
    if (bytes.byteLength > MAX_BYTES) fail('JSON_SIZE_LIMIT');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { fail('INVALID_UTF8'); }
    let index = 0;
    const whitespace = () => { while (/[\t\r\n ]/.test(text[index] ?? '\0')) index++; };
    function string() {
        const start = index++;
        while (index < text.length) {
            const char = text[index++];
            if (char === '"') {
                let parsed;
                try { parsed = JSON.parse(text.slice(start, index)); } catch { fail('INVALID_JSON'); }
                return validString(parsed);
            }
            if (char === '\\') index++;
            else if (char.charCodeAt(0) < 0x20) fail('INVALID_JSON');
        }
        return fail('INVALID_JSON');
    }
    function value(depth) {
        if (depth > MAX_DEPTH) fail('JSON_DEPTH_LIMIT');
        whitespace();
        const char = text[index];
        if (char === '"') return string();
        if (char === '{' || char === '[') {
            const isObject = char === '{', end = isObject ? '}' : ']';
            const result = isObject ? Object.create(null) : [], seen = new Set();
            index++; whitespace();
            if (text[index] === end) { index++; return result; }
            while (index < text.length) {
                let key;
                if (isObject) {
                    if (text[index] !== '"') fail('INVALID_JSON');
                    key = string();
                    if (seen.has(key)) fail('DUPLICATE_JSON_KEY');
                    seen.add(key); whitespace();
                    if (text[index++] !== ':') fail('INVALID_JSON');
                }
                const child = value(depth + 1);
                if (isObject) result[key] = child; else result.push(child);
                whitespace();
                if (text[index] === end) { index++; return result; }
                if (text[index++] !== ',') fail('INVALID_JSON');
                whitespace();
            }
            return fail('INVALID_JSON');
        }
        for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
            if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
        }
        const pattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
        pattern.lastIndex = index;
        const token = pattern.exec(text);
        if (!token) fail('INVALID_JSON');
        index = pattern.lastIndex;
        const number = Number(token[0]);
        if (!Number.isFinite(number)) fail('INVALID_JSON_NUMBER');
        return number;
    }
    const result = value(0);
    whitespace();
    if (index !== text.length) fail('INVALID_JSON');
    if (requireCanonical && !encode(result).equals(Buffer.from(bytes))) fail('NON_CANONICAL_JSON');
    return result;
}

/** 只接收已规范化 UTF-8 字节；不把不规范输入悄悄转换为合法记录。 */
export function decode(bytes) { return parse(bytes, true); }

/** 互通实验的显式编码入口，不用于自动转换或导入用户旧数据。 */
export function canonicalize(bytes) { return encode(parse(bytes, false)); }
