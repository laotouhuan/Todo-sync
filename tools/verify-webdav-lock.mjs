import { randomUUID } from 'node:crypto';

export const LOCK_CAPABILITY_NAMES = [
    'lockMetadata', 'exclusiveLock', 'secondClientExcluded', 'unqualifiedWriteRejected', 'invalidTokenWriteRejected',
    'tokenWrite', 'refresh', 'invalidUnlockRejected', 'unlock', 'oldTokenRejected',
    'finiteExpiry', 'expiredTokenRejected', 'reacquireMerge', 'lockNullCreation', 'serialCollaborationMerge', 'responseRecovery'
];
const success = status => status >= 200 && status < 300;
const refusal = status => status === 412 || status === 423;
const tokenValue = value => {
    const token = value?.trim().replace(/^<|>$/g, '');
    return token && /^[a-z][a-z0-9+.-]*:[^\s<>()]+$/i.test(token) ? token : null;
};
const tagText = (xml, name) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)<\\/(?:[\\w.-]+:)?${name}>`, 'i').exec(xml)?.[1];
const lockBlocks = xml => [...xml.matchAll(/<(?:[\w.-]+:)?activelock\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?activelock>/gi)].map(match => match[1]);
function lockDetails(response) {
    const block = lockBlocks(response.text)[0] || response.text;
    const tokenBlock = /<(?:[\w.-]+:)?locktoken\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?locktoken>/i.exec(block)?.[1] || '';
    const bodyToken = tokenValue(tagText(tokenBlock, 'href'));
    const headerToken = tokenValue(response.headers?.get('lock-token'));
    return { token: headerToken || bodyToken, tokenConsistent: !headerToken || headerToken === bodyToken,
        exclusive: /<(?:[\w.-]+:)?exclusive\s*\/?\s*>/i.test(block),
        write: /<(?:[\w.-]+:)?write\s*\/?\s*>/i.test(block), depth: tagText(block, 'depth'), owner: tagText(block, 'owner'),
        timeout: response.headers?.get('timeout') || tagText(block, 'timeout') || null };
}

/** 探测只使用本次随机资源；令牌、正文、原始响应和认证信息不进入报告。 */
export async function verifyExclusiveLock({ endpoint, directory, username, password, fetchImpl = globalThis.fetch,
    sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)), nowImpl = Date.now,
    maxExpiryWaitMs = 20000, timeoutMs = 15000 } = {}) {
    const base = new URL(endpoint);
    const parts = typeof directory === 'string' ? directory.split('/') : [];
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') ||
        !parts.length || parts.at(-1) !== 'codex-webdav-preflight' || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) ||
        typeof username !== 'string' || !username || username.includes(':') || typeof password !== 'string' || !password ||
        typeof fetchImpl !== 'function' || typeof sleepImpl !== 'function' || typeof nowImpl !== 'function' || !Number.isFinite(maxExpiryWaitMs) ||
        maxExpiryWaitMs < 0 || maxExpiryWaitMs > 60000) throw new Error('INVALID_LOCK_PREFLIGHT_OPTIONS');
    const probe = randomUUID();
    const target = new URL(`${parts.join('/')}/lock-${probe}.json`, base);
    const createTarget = new URL(`${parts.join('/')}/lock-create-${probe}.json`, base);
    const report = { testedAt: new Date().toISOString(), service: target.origin, targetPath: target.pathname,
        outcome: 'inconclusive', capabilities: Object.fromEntries(LOCK_CAPABILITY_NAMES.map(name => [name, 'not-executed'])),
        checks: [], cleanup: { removed: false, resources: [] } };
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const states = [target, createTarget].map(url => ({ url, tokens: new Set(), owners: new Set(), leases: new Map(), currentToken: null, owned: false,
        ownedEmpty: false, wasAbsent: false, attempted: false, expected: null, unconfirmedAcquire: false, directUnlocksSafe: true }));
    const content = revision => JSON.stringify({ probe, revision, tasks: [] });
    const lockBody = owner => `<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner>${owner}</d:owner></d:lockinfo>`;
    async function request(state, method, body, headers = {}, injection = null) {
        if (injection === 'not-sent') return { status: null, headers: null, text: '', injection };
        try {
            const response = await fetchImpl(state.url.href, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { Authorization: authorization, 'Cache-Control': 'no-cache', ...headers,
                    ...(body === undefined ? {} : { 'Content-Type': method === 'LOCK' || method === 'PROPFIND' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8' }) },
                ...(body === undefined ? {} : { body }) });
            const text = await response.text();
            if (injection === 'response-discarded') return { status: null, headers: null, text: '', injection, observedStatus: response.status };
            return { status: response.status, headers: response.headers, text };
        } catch { return { status: null, headers: null, text: '' }; }
    }
    function must(name, response, passed, capability, details = {}) {
        report.checks.push({ name, status: response.status, passed, outcome: passed ? 'passed' :
            response.status == null || response.status === 401 || response.status === 403 || response.status >= 500 && response.status !== 501 ? 'inconclusive' : 'unsupported',
            ...(response.injection ? { injection: response.injection } : {}),
            ...(response.observedStatus === undefined ? {} : { observedStatus: response.observedStatus }), ...details });
        if (!passed) {
            report.capabilities[capability] = response.status == null || response.status === 401 || response.status === 403 || response.status >= 500 && response.status !== 501
                ? 'inconclusive' : 'unsupported';
            throw new Error('LOCK_CHECK_STOPPED');
        }
    }
    const mark = capability => { report.capabilities[capability] = 'passed'; };
    function rememberLease(state, token, timeout, startedAt, response) {
        const seconds = /^Second-(\d+)$/i.exec(timeout || '')?.[1];
        const acceptedTimeoutSeconds = seconds === undefined ? null : Number(seconds);
        const deadline = seconds !== undefined ? startedAt + acceptedTimeoutSeconds * 1000 : /^Infinite$/i.test(timeout || '') ? Infinity : null;
        state.leases.set(token, { deadline, acceptedTimeoutSeconds });
        report.checks.push({ name: 'accepted-lock-timeout', status: response.status, passed: deadline !== null,
            outcome: deadline === null ? 'inconclusive' : 'passed', acceptedTimeoutSeconds,
            ...(response.observedStatus === undefined ? {} : { observedStatus: response.observedStatus }) });
    }
    function requireLease(state, token, name, capability) {
        const lease = state.leases.get(token);
        const live = lease?.deadline != null && nowImpl() < lease.deadline;
        must(`${name}-within-accepted-lock-lifetime`, { status: null }, live, capability,
            { acceptedTimeoutSeconds: lease?.acceptedTimeoutSeconds ?? null,
                ...(live ? {} : { reason: lease?.deadline == null ? 'accepted-timeout-unavailable' : 'accepted-lock-lifetime-exhausted' }) });
    }
    async function readExpected(state, expected, name, capability, heldToken = null) {
        if (heldToken) requireLease(state, heldToken, name, capability);
        const read = await request(state, 'GET');
        if (heldToken) requireLease(state, heldToken, `${name}-readback`, capability);
        must(name, read, read.status === 200 && read.text === expected, capability);
        return read;
    }
    async function discovery(state, expectedOwner = null) {
        const response = await request(state, 'PROPFIND', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:lockdiscovery/></d:prop></d:propfind>', { Depth: '0' });
        const completeResponse = [...response.text.matchAll(/<(?:[\w.-]+:)?response\b[^>]*>/gi)].length === 1 &&
            [...response.text.matchAll(/<\/(?:[\w.-]+:)?response\s*>/gi)].length === 1;
        const discoveryProperty = /<(?:[\w.-]+:)?lockdiscovery\b[^>]*\/>/i.test(response.text) ||
            /<(?:[\w.-]+:)?lockdiscovery\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?lockdiscovery\s*>/i.test(response.text);
        const failedProperty = /<(?:[\w.-]+:)?status\b[^>]*>[^<]*\b[45]\d\d\b/i.test(response.text);
        if (response.status !== 207 || /<!DOCTYPE|<!ENTITY/i.test(response.text) || !completeResponse || !discoveryProperty || failedProperty) {
            return { known: false, token: null, hasLocks: true };
        }
        const blocks = lockBlocks(response.text);
        const owned = blocks.find(block => (expectedOwner ? tagText(block, 'owner') === expectedOwner : state.owners.has(tagText(block, 'owner'))) &&
            tagText(block, 'depth') === '0' && /<(?:[\w.-]+:)?exclusive\s*\/?\s*>/i.test(block) && /<(?:[\w.-]+:)?write\s*\/?\s*>/i.test(block));
        const details = owned ? lockDetails({ ...response, text: owned }) : {};
        return { known: true, token: details.token || null, timeout: details.timeout || null, hasLocks: blocks.length > 0 };
    }
    async function acquire(state, injection = null, requestedSeconds = 60) {
        const owner = `urn:uuid:${probe}:lock:${randomUUID()}`;
        state.owners.add(owner);
        const startedAt = nowImpl();
        const response = await request(state, 'LOCK', lockBody(owner), { Depth: '0', Timeout: `Second-${requestedSeconds}` }, injection);
        let details = lockDetails(response);
        if (success(response.status)) {
            const metadataValid = !!details.token && details.tokenConsistent && details.exclusive && details.write && details.depth === '0' && details.owner === owner;
            report.checks.push({ name: 'lock-metadata', status: response.status, passed: metadataValid,
                outcome: metadataValid ? 'passed' : 'unsupported', tokenPresent: !!details.token, tokenConsistent: details.tokenConsistent,
                exclusive: details.exclusive, write: details.write, depth: details.depth === '0' || /^infinity$/i.test(details.depth || '') ? details.depth.toLowerCase() : details.depth == null ? 'missing' : 'other',
                ownerMatches: details.owner === owner });
            if (!metadataValid) report.capabilities.lockMetadata = 'unsupported';
            else if (report.capabilities.lockMetadata === 'not-executed') mark('lockMetadata');
        }
        // 直接响应的合法一致令牌可用于隔离文件的行为诊断；元数据不合规仍单独阻止整条路径通过。
        if (!details.exclusive || !details.write || !details.tokenConsistent) details.token = null;
        if (response.status == null) {
            const found = await discovery(state, owner);
            if (found.token) {
                details = { token: found.token, timeout: found.timeout };
                if (report.capabilities.lockMetadata === 'not-executed') mark('lockMetadata');
                report.checks.push({ name: 'lost-lock-response-recovered-by-owner', status: 207, passed: true, outcome: 'passed',
                    ...(injection ? { injection } : {}), ...(response.observedStatus === undefined ? {} : { observedStatus: response.observedStatus }) });
            }
            if (!found.token && injection !== 'not-sent') state.unconfirmedAcquire = true;
        }
        if (details.token && (success(response.status) || response.status == null)) {
            state.tokens.add(details.token);
            state.currentToken = details.token;
            rememberLease(state, details.token, details.timeout, startedAt, response);
        }
        if (details.token && state.wasAbsent && state.expected === null && (response.status === 201 || response.status == null)) state.ownedEmpty = true;
        return { ...response, ...details, recovered: response.status == null && !!details.token };
    }
    async function put(state, body, token, capability, name, injection = null) {
        if (token) requireLease(state, token, name, capability);
        const response = await request(state, 'PUT', body, token ? { If: `(<${token}>)` } : {}, injection);
        const read = await request(state, 'GET');
        if (token) requireLease(state, token, `${name}-readback`, capability);
        const confirmed = read.status === 200 && read.text === body;
        must(name, response, confirmed && (success(response.status) || response.status == null), capability,
            response.status == null ? { recoveredByReadback: confirmed } : {});
        must(`${name}-readback`, read, confirmed, capability);
        state.expected = body;
        state.owned = JSON.parse(body).probe === probe;
    }
    async function rejectWrite(state, token, capability, name, requireHeld = state.currentToken !== null) {
        const heldToken = state.currentToken;
        if (requireHeld) requireLease(state, heldToken, name, capability);
        const response = await request(state, 'PUT', content('must-not-write'), token ? { If: `(<${token}>)` } : {});
        const read = await request(state, 'GET');
        if (requireHeld) requireLease(state, heldToken, `${name}-readback`, capability);
        must(`${name}-body-unchanged`, read, read.status === 200 && read.text === state.expected, capability);
        must(name, response, refusal(response.status), capability);
        mark(capability);
    }
    async function release(state, token, capability, name, injection = null) {
        if (state.leases.get(token)?.deadline != null) requireLease(state, token, name, capability);
        const response = await request(state, 'UNLOCK', undefined, { 'Lock-Token': `<${token}>` }, injection);
        if (!success(response.status)) state.directUnlocksSafe = false;
        await readExpected(state, state.expected, `${name}-body-unchanged`, capability);
        let confirmed = success(response.status);
        if (response.status == null) {
            const found = await discovery(state);
            confirmed = found.known && !found.hasLocks;
            if (confirmed) requireLease(state, token, `${name}-recovery`, capability);
        }
        must(name, response, confirmed, capability, response.status == null ? { recoveredByDiscovery: confirmed } : {});
        state.tokens.delete(token);
        if (state.currentToken === token) state.currentToken = null;
    }
    async function heldMerge(state, name, task, capability) {
        const lock = await acquire(state);
        if (!success(lock.status) && !lock.recovered) await readExpected(state, state.expected, `${name}-refused-lock-body-unchanged`, capability);
        must(`${name}-acquire`, lock, !!lock.token && (success(lock.status) || lock.recovered), capability);
        const read = await readExpected(state, state.expected, `${name}-reread-under-lock`, capability, lock.token);
        const parsed = JSON.parse(read.text);
        const merged = { ...parsed, tasks: [...parsed.tasks, task] };
        await put(state, JSON.stringify(merged), lock.token, capability, `${name}-merged-write`);
        await release(state, lock.token, capability, `${name}-unlock`);
    }
    const existing = states[0];
    try {
        const absent = await request(existing, 'GET');
        must('existing-test-random-path-absent', absent, absent.status === 404, 'exclusiveLock');
        existing.wasAbsent = true;
        existing.attempted = true;
        await put(existing, content('initial'), null, 'exclusiveLock', 'prepare-existing-test-file');
        const lock = await acquire(existing);
        if (!success(lock.status) && !lock.recovered) await readExpected(existing, existing.expected, 'refused-first-lock-body-unchanged', 'exclusiveLock');
        must('exclusive-lock-existing', lock, !!lock.token && (success(lock.status) || lock.recovered), 'exclusiveLock');
        mark('exclusiveLock');
        requireLease(existing, lock.token, 'second-exclusive-client', 'secondClientExcluded');
        const competing = await acquire(existing);
        await readExpected(existing, existing.expected, 'second-lock-body-unchanged', 'secondClientExcluded', lock.token);
        requireLease(existing, lock.token, 'second-exclusive-client-readback', 'secondClientExcluded');
        must('second-exclusive-client-refused', competing, competing.status === 423, 'secondClientExcluded');
        mark('secondClientExcluded');
        await rejectWrite(existing, null, 'unqualifiedWriteRejected', 'unqualified-write-refused');
        await rejectWrite(existing, `opaquelocktoken:${randomUUID()}`, 'invalidTokenWriteRejected', 'wrong-token-write-refused');
        await put(existing, content('token-write'), lock.token, 'tokenWrite', 'correct-token-write');
        mark('tokenWrite');
        requireLease(existing, lock.token, 'refresh', 'refresh');
        const refreshStartedAt = nowImpl();
        const refreshed = await request(existing, 'LOCK', undefined, { If: `(<${lock.token}>)`, Timeout: 'Second-60' });
        const renewed = lockDetails(refreshed);
        const renewalValid = success(refreshed.status) && renewed.token === lock.token && renewed.tokenConsistent &&
            renewed.exclusive && renewed.write && renewed.depth === '0' && existing.owners.has(renewed.owner);
        if (renewalValid) rememberLease(existing, lock.token, renewed.timeout, refreshStartedAt, refreshed);
        await readExpected(existing, existing.expected, 'refresh-body-unchanged', 'refresh', lock.token);
        must('bodyless-refresh-preserves-token', refreshed, renewalValid, 'refresh');
        requireLease(existing, lock.token, 'refresh-readback', 'refresh');
        mark('refresh');
        requireLease(existing, lock.token, 'wrong-token-unlock', 'invalidUnlockRejected');
        const badUnlock = await request(existing, 'UNLOCK', undefined, { 'Lock-Token': `<opaquelocktoken:${randomUUID()}>` });
        await readExpected(existing, existing.expected, 'wrong-unlock-body-unchanged', 'invalidUnlockRejected');
        requireLease(existing, lock.token, 'wrong-token-unlock-readback', 'invalidUnlockRejected');
        must('wrong-token-unlock-refused', badUnlock, badUnlock.status === 409 || badUnlock.status === 412 || badUnlock.status === 423, 'invalidUnlockRejected');
        await rejectWrite(existing, null, 'invalidUnlockRejected', 'wrong-unlock-keeps-lock');
        await release(existing, lock.token, 'unlock', 'correct-unlock');
        await put(existing, content('after-unlock'), null, 'unlock', 'unqualified-write-after-unlock');
        mark('unlock');
        await rejectWrite(existing, lock.token, 'oldTokenRejected', 'old-token-after-unlock-refused');

        const expiring = await acquire(existing, null, 5);
        if (!success(expiring.status) && !expiring.recovered) await readExpected(existing, existing.expected, 'expiry-lock-refused-body-unchanged', 'finiteExpiry');
        must('expiry-lock-acquired', expiring, !!expiring.token && (success(expiring.status) || expiring.recovered), 'finiteExpiry');
        const seconds = /^Second-(\d+)$/i.exec(expiring.timeout || '')?.[1];
        const deadline = existing.leases.get(expiring.token)?.deadline;
        const waitMs = seconds !== undefined ? Math.max(0, deadline - nowImpl()) + 100 : Infinity;
        if (waitMs <= maxExpiryWaitMs && waitMs <= 60000) {
            report.checks.push({ name: 'finite-expiry-wait', status: expiring.status, passed: true, outcome: 'passed', acceptedTimeoutSeconds: Number(seconds), waitMs });
            await sleepImpl(waitMs);
            try {
                await rejectWrite(existing, expiring.token, 'expiredTokenRejected', 'expired-token-refused', false);
                existing.currentToken = null;
                await put(existing, content('after-expiry'), null, 'finiteExpiry', 'unqualified-write-after-expiry');
            } catch {
                if (report.capabilities.finiteExpiry === 'not-executed') report.capabilities.finiteExpiry = report.capabilities.expiredTokenRejected;
                throw new Error('EXPIRY_CHECK_STOPPED');
            }
            existing.tokens.delete(expiring.token);
            mark('finiteExpiry');
        } else {
            report.checks.push({ name: 'finite-expiry-wait', status: expiring.status, passed: false, execution: 'not-executed',
                outcome: 'not-executed', acceptedTimeoutSeconds: seconds === undefined ? null : Number(seconds), waitMs: Number.isFinite(waitMs) ? waitMs : null,
                reason: seconds ? 'accepted-timeout-exceeds-budget' : 'accepted-timeout-unavailable-or-infinite' });
            await release(existing, expiring.token, 'reacquireMerge', 'release-unwaited-lock');
        }
        await heldMerge(existing, 'reacquired-client', { id: 'reacquired', content: 'synthetic' }, 'reacquireMerge');
        mark('reacquireMerge');
        await heldMerge(existing, 'collaboration-client-a', { id: 'client-a', content: 'synthetic-a' }, 'serialCollaborationMerge');
        await heldMerge(existing, 'collaboration-client-b', { id: 'client-b', content: 'synthetic-b' }, 'serialCollaborationMerge');
        const final = await readExpected(existing, existing.expected, 'serialized-collaboration-final-readback', 'serialCollaborationMerge');
        const ids = JSON.parse(final.text).tasks.map(task => task.id);
        must('serialized-collaboration-retains-both-additions', final, ids.includes('client-a') && ids.includes('client-b'), 'serialCollaborationMerge');
        mark('serialCollaborationMerge');

        // 客户端主动跳过发送或丢弃真实响应，分别验证不确定结果的保守恢复路径。
        const skippedLock = await acquire(existing, 'not-sent');
        await readExpected(existing, existing.expected, 'unsent-lock-body-unchanged', 'responseRecovery');
        must('unsent-lock-not-mistaken-for-acquired', skippedLock, !skippedLock.token, 'responseRecovery');
        const recoveredLock = await acquire(existing, 'response-discarded');
        await readExpected(existing, existing.expected, 'discarded-lock-body-unchanged', 'responseRecovery');
        must('discarded-lock-recovered-for-unique-owner', recoveredLock, recoveredLock.recovered && !!recoveredLock.token, 'responseRecovery');
        requireLease(existing, recoveredLock.token, 'unsent-put', 'responseRecovery');
        const unsentPut = await request(existing, 'PUT', content('unsent-must-not-write'), { If: `(<${recoveredLock.token}>)` }, 'not-sent');
        await readExpected(existing, existing.expected, 'unsent-put-body-unchanged', 'responseRecovery');
        requireLease(existing, recoveredLock.token, 'unsent-put-readback', 'responseRecovery');
        must('unsent-put-not-blindly-retried', unsentPut, unsentPut.status === null, 'responseRecovery');
        const mergedRecovery = JSON.stringify({ ...JSON.parse(existing.expected), revision: 'response-recovery' });
        await put(existing, mergedRecovery, recoveredLock.token, 'responseRecovery', 'discarded-put-confirmed-by-readback', 'response-discarded');
        requireLease(existing, recoveredLock.token, 'unsent-unlock', 'responseRecovery');
        const unsentUnlock = await request(existing, 'UNLOCK', undefined, { 'Lock-Token': `<${recoveredLock.token}>` }, 'not-sent');
        await readExpected(existing, existing.expected, 'unsent-unlock-body-unchanged', 'responseRecovery');
        const stillHeld = await discovery(existing);
        requireLease(existing, recoveredLock.token, 'unsent-unlock-readback', 'responseRecovery');
        must('unsent-unlock-still-held', unsentUnlock, stillHeld.known && stillHeld.token === recoveredLock.token, 'responseRecovery');
        await release(existing, recoveredLock.token, 'responseRecovery', 'discarded-unlock-confirmed-by-discovery', 'response-discarded');
        mark('responseRecovery');
    } catch { /* 单项失败保留状态，独立的首次创建能力继续验证。 */ }

    const first = states[1];
    try {
        const absences = await Promise.all([request(first, 'GET'), request(first, 'GET')]);
        absences.forEach((absent, index) => must(`creation-client-${index ? 'b' : 'a'}-reads-absent`, absent, absent.status === 404, 'lockNullCreation'));
        first.wasAbsent = true;
        first.attempted = true;
        const locks = await Promise.all([acquire(first), acquire(first)]);
        const winners = locks.filter(lock => !!lock.token && (success(lock.status) || lock.recovered));
        const read = await request(first, 'GET');
        const exclusive = winners.length === 1 && locks.filter(lock => lock.status === 423).length === 1;
        must('first-creation-single-exclusive-owner', locks.find(lock => !success(lock.status)) || locks[0], exclusive, 'lockNullCreation',
            { clientAStatus: locks[0].status, clientBStatus: locks[1].status, winnerCount: winners.length,
                finalGetStatus: read.status, finalBodyEmpty: read.text === '' });
        must('first-creation-reread-under-lock', read, (read.status === 200 || read.status === 204) && read.text === '', 'lockNullCreation');
        await put(first, content('unique-initial'), winners[0].token, 'lockNullCreation', 'first-creation-token-write');
        await rejectWrite(first, null, 'lockNullCreation', 'first-creation-loser-unqualified-write-refused');
        await rejectWrite(first, `opaquelocktoken:${randomUUID()}`, 'lockNullCreation', 'first-creation-loser-wrong-token-refused');
        await release(first, winners[0].token, 'lockNullCreation', 'first-creation-unlock');
        mark('lockNullCreation');
    } catch { /* 未取得唯一锁或结果不明时不盲写。 */ }

    for (const state of states) {
        const cleanup = { path: state.url.pathname, removed: false, attempted: state.attempted };
        try {
            const found = await discovery(state);
            if (found.token) state.tokens.add(found.token);
            for (const token of state.tokens) {
                const unlocked = await request(state, 'UNLOCK', undefined, { 'Lock-Token': `<${token}>` });
                if (!success(unlocked.status)) state.directUnlocksSafe = false;
            }
            const read = await request(state, 'GET');
            if (read.status === 404) cleanup.removed = true;
            else if ((read.status === 200 || read.status === 204) &&
                (read.text === '' ? state.ownedEmpty : JSON.parse(read.text).probe === probe)) {
                const unlocked = await discovery(state);
                const ownedJSON = read.text !== '' && JSON.parse(read.text).probe === probe;
                const directlyReleased = ownedJSON && state.directUnlocksSafe && !state.unconfirmedAcquire;
                if (unlocked.known && !unlocked.hasLocks || directlyReleased) {
                    const removed = await request(state, 'DELETE');
                    cleanup.status = removed.status;
                    const verify = await request(state, 'GET');
                    cleanup.verificationStatus = verify.status;
                    cleanup.removed = (success(removed.status) || removed.status === 404) && verify.status === 404;
                }
            }
        } catch { /* 无法确认归属或锁状态时报告残留，不删除其他资源。 */ }
        report.cleanup.resources.push(cleanup);
    }
    report.cleanup.removed = report.cleanup.resources.every(resource => resource.removed);
    for (const [name, status] of Object.entries(report.capabilities)) if (status === 'not-executed') {
        report.checks.push({ name: `${name}-not-executed`, status: null, passed: false, outcome: 'not-executed', reason: 'prerequisite-unavailable-or-accepted-timeout-not-testable' });
    }
    const statuses = Object.values(report.capabilities);
    report.outcome = statuses.includes('unsupported') ? 'unsupported' : statuses.every(status => status === 'passed') ? 'passed' : 'inconclusive';
    return report;
}
