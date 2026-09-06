/**
 * 本地开发：一条命令起后端、前端、Electron，退出时一起收掉。
 *
 * **为什么要挑端口**：后端默认 8000，而 8000 是本机最容易被别的项目占掉的端口
 * （任何一个 uvicorn / http.server 默认都是它）。占掉之后症状很隐蔽——前端照样起来，
 * 请求打到那个陌生服务上拿回 404，界面上只显示「Not Found」，通话按 C+A 也只报
 * 「开不了语音会话」，看着像丘丘自己坏了。所以这里先探一下，占了就换下一个，
 * 并且把实际用的端口通过 `QIUQIU_API` 一路传给 Electron，三边对齐。
 *
 * 用法：`pnpm dev`。想钉死端口就 `QIUQIU_PORT=8000 pnpm dev`（占用时直接报错退出）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PORT_FIRST = 5173;
const WEB_PORT_LAST = 5183;
const PORT_FIRST = 8000;
const PORT_LAST = 8020;

/**
 * 端口能不能连上。连得上就说明有人在听。
 *
 * 连 `localhost` 而不是 `127.0.0.1`：vite 默认只听 IPv6 的 `[::1]`，只探 IPv4
 * 会以为端口空着，于是又起一个 vite，它自己挪到 5174，而 Electron 还指着 5173。
 */
function inUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: 'localhost', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(300);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/** 在一段区间里找第一个没人听的端口。 */
async function pickFree(first, last, what) {
  for (let p = first; p <= last; p += 1) {
    if (!(await inUse(p))) return p;
  }
  throw new Error(`${what}：${first}–${last} 全被占着，腾一个出来再跑。`);
}

async function pickPort() {
  const pinned = process.env.QIUQIU_PORT;
  if (pinned) {
    if (await inUse(Number(pinned))) {
      throw new Error(`QIUQIU_PORT=${pinned} 已经被占用。换一个，或者把占着的进程停掉。`);
    }
    return Number(pinned);
  }
  return pickFree(PORT_FIRST, PORT_LAST, '后端');
}

/** 后端解释器：优先仓库里的 .venv，没有就交给 uv。 */
function pythonCmd() {
  const venv = join(ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? [venv, []] : ['uv', ['run', 'python']];
}

const children = [];
function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} 退出（code=${code} signal=${signal}），一起收掉`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** 等一个端口开始应答，超时就报错——Electron 早于前端起来会白屏。 */
async function waitFor(name, port, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await inUse(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${name} 等了 ${timeoutMs / 1000}s 还没起来`);
}

const port = await pickPort();
if (port !== PORT_FIRST) {
  console.log(`[dev] ${PORT_FIRST} 被别的进程占着，后端改用 ${port}`);
}
const apiBase = `http://127.0.0.1:${port}`;

// Electron 跑的是编译产物，先把 TS 编出来；character 是 web 与 desktop 共用的包
console.log('[dev] 构建 character 与 desktop');
await new Promise((resolve, reject) => {
  const b = spawn(
    'pnpm',
    ['--filter', '@qiuqiu/character', '--filter', '@qiuqiu/desktop', 'build'],
    {
      cwd: ROOT,
      stdio: 'inherit'
    }
  );
  b.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`构建失败（code=${c}）`))));
});

const [py, pyArgs] = pythonCmd();
run('api', py, [...pyArgs, '-m', 'qiuqiu_api.main', '--port', String(port), '--reload'], {
  QIUQIU_PORT: String(port)
});
/**
 * 前端也自己挑一个空端口，**不复用别人的**。
 *
 * 复用踩过一次：vite 的 `/api` 反代端口是它启动那一刻定死的，复用一个早就起好的
 * 实例，反代还指着旧后端，浏览器里每个请求都 404，而 Electron 因为走 preload 的
 * `QIUQIU_API` 反倒是好的——两个界面表现不一致，查起来最费时间。
 * 自己起一个，端口和反代必然是一套。
 */
const webPort = await pickFree(WEB_PORT_FIRST, WEB_PORT_LAST, '前端');
if (webPort !== WEB_PORT_FIRST) {
  console.log(`[dev] ${WEB_PORT_FIRST} 被占着，前端改用 ${webPort}`);
}
run('web', 'pnpm', ['--filter', '@qiuqiu/web', 'dev', '--port', String(webPort), '--strictPort'], {
  QIUQIU_API_PORT: String(port)
});

await waitFor('后端', port);
await waitFor('前端', webPort);
console.log(`[dev] 后端 ${apiBase} · 前端 http://localhost:${webPort} · 起 Electron`);
run('electron', 'pnpm', ['--filter', '@qiuqiu/desktop', 'start'], {
  QIUQIU_API: apiBase,
  QIUQIU_DEV_SERVER: `http://localhost:${webPort}`
});
