import { replayPersonalRecords } from './recordReplay.js';

// 仅在原生层验证了固定数据集与依赖闭包后生成候选视图。
export async function previewRecordRecovery(invoke, request) {
    return projectPreview(await invoke('preview_record_recovery', { request }));
}

export async function inspectRecordRecoveryFile(invoke, text) {
    const { pin, descriptor, baseline, backup, received } = JSON.parse(text);
    // 文件只提供恢复材料。当前日志始终由原生层按 pin 从磁盘读取。
    const binding = { pin, descriptor, baseline };
    const current = await openRecordJournal(invoke, binding);
    if (current.journal.fault || (!backup && !received?.length)) return { pin, ...current };
    const { preview } = await invoke('prepare_record_recovery_commit', { request: { ...binding, backup, received } });
    return { pin, ...projectPreview(preview), hasLocalEvidence: Boolean(current.journal.resolved_faults?.length) };
}

export async function saveRecordRecovery(invoke, input) {
    return (await persist(invoke, input)).result;
}

export async function openRecordJournal(invoke, { pin, descriptor, baseline }) {
    const { preview, receipt } = await invoke('prepare_record_recovery_commit', {
        request: { pin, descriptor, baseline }
    });
    return { ...projectPreview(preview), revision: receipt.previous_sha256 };
}

export async function submitLocalRecord(invoke, { pin, descriptor, baseline }, intent) {
    const { result, preview, receipt } = await persist(invoke, { pin, descriptor, baseline, intent });
    return { ...result, revision: receipt.candidate_sha256, artifact: preview.submitted };
}

export async function recheckRecordFault(invoke, binding, transport) {
    const { pin, descriptor, baseline } = structuredClone(binding);
    if (transport.namespace !== pin.namespace) throw new Error('RECORD_TRANSPORT_TARGET_MISMATCH');
    const target = { pin, descriptor, baseline };
    const state = await openRecordJournal(invoke, target);
    const fault = state.journal.fault;
    if (!fault) throw new Error('RECORD_FAULT_NOT_FOUND');
    if (fault.code !== 'RECORD_REMOTE_BYTES_CHANGED') throw new Error('RECORD_FAULT_REQUIRES_REVIEW');
    const name = fault.observed.name;
    const content = await transport.read(name);
    if (content === null) throw new Error('RECORD_REPAIR_OBJECT_MISSING');
    return saveRecordRecovery(invoke, { ...target, repair: {
        observed_sha256: state.revision, restored: { name, content }
    } });
}

async function persist(invoke, input) {
    const request = structuredClone(input);
    const { preview, receipt } = await invoke('prepare_record_recovery_commit', { request });
    const result = projectPreview(preview);
    await invoke('commit_record_recovery', { request, receipt });
    return { result, preview, receipt };
}

function projectPreview({ operation_set, baseline, journal, dependencies, records }) {
    return {
        journal,
        missing: dependencies.missing,
        view: records === null ? null : replayPersonalRecords(JSON.parse(baseline).data, records.map(record => JSON.parse(record)), operation_set)
    };
}
