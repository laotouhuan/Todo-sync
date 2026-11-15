import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runConfiguredPreflight } from '../run-configured-webdav-preflight.mjs';
import { canonical } from './protocol.mjs';
import { createWebDavTransport } from './transport.mjs';
import { runScenario, createScratch, removeScratch, snapshot } from './scenarios.mjs';

/** 只上传统一测试数据集；删除是验证完成后的隔离资源拆除，不是协议GC。 */
export async function verifyRecordSyncPrototype(options) {
    const expected = new Map();
    const requests = [];
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const traced = async (url, request) => {
        const response = await fetchImpl(url, request);
        requests.push({ method: request.method, status: response.status });
        return response;
    };
    const transport = createWebDavTransport({ ...options, fetchImpl: traced });
    const directory = await createScratch();
    const report = { testedAt: new Date().toISOString(), service: new URL(options.endpoint).origin,
        targetPath: new URL(options.directory + '/', options.endpoint).pathname,
        outcome: 'inconclusive', dataset_id: snapshot.dataset_id, checks: [],
        cleanup: { removed: false, resources: [] },
        limitations: ['preprovisioned-snapshot-only', 'formal-migration-not-tested', 'legacy-writers-not-supported',
            'local-folder-mode-not-tested', 'no-log-gc-or-compaction', 'global-directory-completeness-not-assumed'] };
    try {
        const scenario = await runScenario({ transport, directory, mode: 'webdav-isolated',
            onRecord: record => expected.set(record.id, record), onCheck: check => report.checks.push(check) });
        Object.assign(report, { outcome: scenario.outcome, checks: scenario.checks, scenario,
            faultInjection: 'client-side-response-discard-and-delayed-discovery-over-real-http' });
    } catch (error) {
        report.checks.push({ name: 'scenario-completed', passed: false, outcome: 'inconclusive',
            ...(error.code === 'ERR_ASSERTION' && /^[a-z][a-z0-9-]*$/.test(error.message) ? { failedCheck: error.message } : {}) });
    } finally {
        const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
        for (const [id, record] of expected) {
            const url = new URL(`${options.directory}/${id}.json`, options.endpoint);
            const item = { path: url.pathname, removed: false };
            try {
                const current = await transport.read(id);
                if (current === null) { item.removed = true; item.verificationStatus = 404; }
                else if (canonical(current) === canonical(record)) {
                    const removed = await traced(url.href, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(15000),
                        headers: { Authorization: authorization, 'If-Match': '*' } });
                    item.status = removed.status;
                    await removed.body?.cancel();
                    const verification = await traced(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
                        headers: { Authorization: authorization, 'Cache-Control': 'no-cache' } });
                    item.verificationStatus = verification.status;
                    await verification.body?.cancel();
                    item.removed = (removed.status >= 200 && removed.status < 300 || removed.status === 404) && verification.status === 404;
                } else item.reason = 'record-ownership-or-content-not-confirmed';
            } catch { item.reason = 'cleanup-not-confirmed'; }
            report.cleanup.resources.push(item);
        }
        report.cleanup.removed = report.cleanup.resources.every(item => item.removed);
        report.requests = requests;
        await removeScratch(directory);
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv[2] !== '--execute' || !process.argv[3]) {
        console.log('用法：node tools/record-sync-prototype/run-live.mjs --execute 尚不存在的报告路径.json');
    } else {
        try {
            const report = await runConfiguredPreflight({ verify: verifyRecordSyncPrototype, reportPath: process.argv[3] });
            console.log(JSON.stringify({ outcome: report.outcome, dataset_id: report.dataset_id,
                recordCount: report.scenario?.recordCount, checkCount: report.checks.length,
                snapshot_hash: report.scenario?.snapshot_hash, projectionHash: report.scenario?.projectionHash,
                cleanup: report.cleanup, collectionCleanup: report.collectionCleanup }, null, 2));
            process.exitCode = report.outcome === 'passed' && report.cleanup.removed && report.collectionCleanup.every(item => item.removed) ? 0 : 1;
        } catch {
            console.error('原型未完成：配置、连接或报告不可用；未输出凭据或底层错误正文。');
            process.exitCode = 1;
        }
    }
}
