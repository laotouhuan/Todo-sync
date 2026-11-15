import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransport } from '../transport.mjs';
import { runScenario, runProcessCrashScenarios, createScratch, removeScratch } from '../scenarios.mjs';

test('统一数据集经过漏项、读取失败、并发及冷恢复完整收敛', async () => {
    const directory = await createScratch();
    try {
        const report = await runScenario({ transport: createMemoryTransport(), directory });
        assert.equal(report.outcome, 'passed');
        assert.equal(report.recordCount, 5);
        assert.ok(report.checks.every(item => item.passed));
    } finally { await removeScratch(directory); }
});

test('上传前及已上传未确认时真实子进程退出，重启不生成新记录', async () => {
    const directory = await createScratch();
    try {
        const checks = await runProcessCrashScenarios(directory);
        assert.equal(checks.length, 2);
        assert.ok(checks.every(item => item.passed));
    } finally { await removeScratch(directory); }
});
