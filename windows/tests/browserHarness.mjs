import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 仅加载测试夹具和临时浏览器配置；不连接 Tauri 或用户数据目录。
export async function browserHarness(bootstrap) {
    const root = resolve(import.meta.dirname, '../src');
    const profile = await mkdtemp(join(tmpdir(), 'todo-editor-test-'));
    const server = createServer(async (req, res) => {
        try {
            const name = new URL(req.url, 'http://localhost').pathname;
            if (name === '/tauri-mock.js') {
                res.setHeader('Content-Type', 'text/javascript'); res.end(bootstrap); return;
            }
            const path = resolve(root, '.' + (name === '/' ? '/index.html' : name));
            if (!path.startsWith(root + sep)) throw new Error('路径越界');
            res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[extname(path)] || 'text/plain');
            const contents = await readFile(path);
            res.end(extname(path) === '.html' ? contents.toString().replace(/<link[^>]+https:\/\/fonts\.[^>]+>/g, '') : contents);
        } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const executable = process.env.TODO_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket, sequence = 0; const pending = new Map();
    const close = async () => {
        socket?.close(); child.kill(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
    };
    try {
        let port;
        for (let i = 0; i < 200; i++) {
            try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
        }
        if (!port) throw new Error('浏览器启动超时，请设置 TODO_TEST_BROWSER');
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        socket.onmessage = event => {
            const result = JSON.parse(event.data), waiter = pending.get(result.id);
            if (waiter) { pending.delete(result.id); clearTimeout(waiter.timer); result.error ? waiter.reject(result.error) : waiter.resolve(result.result); }
        };
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 30000);
            pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
        });
        const evaluate = async expression => {
            const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
            return result.result.value;
        };
        await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
        const navigation = await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
        if (navigation.errorText) throw new Error(navigation.errorText);
        return { evaluate, close, send };
    } catch (error) { await close(); throw error; }
}

export async function waitFor(browser, expression, attempts = 200) {
    for (let i = 0; i < attempts; i++) { if (await browser.evaluate(expression)) return; await delay(25); }
    throw new Error('等待界面超时：' + expression);
}
