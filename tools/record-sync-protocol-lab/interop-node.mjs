import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { encode, decode, canonicalize, hash, validateUnicode } from './codec.mjs';
import { validateJoin, verifyRecord } from './envelope.mjs';
import { canonicalLearning, mergeLearningRecords } from '../../windows/src/timeTracking.js';
import { mergeNormalTodos } from './normal-todo.mjs';

const bytes = hex => {
    if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('INVALID_HEX');
    return Buffer.from(hex,'hex');
};
function mergeRatings(records) {
    const result = new Map();
    const rank = record => [Date.parse(record.updated_at || record.created_at) || 0, Number(!!record.deleted), Number(record.score === null), canonicalLearning(record)];
    for (const record of records) {
        const previous = result.get(record.date);
        const a=rank(record),b=previous&&rank(previous);
        let greater = !previous;
        if (previous) for (let index=0;index<a.length;index++) { if(a[index]!==b[index]) {greater=a[index]>b[index];break;} }
        if (greater) result.set(record.date,structuredClone(record));
    }
    return [...result.values()].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
}

// Node参考端；复盘调用现有Windows纯函数，评分仅按已确认设计作实验归并。
export function evaluate(request) {
    const id=request?.id ?? null;
    try {
        let output;
        if(request.kind==='canonicalize') {
            if(typeof request.input!=='string') throw new Error('INVALID_INPUT');
            output=canonicalize(Buffer.from(validateUnicode(request.input)));
        } else if(request.kind==='decode') output=encode(decode(bytes(request.hex)));
        else if(request.kind==='number') {
            const input=bytes(request.hex);if(input.length!==8)throw new Error('INVALID_NUMBER_BITS');
            output=encode(input.readDoubleBE());
        } else if(request.kind==='join') validateJoin(request.pin,bytes(request.descriptor_hex),bytes(request.baseline_hex));
        else if(request.kind==='record') verifyRecord(request.pin,request.name,bytes(request.hex));
        else if(request.kind==='business') {
            if(!Array.isArray(request.records)||!['review','rating','todo'].includes(request.domain))throw new Error('INVALID_BUSINESS_CASE');
            const winners=request.domain==='todo'?mergeNormalTodos(request.records):request.domain==='review'?mergeLearningRecords(request.records,[],'date'):mergeRatings(request.records);
            return {id,ok:true,winners};
        } else throw new Error('UNKNOWN_REQUEST');
        return {id,ok:true,...(output?{canonical:output.toString('utf8'),sha256:hash(output)}:{})};
    } catch(error) { return {id,ok:false,error_code:error.message}; }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
    for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
        let response;
        try {response=evaluate(JSON.parse(line));}catch {response={id:null,ok:false,error_code:'INVALID_REQUEST'};}
        console.log(JSON.stringify(response));
    }
}
