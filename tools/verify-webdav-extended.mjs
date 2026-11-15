export const IF_MATCH_REQUIREMENTS = ['etag', 'correctUpdate', 'wrongETag', 'staleETag', 'concurrentUpdate', 'concurrentCreate'];
export const LOCK_REQUIREMENTS = ['lockMetadata', 'exclusiveLock', 'secondClientExcluded', 'unqualifiedWriteRejected',
    'invalidTokenWriteRejected', 'tokenWrite', 'refresh', 'invalidUnlockRejected', 'unlock', 'oldTokenRejected',
    'finiteExpiry', 'expiredTokenRejected', 'reacquireMerge', 'lockNullCreation', 'serialCollaborationMerge', 'responseRecovery'];

function assessPath(report, requiredCapabilities) {
    const notPassedCapabilities = Object.fromEntries(requiredCapabilities
        .filter(key => report.capabilities?.[key] !== 'passed')
        .map(key => [key, report.capabilities?.[key] || 'not-executed']));
    const unsupported = Object.values(notPassedCapabilities).includes('unsupported') || report.outcome === 'unsupported';
    const outcome = unsupported ? 'unsupported' : report.outcome === 'passed' && !Object.keys(notPassedCapabilities).length ? 'passed' : 'inconclusive';
    return { outcome, requiredCapabilities, notPassedCapabilities };
}

// 各种机制使用独立资源；一种机制失败后仍测试其余机制，不能据此推断未执行项。
export async function verifyWebDavExtended(options = {}) {
    const { verifyIfMatchImpl, verifyLockImpl, ...connection } = options;
    const mechanisms = {};
    for (const [name, supplied, file, exported] of [
        ['ifMatch', verifyIfMatchImpl, './verify-webdav-if-match.mjs', 'verifyIfMatch'],
        ['exclusiveLock', verifyLockImpl, './verify-webdav-lock.mjs', 'verifyExclusiveLock']
    ]) {
        try {
            const verify = supplied || (await import(file))[exported];
            mechanisms[name] = await verify(connection);
        } catch {
            mechanisms[name] = { outcome: 'inconclusive', capabilities: {},
                checks: [{ name: 'mechanism-completed', status: null, outcome: 'inconclusive' }],
                cleanup: { removed: false } };
        }
    }
    // 条件写路径必须同时解决已有文件更新与首次创建；锁路径也须通过完整流程。
    const candidatePaths = {
        conditionalWrites: assessPath(mechanisms.ifMatch, IF_MATCH_REQUIREMENTS),
        exclusiveLock: assessPath(mechanisms.exclusiveLock, LOCK_REQUIREMENTS)
    };
    const outcomes = Object.values(candidatePaths).map(item => item.outcome);
    const outcome = outcomes.includes('passed') ? 'passed' : outcomes.every(value => value === 'unsupported') ? 'unsupported' : 'inconclusive';
    return { testedAt: new Date().toISOString(), service: new URL(connection.endpoint).origin,
        targetPath: new URL(connection.directory.replace(/\/$/, '') + '/', connection.endpoint).pathname,
        outcome, candidatePaths, mechanisms,
        checks: Object.entries(mechanisms).flatMap(([mechanism, report]) => (report.checks || []).map(check => ({ mechanism, ...check }))),
        cleanup: { removed: Object.values(mechanisms).every(report => report.cleanup?.removed === true) } };
}
