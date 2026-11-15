import { readFileSync, writeFileSync } from 'node:fs';
import { seal } from './envelope.mjs';

const destination = process.argv[2];
const incomplete = process.argv[3] === '--missing-parent';
if (!destination || (process.argv[3] && !incomplete)) {
    console.error('用法：node tools/record-sync-protocol-lab/make-recovery-preview.mjs 新文件.json [--missing-parent]');
    process.exitCode = 1;
} else {
    const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/native-record-journal/series-causal-replay.json', import.meta.url)));
    const { pin, baseline, descriptor, cases } = fixture;
    const snapshot = seal('baseline', { protocol: pin.protocol, dataset_id: pin.dataset_id, data: baseline });
    if (snapshot.sha256 !== pin.baseline_sha256) throw new Error('DATASET_HASH_MISMATCH');
    const records = cases[0].journal.records;
    const material = { pin, descriptor: descriptor.content, baseline: snapshot.bytes.toString('base64'),
        received: incomplete ? records.slice(0, 1) : records };
    writeFileSync(destination, JSON.stringify(material, null, 2) + '\n', { flag: 'wx' });
}
