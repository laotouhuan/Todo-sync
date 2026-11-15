import { readFileSync } from 'node:fs';
import { encode, hash } from './codec.mjs';
import { businessVectors } from './business-vectors.mjs';
import { normalTodoVectors, invalidNormalTodoVectors } from './normal-todo-vectors.mjs';
import { createRecord } from './envelope.mjs';
import { businessFixture } from './business-e2e-worker.mjs';
import { COLLABORATION_RECORD_PROFILE } from './collaboration-record-profile.mjs';
import { deleteSeriesWorkflow } from './series-workflow-profile.mjs';
import { deletePreview } from '../../windows/src/taskSeries.js';

const copy = value => structuredClone(value);

/** 一份固定请求语料供三个独立进程消费；期望不交给Rust/Kotlin可执行程序。 */
export function buildCorpus() {
    const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
    const wire = JSON.parse(readFileSync(new URL('./wire-vectors.json', import.meta.url), 'utf8'));
    const cases = [];
    function add(id, group, request, expected) { cases.push({ group, request: { id, ...request }, expected: { id, ...expected } }); }
    function text(id, group, input, expected) { add(id, group, { kind: 'canonicalize', input }, { ok: true, canonical: expected, sha256: hash(Buffer.from(expected)) }); }
    for (const [hex, canonical] of vectors.numbers) add('rfc-' + hex, 'number-rfc', { kind: 'number', hex }, { ok: true, canonical, sha256: hash(Buffer.from(canonical)) });
    let seed = 0x8bb84b93962eacc9n;
    for (let n = 0; n < 256; n++) {
        seed ^= seed >> 12n; seed ^= seed << 25n; seed ^= seed >> 27n; seed = BigInt.asUintN(64, seed);
        const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(seed);
        const value = bytes.readDoubleBE();
        if (!Number.isFinite(value)) continue;
        const canonical = JSON.stringify(value);
        add('sample-' + bytes.toString('hex'), 'number-differential', { kind: 'number', hex: bytes.toString('hex') }, { ok: true, canonical, sha256: hash(Buffer.from(canonical)) });
    }
    for (const hex of ['7ff0000000000000', 'fff0000000000000', '7ff8000000000000']) add('nonfinite-' + hex, 'negative-number', { kind: 'number', hex }, { ok: false });
    const canonicalCases = [
        ['integer-keys', '{"2":"二","10":"十"}', '{"10":"十","2":"二"}'],
        ['utf16-key-order', '{"":2,"😀":1}', '{"😀":1,"":2}'],
        ['nested-array', ' { "b" : [true,null,{"z":0,"a":"中"}], "a":-0 } ', '{"a":0,"b":[true,null,{"a":"中","z":0}]}'],
        ['combining', '["é","e\\u0301","2026-11-05","\\n\\t\\b\\f\\r\\\"\\\\"]', '["é","é","2026-11-05","\\n\\t\\b\\f\\r\\\"\\\\"]'],
        ['scientific', '[1E23,1e-6,1e-7,1000000000000000000000]', '[1e+23,0.000001,1e-7,1e+21]'],
        ['special-keys', '{"constructor":1,"__proto__":{"safe":true}}', '{"__proto__":{"safe":true},"constructor":1}'],
        ['literal-null', ' null ', 'null'], ['literal-string', ' "hello" ', '"hello"']
    ];
    canonicalCases.forEach(([id,input,expected]) => text('canonical-' + id, 'canonical-positive', input, expected));
    const invalid = ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '[1,]', '{"a":}', '01', 'truefalse',
        '1e400', '-1e400', '"\\ud800"', '"\\udfff"', '"\\ufdd0"', '"\\uffff"', '"\\udbff\\udfff"', '"\u0000"', '\ufeff{}', '['.repeat(130)+'0'+']'.repeat(130)];
    invalid.forEach((input,n) => add('bad-json-' + n, 'negative-json', { kind: 'canonicalize', input }, { ok: false }));
    for (const [n,hex] of ['ff','22c0af22','22f09f','eda080','efbbbf7b7d'].entries()) add('bad-bytes-'+n, 'negative-utf8', { kind:'decode',hex }, { ok:false });
    for (const [n,input] of [' {"a":1}','{"b":2,"a":1}','1.0','-0','"\\u0061"','9007199254740993'].entries()) add('not-canonical-'+n,'negative-canonical',{kind:'decode',hex:Buffer.from(input).toString('hex')},{ok:false});
    for (const [n,item] of wire.artifacts.entries()) {
        const value = JSON.parse(item.utf8);
        text('wire-encode-'+n,'wire-positive',JSON.stringify(value,null,2),item.utf8);
        add('wire-decode-'+n,'wire-positive',{kind:'decode',hex:item.hex},{ok:true,canonical:item.utf8,sha256:item.sha256});
    }
    const fixture = businessFixture(), { dataset } = fixture, profile = COLLABORATION_RECORD_PROFILE;
    const addRecord = createRecord({ pin: dataset.pin, ...fixture.add, profile });
    const editRecord = createRecord({ pin: dataset.pin, ...fixture.edit, profile });
    const beforeDelete = profile.project(dataset.baseline.value.data, [editRecord.value]);
    const deletion = deleteSeriesWorkflow(deletePreview(beforeDelete, fixture.member.id, true), fixture.later);
    const deleteRecord = createRecord({ pin: dataset.pin, ...fixture.edit, id: fixture.deleteRecordId,
        operations: [deletion], parents: [editRecord], profile });
    for (const [name, item] of Object.entries({ baseline: dataset.baseline, descriptor: dataset.descriptor, addRecord, editRecord, deleteRecord })) {
        const canonical = item.bytes.toString('utf8');
        text(`business-wire-encode-${name}`, 'business-wire-bytes', JSON.stringify(item.value, null, 2), canonical);
        add(`business-wire-decode-${name}`, 'business-wire-bytes', { kind: 'decode', hex: item.bytes.toString('hex') },
            { ok: true, canonical, sha256: item.sha256 });
    }
    const base = wire.artifacts[0], descriptor = wire.artifacts[1];
    const join = {kind:'join',pin:wire.pin,descriptor_hex:descriptor.hex,baseline_hex:base.hex};
    add('join-valid','join-positive',join,{ok:true});
    const wrongPins = [{dataset_id:[wire.pin.dataset_id]}, {descriptor_sha256:[wire.pin.descriptor_sha256]}, {baseline_sha256:[wire.pin.baseline_sha256]},
        {namespace:'../'}, {descriptor_sha256:'0'.repeat(64)}, {extra:true}, {protocol:1}];
    wrongPins.forEach((fields,n)=>add('join-pin-'+n,'negative-join',{...join,pin:{...wire.pin,...fields}},{ok:false}));
    for (const [n,fields] of [{operation_set:'unknown/1'},{data_schema_version:2},{created_at:'2026-02-30T00:00:00Z'}, {extra:true}].entries()) {
        const body = encode({...JSON.parse(descriptor.utf8),...fields});
        add('join-descriptor-'+n,'negative-join',{...join,descriptor_hex:body.toString('hex'),pin:{...wire.pin,descriptor_sha256:hash(body)}},{ok:false});
    }
    const invalidBase = encode({...JSON.parse(base.utf8),data:[]});
    const descWithBase = encode({...JSON.parse(descriptor.utf8),baseline_sha256:hash(invalidBase)});
    add('join-bad-baseline','negative-join',{...join,baseline_hex:invalidBase.toString('hex'),descriptor_hex:descWithBase.toString('hex'),
        pin:{...wire.pin,baseline_sha256:hash(invalidBase),descriptor_sha256:hash(descWithBase)}},{ok:false});
    for (const [n,item] of wire.artifacts.slice(2).entries()) add('record-valid-'+n,'record-positive',{kind:'record',pin:wire.pin,name:item.name,hex:item.hex},{ok:true});
    const record = JSON.parse(wire.artifacts[4].utf8);
    function recordCase(id, body, expected, name) {
        const bytes=encode(body);
        add(id, expected ? 'record-positive':'negative-record',{kind:'record',pin:wire.pin,name:name??`records/${record.id}.${hash(bytes)}.json`,hex:bytes.toString('hex')},{ok:expected});
    }
    const changes=[{protocol:1},{dataset_id:'11111111-1111-4111-8111-111111111111'},{descriptor_sha256:'0'.repeat(64)}, {actor_id:[record.actor_id]},
        {actor_id:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}, {id:[record.id]}, {extra:true},{lamport:0},{lamport:-1},{lamport:2**53},{lamport:1.5},
        {parents:[...record.parents].reverse()},{parents:[record.parents[0],record.parents[0]]},{parents:[{id:record.id,sha256:record.parents[0].sha256}]},
        {parents:[{id:[record.parents[0].id],sha256:record.parents[0].sha256}]},{parents:[{id:record.parents[0].id,sha256:[record.parents[0].sha256]}]},
        {created_at:'2026-02-30T00:00:00Z'},{created_at:'2026-11-05T24:00:00Z'},{created_at:'2026-11-05T00:00:60Z'},
        {created_at:'2026-11-05T00:00:00+24:00'},{created_at:'2026-11-05T00:00:00'},
        {operations:[]},{operations:[{type:'todo.add',todo:{}}]},{operations:[{type:'lab.note.set',key:'x',value:3}]},
        {operations:[{type:'lab.note.set',key:'',value:'v'}]},{operations:[{type:'lab.note.set',key:'x',value:'v',extra:true}]}];
    changes.forEach((fields,n)=>recordCase('record-mutated-'+n,{...record,...fields},false));
    const missingField = copy(record); delete missingField.parents;
    recordCase('record-missing-field',missingField,false);
    for (const [n,created_at] of ['2026-11-05T08:00:00+08:00','2024-02-29T00:00:00.000001Z','0000-01-01T00:00:00Z'].entries()) recordCase('record-time-'+n,{...record,created_at},true);
    add('record-path-traversal','negative-record',{kind:'record',pin:wire.pin,name:'../'+wire.artifacts[2].name,hex:wire.artifacts[2].hex},{ok:false});
    add('record-wrong-hash','negative-record',{kind:'record',pin:wire.pin,name:wire.artifacts[2].name,hex:Buffer.from('{}').toString('hex')},{ok:false});
    for (const vector of businessVectors()) {
        for (const [n,records] of [vector.records,[...vector.records].reverse(),[...vector.records,...vector.records]].entries()) {
            add(vector.id+'-'+n,'business-'+vector.domain,{kind:'business',domain:vector.domain,records},{ok:true,winners:vector.winners});
        }
    }
    for(const vector of normalTodoVectors())for(const [n,records]of [vector.records,[...vector.records].reverse(),[...vector.records,...vector.records]].entries()) {
        add(vector.id+'-'+n,'business-todo',{kind:'business',domain:'todo',records},{ok:true,winners:vector.winners});
    }
    for(const vector of invalidNormalTodoVectors())add(vector.id,'negative-business-todo',{kind:'business',domain:'todo',records:vector.records},{ok:false});
    return { version:1,scope:'isolated-protocol-lab', cases };
}
