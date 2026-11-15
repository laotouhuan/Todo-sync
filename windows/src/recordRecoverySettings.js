import { inspectRecordRecoveryFile, recheckRecordFault } from './recordRecovery.js';
import { createRecordWebDavTransport } from './recordWebDav.js';

const recoveryFileLimit = 32 * 1024 * 1024;

export function bindRecordRecoverySettings(document, invoke, getConfig) {
    const picker = document.getElementById('record-recovery-file');
    const status = document.getElementById('record-recovery-status');
    const exportButton = document.getElementById('record-recovery-export');
    const recheckButton = document.getElementById('record-recovery-recheck');
    if (!picker || !status || !exportButton || !recheckButton) return;
    let selection = 0, result, binding;
    picker.addEventListener('change', async () => {
        const selected = ++selection;
        const file = picker.files?.[0];
        picker.value = '';
        result = null;
        exportButton.hidden = true;
        recheckButton.hidden = true;
        if (!file) return;
        status.textContent = '正在核对恢复材料…';
        try {
            if (file.size > recoveryFileLimit) throw new Error('恢复材料超过 32 MiB');
            const text = await file.text();
            const preview = await inspectRecordRecoveryFile(invoke, text);
            if (selected !== selection) return;
            const { descriptor, baseline } = JSON.parse(text);
            binding = { pin: preview.pin, descriptor, baseline };
            result = preview;
            const { journal, missing, view } = preview;
            const details = `已知记录 ${journal.records.length} 条，待上传 ${journal.pending.length} 条`;
            status.textContent = journal.fault ? `${details}。同步已暂停（${journal.fault.code}）` :
                missing.length ? `${details}。缺少 ${missing.length} 条父记录` : `${details}。可恢复任务 ${view.todos.filter(todo => !todo.deleted).length} 条`;
            exportButton.hidden = !(preview.hasLocalEvidence ?? Boolean(journal.fault || journal.resolved_faults?.length));
            recheckButton.hidden = preview.hasLocalEvidence !== undefined ||
                journal.fault?.code !== 'RECORD_REMOTE_BYTES_CHANGED' || getConfig()?.sync_mode !== 'webdav';
        } catch {
            if (selected === selection) status.textContent = '无法预览恢复材料，请核对文件、数据集和本机日志。';
        }
    });
    exportButton.addEventListener('click', async () => {
        if (!result || exportButton.disabled) return;
        const selected = selection;
        exportButton.disabled = true;
        try {
            if (await invoke('export_record_fault_evidence', { pin: result.pin }) && selected === selection) {
                status.textContent += '。已导出本机故障证据';
            }
        } catch {
            if (selected === selection) status.textContent += '。无法导出本机故障证据';
        } finally {
            exportButton.disabled = false;
        }
    });
    recheckButton.addEventListener('click', async () => {
        if (!result || recheckButton.disabled) return;
        const selected = selection;
        const config = getConfig();
        if (config?.sync_mode !== 'webdav') {
            status.textContent = '请先保存 WebDAV 连接设置。';
            return;
        }
        recheckButton.disabled = true;
        try {
            const directory = (config.webdav_filepath || '我的坚果云/to-do/todo_data.json').split('/').slice(0, -1);
            const transport = createRecordWebDavTransport(invoke, {
                pin: binding.pin, directory, endpoint: config.webdav_url || 'https://dav.jianguoyun.com/dav/',
                username: config.webdav_username, password: config.webdav_password
            });
            await recheckRecordFault(invoke, binding, transport);
            if (selected !== selection) return;
            recheckButton.hidden = true;
            status.textContent = '远端对象复核通过，已解除该数据集的暂停。';
        } catch {
            if (selected === selection) status.textContent = '远端对象未通过复核，该数据集仍暂停。';
        } finally {
            recheckButton.disabled = false;
        }
    });
}
