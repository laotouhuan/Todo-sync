import { open, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decode, hash } from './codec.mjs';
import { validatePin, verifyRecord } from './envelope.mjs';
import { captureProfile } from './operation-profile.mjs';

const recordName = /^records\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}\.json$/;
const maxBytes = 1024 * 1024;

async function readBounded(path) {
    const file = await open(path, 'r');
    try {
        if (!(await file.stat()).isFile()) throw new Error('NOT_REGULAR_FILE');
        const bytes = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) return Buffer.from(bytes.subarray(0, offset));
            offset += bytesRead;
        }
        throw new Error('JSON_SIZE_LIMIT');
    } finally { await file.close(); }
}

/** 只读扫描独立记录目录。冲突副本的名字不参与判定，也不删改原文件。 */
export async function scanFolderRecords({ directory, pin, profile }) {
    validatePin(pin);
    profile = captureProfile(profile);
    const root = await realpath(directory);
    const files = await readdir(root, { withFileTypes: true });
    const accepted = new Map(), identityNames = new Map(), evidence = [];
    for (const item of files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!item.isFile() || item.isSymbolicLink()) {
            evidence.push({ file: item.name, result: 'unresolved-entry' });
            continue;
        }
        let bytes;
        try {
            const path = join(root, item.name);
            if (await realpath(path) !== path || dirname(path) !== root) throw new Error('UNSAFE_FOLDER_ENTRY');
            bytes = await readBounded(path);
        } catch {
            evidence.push({ file: item.name, result: 'unreadable' });
            continue;
        }
        try {
            const physicalName = 'records/' + item.name;
            const name = recordName.test(physicalName) ? physicalName : `records/${decode(bytes).id}.${hash(bytes)}.json`;
            const record = verifyRecord(pin, name, bytes, profile);
            const existing = accepted.get(name);
            if (existing && !existing.bytes.equals(bytes)) throw new Error('FOLDER_RECORD_CONTENT_MISMATCH');
            accepted.set(name, existing ?? { name, bytes });
            const firstName = identityNames.get(record.id);
            if (!firstName) identityNames.set(record.id, name);
            let result = existing ? 'duplicate' : 'accepted';
            if (firstName && firstName !== name) result = 'identity-conflict';
            evidence.push({ file: item.name, result, name });
        } catch {
            evidence.push({ file: item.name, result: 'unresolved-record' });
        }
    }
    return { artifacts: [...accepted.values()], evidence,
        unresolved: evidence.some(item => item.result !== 'accepted' && item.result !== 'duplicate') };
}
