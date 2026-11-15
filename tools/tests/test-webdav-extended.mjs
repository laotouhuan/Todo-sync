import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebDavExtended, IF_MATCH_REQUIREMENTS, LOCK_REQUIREMENTS } from '../verify-webdav-extended.mjs';

const connection = { endpoint: 'https://example.test/dav/', directory: 'isolated/codex-webdav-preflight' };
const result = (outcome, removed = true) => ({ outcome,
    capabilities: Object.fromEntries([...IF_MATCH_REQUIREMENTS, ...LOCK_REQUIREMENTS].map(key => [key, outcome])),
    checks: [], cleanup: { removed } });

test('空能力集合不能凭子报告自称passed而通过', async () => {
    const report = await verifyWebDavExtended({ ...connection,
        verifyIfMatchImpl: async () => ({ ...result('passed'), capabilities: {} }),
        verifyLockImpl: async () => ({ ...result('passed'), capabilities: {} }) });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.candidatePaths.conditionalWrites.notPassedCapabilities.concurrentCreate, 'not-executed');
    assert.equal(report.candidatePaths.exclusiveLock.notPassedCapabilities.responseRecovery, 'not-executed');
});

test('更新通过但首次创建未执行，仍不能成为完整条件写路径', async () => {
    const conditional = result('passed');
    conditional.capabilities.concurrentCreate = 'not-executed';
    const report = await verifyWebDavExtended({ ...connection,
        verifyIfMatchImpl: async () => conditional, verifyLockImpl: async () => result('unsupported') });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.candidatePaths.conditionalWrites.outcome, 'inconclusive');
});

test('条件写失败仍执行独占锁，完整锁路径通过时可成为候选', async () => {
    const called = [];
    const report = await verifyWebDavExtended({ ...connection,
        verifyIfMatchImpl: async () => { called.push('ifMatch'); return result('unsupported'); },
        verifyLockImpl: async () => { called.push('lock'); return result('passed'); } });
    assert.deepEqual(called, ['ifMatch', 'lock']);
    assert.equal(report.outcome, 'passed');
    assert.equal(report.candidatePaths.conditionalWrites.outcome, 'unsupported');
    assert.equal(report.candidatePaths.exclusiveLock.outcome, 'passed');
});

test('两条路径均有反例时才将整体判为不支持', async () => {
    const report = await verifyWebDavExtended({ ...connection,
        verifyIfMatchImpl: async () => result('unsupported'), verifyLockImpl: async () => result('unsupported') });
    assert.equal(report.outcome, 'unsupported');
});

test('未确认或未执行的路径不能被另一条失败路径替代推断', async () => {
    for (const outcome of ['inconclusive', 'not-executed']) {
        const report = await verifyWebDavExtended({ ...connection,
            verifyIfMatchImpl: async () => result('unsupported'), verifyLockImpl: async () => result(outcome) });
        assert.equal(report.outcome, 'inconclusive');
    }
});

test('单机制异常不终止另一机制，错误正文脱敏且清理不误报', async () => {
    const report = await verifyWebDavExtended({ ...connection,
        verifyIfMatchImpl: async () => { throw new Error('sensitive password and server body'); },
        verifyLockImpl: async () => result('unsupported') });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.cleanup.removed, false);
    assert.ok(!JSON.stringify(report).includes('sensitive'));
});

test('机制检查项保留出处，清理失败不能由其他机制覆盖', async () => {
    const report = await verifyWebDavExtended({ ...connection,
        verifyIfMatchImpl: async () => ({ ...result('passed', false), checks: [{ name: 'body', status: 200, outcome: 'passed' }] }),
        verifyLockImpl: async () => result('unsupported') });
    assert.deepEqual(report.checks, [{ mechanism: 'ifMatch', name: 'body', status: 200, outcome: 'passed' }]);
    assert.equal(report.cleanup.removed, false);
});
