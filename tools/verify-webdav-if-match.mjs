import { randomUUID } from 'node:crypto';

const successful = status => status != null && status >= 200 && status < 300;
const strong = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const kind = value => value == null ? 'missing' : strong(value) ? 'strong' : /^W\/"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? 'weak' : 'invalid';

function isolatedDirectory(endpoint, directory) {
    const base = new URL(endpoint);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
        throw new Error('须提供无凭据及查询参数、以 / 结尾的 HTTPS endpoint');
    }
    const parts = typeof directory === 'string' ? directory.split('/').filter(Boolean) : [];
    if (!directory || directory.startsWith('/') || directory.includes('\\') ||
        parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)) || parts.at(-1) !== 'codex-webdav-preflight') {
        throw new Error('须指定末级为 codex-webdav-preflight 的相对隔离目录');
    }
    return new URL(`${parts.join('/')}/`, base);
}

class ScenarioStop extends Error {
    constructor(outcome) { super('SCENARIO_STOP'); this.outcome = outcome; }
}

/** 各项使用独立随机文件；报告不含实际正文、凭据或 ETag。 */
export async function verifyIfMatch({ endpoint, directory, username, password,
    fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof username !== 'string' || !username || username.includes(':') || typeof password !== 'string' || !password) {
        throw new Error('须提供有效的 WebDAV 凭据');
    }
    const parent = isolatedDirectory(endpoint, directory);
    const token = randomUUID();
    const resources = [];
    const report = { testedAt: new Date().toISOString(), service: parent.origin, targetPath: parent.pathname,
        outcome: 'inconclusive', capabilities: {}, checks: [], cleanup: { removed: false, resources: [] } };
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    const record = (name, status, outcome, details = {}) => report.checks.push({ name, status, outcome, ...details });
    async function request(resource, method, body, conditions = {}) {
        try {
            const response = await fetchImpl(resource.url.href, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { Authorization: authorization, 'Cache-Control': 'no-cache', ...conditions,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
                ...(body === undefined ? {} : { body }) });
            return { status: response.status, etag: response.headers.get('etag'),
                text: method === 'GET' && successful(response.status) ? await response.text() : null };
        } catch {
            // 网络异常可能包含请求信息，不将底层错误写入结果。
            return { status: null, etag: null, text: null };
        }
    }
    function resourceFor(scenario) {
        const resource = { scenario, url: new URL(`if-match-${randomUUID()}.json`, parent), attempted: false,
            body: revision => JSON.stringify({ probe: token, scenario, revision }) };
        resources.push(resource);
        return resource;
    }
    function bodyOutcome(response, matches) {
        if (response.status === 404) return 'unsupported';
        if (!successful(response.status)) return 'inconclusive';
        return matches ? 'passed' : 'unsupported';
    }
    async function prepare(scenario) {
        const resource = resourceFor(scenario);
        const absent = await request(resource, 'GET');
        record(`${scenario}:initial-absence`, absent.status, absent.status === 404 ? 'passed' : 'inconclusive');
        if (absent.status !== 404) throw new ScenarioStop('inconclusive');
        resource.attempted = true;
        const created = await request(resource, 'PUT', resource.body('before'), { 'If-None-Match': '*' });
        const baseline = await request(resource, 'GET');
        const matches = baseline.status === 200 && baseline.text === resource.body('before');
        const outcome = successful(created.status) ? bodyOutcome(baseline, matches) : 'inconclusive';
        record(`${scenario}:prepare`, created.status, outcome, { readStatus: baseline.status, bodyMatches: matches });
        if (outcome !== 'passed') throw new ScenarioStop(outcome);
        return { resource, baseline };
    }
    function requireStrong(scenario, baseline) {
        if (strong(baseline.etag)) return;
        record(`${scenario}:usable-etag`, baseline.status, 'not-executed', { etagKind: kind(baseline.etag),
            etagLength: baseline.etag?.length ?? 0, reason: 'no-legal-strong-etag' });
        throw new ScenarioStop('not-executed');
    }
    async function writeAndRead(resource, name, revision, conditions, expectedRevision, expectRejection = false) {
        const result = await request(resource, 'PUT', resource.body(revision), conditions);
        const final = await request(resource, 'GET');
        const bodyMatches = final.status === 200 && final.text === resource.body(expectedRevision);
        let outcome;
        if (final.status !== 200) outcome = final.status === 404 ? 'unsupported' : 'inconclusive';
        else if (result.status == null) outcome = expectRejection && !bodyMatches ? 'unsupported' : 'inconclusive';
        else if (!bodyMatches) outcome = 'unsupported';
        else if (expectRejection) outcome = result.status === 412 ? 'passed' : successful(result.status) ? 'unsupported' : 'inconclusive';
        else outcome = successful(result.status) ? 'passed' : 'inconclusive';
        record(name, result.status, outcome, { readStatus: final.status, bodyMatches,
            bodyMatchesBefore: final.status === 200 && final.text === resource.body('before') });
        return { outcome, final };
    }
    async function run(name, action) {
        try { report.capabilities[name] = await action(); }
        catch (error) {
            const outcome = error instanceof ScenarioStop ? error.outcome : 'inconclusive';
            report.capabilities[name] = outcome;
            if (!(error instanceof ScenarioStop)) record(`${name}:request-error`, null, outcome);
        }
    }
    await run('etag', async () => {
        const { resource, baseline } = await prepare('etag');
        const again = await request(resource, 'GET');
        const unchanged = again.status === 200 && again.text === resource.body('before');
        const stable = baseline.etag != null && baseline.etag === again.etag;
        const outcome = again.status !== 200 ? 'inconclusive' :
            unchanged && strong(baseline.etag) && strong(again.etag) && stable ? 'passed' : 'unsupported';
        const raw = baseline.etag;
        record('etag:raw-format-and-stability', again.status, outcome, { etagKind: kind(baseline.etag),
            etagLength: baseline.etag?.length ?? 0, stable, bodyMatches: unchanged,
            quoted: typeof raw === 'string' && raw.startsWith('"') && raw.endsWith('"'),
            weakPrefix: typeof raw === 'string' && raw.startsWith('W/'),
            hexOnly: typeof raw === 'string' && /^[0-9a-f]+$/i.test(raw),
            hasWhitespace: typeof raw === 'string' && /\s/.test(raw),
            ASCIIOnly: typeof raw === 'string' && /^[\x00-\x7f]*$/.test(raw) });
        return outcome;
    });
    await run('correctUpdate', async () => {
        const { resource, baseline } = await prepare('correctUpdate');
        requireStrong('correctUpdate', baseline);
        return (await writeAndRead(resource, 'correctUpdate:matching-etag', 'after', { 'If-Match': baseline.etag }, 'after')).outcome;
    });
    await run('wrongETag', async () => {
        const { resource } = await prepare('wrongETag');
        return (await writeAndRead(resource, 'wrongETag:random-legal-tag', 'must-not-write',
            { 'If-Match': `"codex-no-match-${randomUUID()}"` }, 'before', true)).outcome;
    });
    await run('staleETag', async () => {
        const { resource, baseline } = await prepare('staleETag');
        requireStrong('staleETag', baseline);
        const first = await writeAndRead(resource, 'staleETag:advance-revision', 'after', { 'If-Match': baseline.etag }, 'after');
        if (first.outcome !== 'passed') return first.outcome;
        if (!strong(first.final.etag) || baseline.etag === first.final.etag) {
            record('staleETag:changed-strong-etag', first.final.status, 'unsupported', {
                etagKind: kind(first.final.etag), etagLength: first.final.etag?.length ?? 0, changed: baseline.etag !== first.final.etag });
            return 'unsupported';
        }
        return (await writeAndRead(resource, 'staleETag:old-tag-refused', 'must-not-write',
            { 'If-Match': baseline.etag }, 'after', true)).outcome;
    });
    async function race(scenario, creating) {
        let resource;
        let baseline;
        if (creating) resource = resourceFor(scenario);
        else ({ resource, baseline } = await prepare(scenario));
        if (!creating) requireStrong(scenario, baseline);
        const reads = await Promise.all([request(resource, 'GET'), request(resource, 'GET')]);
        const sameBaseline = creating ? reads.every(response => response.status === 404) :
            reads.every(response => response.status === 200 && response.text === resource.body('before') && response.etag === baseline.etag);
        record(`${scenario}:clients-read-same-baseline`, reads[0].status, sameBaseline ? 'passed' : 'inconclusive', {
            secondReadStatus: reads[1].status, bothMissing: creating ? sameBaseline : undefined,
            sameETag: creating ? undefined : sameBaseline });
        if (!sameBaseline) return 'inconclusive';
        resource.attempted = true;
        const conditions = creating ? { 'If-None-Match': '*' } : { 'If-Match': baseline.etag };
        const writes = await Promise.all([
            request(resource, 'PUT', resource.body('client-a'), conditions),
            request(resource, 'PUT', resource.body('client-b'), conditions)
        ]);
        const final = await request(resource, 'GET');
        const winners = writes.map((response, index) => successful(response.status) ? index : -1).filter(index => index !== -1);
        const exactlyOneWinner = winners.length === 1;
        const matchesFirst = final.status === 200 && final.text === resource.body('client-a');
        const matchesSecond = final.status === 200 && final.text === resource.body('client-b');
        const matchesWinner = exactlyOneWinner && (winners[0] === 0 ? matchesFirst : matchesSecond);
        let outcome;
        if (winners.length === 2) outcome = 'unsupported';
        else if (final.status === 404 && winners.length > 0) outcome = 'unsupported';
        else if (writes.some(response => response.status == null) || final.status !== 200) outcome = 'inconclusive';
        else if (exactlyOneWinner && !matchesWinner) outcome = 'unsupported';
        else if (exactlyOneWinner && writes[1 - winners[0]].status === 412) outcome = 'passed';
        else outcome = 'inconclusive';
        record(`${scenario}:conditional-race`, writes[0].status, outcome, { secondWriteStatus: writes[1].status,
            readStatus: final.status, exactlyOneWinner, matchesFirst, matchesSecond, matchesWinner });
        return outcome;
    }
    await run('concurrentUpdate', () => race('concurrentUpdate', false));
    await run('concurrentCreate', () => race('concurrentCreate', true));

    for (const resource of resources) {
        const cleanup = { path: resource.url.pathname, removed: !resource.attempted };
        if (resource.attempted) {
            const current = await request(resource, 'GET');
            cleanup.readStatus = current.status;
            if (current.status === 404) cleanup.removed = true;
            else {
                let owned = false;
                try { owned = current.status === 200 && JSON.parse(current.text).probe === token; } catch { /* 不删除归属未知内容。 */ }
                if (owned) {
                    const removed = await request(resource, 'DELETE', undefined, { 'If-Match': strong(current.etag) ? current.etag : '*' });
                    cleanup.status = removed.status;
                    const absent = await request(resource, 'GET');
                    cleanup.verificationStatus = absent.status;
                    cleanup.removed = (successful(removed.status) || removed.status === 404) && absent.status === 404;
                }
            }
        }
        report.cleanup.resources.push(cleanup);
    }
    report.cleanup.removed = report.cleanup.resources.every(resource => resource.removed);
    const outcomes = Object.values(report.capabilities);
    report.outcome = outcomes.includes('unsupported') ? 'unsupported' : outcomes.every(outcome => outcome === 'passed') ? 'passed' : 'inconclusive';
    return report;
}
