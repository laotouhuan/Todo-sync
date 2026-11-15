const HASH = '[0-9a-f]{64}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RECORD = new RegExp(`^records/${UUID}\\.${HASH}\\.json$`);
const fail = code => { throw new Error(code); };

function xmlText(text) {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) fail('INVALID_DIRECTORY_XML');
    return text.replace(/&([^;]+);/g, (_, entity) => {
        const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (Object.hasOwn(known, entity)) return known[entity];
        const value = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
        if (!Number.isInteger(value) || value < 0x20 && ![9, 10, 13].includes(value) || value > 0x10ffff ||
            value >= 0xd800 && value <= 0xdfff || value >= 0xfdd0 && value <= 0xfdef || (value & 0xffff) >= 0xfffe) fail('INVALID_DIRECTORY_XML');
        return String.fromCodePoint(value);
    });
}

// 保守解析实际需要的 XML 子集；不解析实体定义、处理指令、CDATA 或注释。
export function directoryNames(xml, collection) {
    if (xml.length > 1024 * 1024 || /<!|<\?(?!xml\s)/.test(xml)) fail('INVALID_DIRECTORY_XML');
    for (const char of xml) {
        const value = char.codePointAt(0);
        if (value < 0x20 && ![9, 10, 13].includes(value) || value >= 0xfdd0 && value <= 0xfdef || (value & 0xffff) >= 0xfffe) fail('INVALID_DIRECTORY_XML');
    }
    const input = xml.replace(/^<\?xml\s+[^?]*\?>/, '');
    if (input.includes('<?')) fail('INVALID_DIRECTORY_XML');
    const tokens = input.match(/<[^>]*>|[^<]+/g) || [];
    if (tokens.join('') !== input) fail('INVALID_DIRECTORY_XML');
    const stack = [], nodes = [];
    let root;
    for (const token of tokens) {
        if (!token.startsWith('<')) {
            const text = xmlText(token);
            if (stack.length) stack.at(-1).text += text;
            else if (text.trim()) fail('INVALID_DIRECTORY_XML');
            continue;
        }
        const closing = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token);
        if (closing) {
            if (stack.pop()?.name !== closing[1]) fail('INVALID_DIRECTORY_XML');
            continue;
        }
        const selfClosing = token.endsWith('/>');
        const content = token.slice(1, selfClosing ? -2 : -1);
        const opening = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(content);
        if (!opening) fail('INVALID_DIRECTORY_XML');
        const name = opening[1], attributes = new Map();
        let rest = opening[2];
        while (rest.trim()) {
            const attribute = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^<]*?)\2/.exec(rest);
            if (!attribute || attributes.has(attribute[1])) fail('INVALID_DIRECTORY_XML');
            attributes.set(attribute[1], xmlText(attribute[3]));
            rest = rest.slice(attribute[0].length);
        }
        const parent = stack.at(-1), namespaces = new Map(parent?.namespaces || [['xml', 'http://www.w3.org/XML/1998/namespace']]);
        for (const [key, value] of attributes) {
            if (key === 'xmlns') namespaces.set('', value);
            else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value);
        }
        const pieces = name.split(':');
        if (pieces.length > 2 || pieces.length === 2 && !namespaces.has(pieces[0])) fail('INVALID_DIRECTORY_XML');
        const node = { name, namespace: namespaces.get(pieces.length === 2 ? pieces[0] : '') || '',
            local: pieces.at(-1), namespaces, children: [], text: '', parent };
        if (parent) parent.children.push(node);
        else if (root) fail('INVALID_DIRECTORY_XML');
        else root = node;
        nodes.push(node);
        if (nodes.length > 10000 || stack.length > 64) fail('INVALID_DIRECTORY_XML');
        if (!selfClosing) stack.push(node);
    }
    if (stack.length || !root || root.namespace !== 'DAV:' || root.local !== 'multistatus' || root.text.trim() ||
        root.children.some(node => node.namespace !== 'DAV:' || node.local !== 'response') ||
        nodes.some(node => node.namespace === 'DAV:' && node.local === 'response' && node.parent !== root)) fail('INVALID_DIRECTORY_XML');
    const names = [];
    let selfCount = 0;
    for (const response of root.children) {
        const hrefs = response.children.filter(node => node.namespace === 'DAV:' && node.local === 'href');
        if (hrefs.length !== 1 || hrefs[0].children.length) fail('INVALID_DIRECTORY_XML');
        let url, pathname, prefix;
        try {
            url = new URL(hrefs[0].text.trim(), collection);
            if (url.origin !== collection.origin || url.username || url.password || url.search || url.hash) fail('INVALID_DIRECTORY_PATH');
            pathname = decodeURIComponent(url.pathname); prefix = decodeURIComponent(collection.pathname);
        } catch { fail('INVALID_DIRECTORY_PATH'); }
        if (pathname.replace(/\/$/, '') === prefix.replace(/\/$/, '')) { selfCount++; continue; }
        if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) fail('INVALID_DIRECTORY_PATH');
        const name = 'records/' + pathname.slice(prefix.length);
        if (!RECORD.test(name)) fail('INVALID_DIRECTORY_PATH');
        names.push(name);
    }
    if (selfCount !== 1) fail('INVALID_DIRECTORY_XML');
    return [...new Set(names)].sort();
}
