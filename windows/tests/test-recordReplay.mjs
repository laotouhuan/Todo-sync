import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayPersonalRecords } from '../src/recordReplay.js';
import { inspect, seal, validateJoin } from '../../tools/record-sync-protocol-lab/envelope.mjs';
import { COLLABORATION_CAUSAL_SERIES_PROFILE, COLLABORATION_RECORD_PROFILE } from '../../tools/record-sync-protocol-lab/collaboration-record-profile.mjs';

const fixtureAt = name => JSON.parse(readFileSync(new URL(`../../tests/fixtures/native-record-journal/${name}`, import.meta.url)));
const artifact = item => ({ name: item.name, bytes: Buffer.from(item.content, 'base64') });
const causalFixture = fixtureAt('series-causal-replay.json');

test('系列操作集由数据集描述符固定，旧版本拒绝加入新版数据集', () => {
    const { pin, baseline, descriptor } = causalFixture;
    const bytes = seal('baseline', { protocol: pin.protocol, dataset_id: pin.dataset_id, data: baseline }).bytes;
    assert.equal(validateJoin(pin, artifact(descriptor).bytes, bytes, COLLABORATION_CAUSAL_SERIES_PROFILE).descriptor.operation_set,
        COLLABORATION_CAUSAL_SERIES_PROFILE.id);
    assert.throws(() => validateJoin(pin, artifact(descriptor).bytes, bytes, COLLABORATION_RECORD_PROFILE), /INVALID_DATASET_BINDING/);
});

for (const [fixture, profile] of [
    [fixtureAt('replay.json'), COLLABORATION_RECORD_PROFILE],
    [causalFixture, COLLABORATION_CAUSAL_SERIES_PROFILE]
]) {
    for (const row of fixture.cases) {
        test(`隔离业务重放：${row.name}`, () => {
            const artifacts = row.journal.records.map(artifact);
            const dependencies = inspect(fixture.pin, artifacts, profile);
            if (row.error === 'RECORD_DEPENDENCIES_MISSING') {
                assert.equal(dependencies.complete, false);
                return;
            }
            assert.equal(dependencies.complete, true);
            const before = structuredClone(fixture.baseline);
            const replay = records => replayPersonalRecords(fixture.baseline, records, profile.id);
            if (row.error) {
                assert.throws(() => replay(dependencies.ordered), new RegExp(row.error));
            } else {
                assert.deepEqual(replay(dependencies.ordered), row.expected);
                if (fixture === causalFixture) {
                    const reordered = inspect(fixture.pin, [...artifacts].reverse(), profile);
                    assert.deepEqual(replay(reordered.ordered), row.expected);
                }
            }
            assert.deepEqual(fixture.baseline, before);
        });
    }
}
