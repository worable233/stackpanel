#!/usr/bin/env node
/**
 * LB / Caddy 运行时验证（DEPLOY-LB / B9）。
 *
 *   node scripts/verify-lb.mjs
 *
 * 用**真实 `docker/Caddyfile`**（仓库里的产物，不另写一份）起一个 Caddy 容器，
 * 后面接两个假上游（web / api），逐项验证 B9 约定与一处历史缺陷的修复：
 *
 *   [1] 机器面路由    /api/v1/*、/mcp、/sp/v1/*、/llm-gateway/*、/callbacks/*、
 *                     /zjmf_api_login、/cart|/host|/provision、/themes|/plugins
 *                     全部打到 API，且**路径前缀不剥离**（旧 handle_path 会剥成
 *                     /v1/... 直接 404——本脚本是为钉死该回归而生）。
 *   [2] BFF 归 web    /api/notifications、/api/llm-gateway/*、/dashboard、/login
 *                     仍走 web（Next.js），不被机器面抢走。
 *   [3] SSE 逐写刷新  /llm-gateway/* 的 text/event-stream 经 Caddy 后首块须在
 *                     末块之前到达（flush_interval -1，未被 encode/gzip 缓冲）。
 *
 * 前置：本机 docker 可用（Caddy 镜像 `caddy:2-alpine`，可选 `LB_CADDY_IMAGE`）。
 * 无需 PostgreSQL / Redis / 真实 API。自建自销毁临时目录与容器，可重复运行。
 *
 * 无 docker 时**跳过**（退出码 0 并打印中文提示），人工步骤见部署文档 §4.3。
 * 断言失败退出码 1。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CADDY_IMAGE = process.env['LB_CADDY_IMAGE'] ?? 'caddy:2-alpine';
const CONTAINER = `stackpanel-lb-verify-${process.pid}`;

let checks = 0;
let failures = 0;
const ok = (msg) => {
  checks += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
};
const bad = (msg) => {
  checks += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const assert = (condition, label) => (condition ? ok(label) : bad(label));
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假上游：JSON 回显 role/url；`/llm-gateway/*` 走 SSE 逐写。 */
function startUpstream(role, port) {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/llm-gateway')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`data: ${++n}\n\n`);
        if (n >= 3) {
          clearInterval(timer);
          res.end();
        }
      }, 150);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ role, url: req.url }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts });
    let output = '';
    child.stdout?.on('data', (c) => (output += c.toString()));
    child.stderr?.on('data', (c) => (output += c.toString()));
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function dockerAvailable() {
  const info = await run('docker', ['info']);
  return info.code === 0;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return true;
    } catch {
      /* 未就绪 */
    }
    if (Date.now() - start > timeoutMs) return false;
    await sleep(200);
  }
}

// 机器面：路径 -> 期望角色。前缀不剥离由 `url` 原样断言（api 回显 req.url）。
const API_PATHS = [
  '/api/v1/platform',
  '/api/v1/gateway/models',
  '/api/product/list',
  '/mcp',
  '/sp/v1/catalog',
  '/callbacks/epay',
  '/zjmf_api_login',
  '/cart/settle',
  '/host/list',
  '/provision/default',
  '/themes/default/theme.css',
  '/plugins/hello/config',
];
const WEB_PATHS = [
  '/api/notifications',
  '/api/notifications/unread-count',
  '/api/llm-gateway/models',
  '/api/catalog/products/x/categories',
  '/api/store/upstream-products',
  '/dashboard',
  '/login',
];

async function main() {
  console.log('\n\x1b[1mStackPanel LB / Caddy 运行时验证（B9）\x1b[0m');
  if (!(await dockerAvailable())) {
    console.log('  \x1b[33m•\x1b[0m 未检测到 docker，跳过运行时验证（退出码 0）。');
    console.log('    人工步骤见部署文档 §4.3（集群档 LB 约定与验证）。');
    return 0;
  }

  const apiPort = 18201;
  const webPort = 18202;
  const caddyPort = 18280;
  const tmp = await mkdtemp(path.join(ROOT, '.sp-lb-'));
  const caddyfileSrc = await readFile(path.join(ROOT, 'docker', 'Caddyfile'), 'utf8');

  // 真实 Caddyfile 原样使用：只把域名换成端口、上游指向假服务。
  const caddyfilePath = path.join(tmp, 'Caddyfile');
  await writeFile(caddyfilePath, caddyfileSrc, 'utf8');

  let apiServer;
  let webServer;
  try {
    apiServer = await startUpstream('api', apiPort);
    webServer = await startUpstream('web', webPort);

    console.log(
      `  Caddy 镜像 ${CADDY_IMAGE}；假上游 api:${apiPort} web:${webPort}；入口 :${caddyPort}`,
    );
    const up = await run('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      CONTAINER,
      '-p',
      `${caddyPort}:${caddyPort}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-e',
      `STACKPANEL_DOMAIN=:${caddyPort}`,
      '-e',
      'STACKPANEL_EMAIL=verify@example.com',
      '-e',
      `WEB_UPSTREAM=host.docker.internal:${webPort}`,
      '-e',
      `API_UPSTREAM=host.docker.internal:${apiPort}`,
      '-v',
      `${caddyfilePath}:/etc/caddy/Caddyfile:ro`,
      CADDY_IMAGE,
    ]);
    if (up.code !== 0) {
      bad(`Caddy 容器启动失败：${up.output.trim()}`);
      return 1;
    }

    const base = `http://127.0.0.1:${caddyPort}`;
    if (!(await waitForHttp(`${base}/health`, 20_000))) {
      const logs = await run('docker', ['logs', CONTAINER]);
      bad(`Caddy 未在超时内就绪：\n${logs.output}`);
      return 1;
    }

    section('[1] 机器面路由到 API，且前缀不剥离（修复 handle_path 回归）');
    for (const p of API_PATHS) {
      const body = await fetchJson(`${base}${p}`);
      assert(
        body.role === 'api' && body.url === p,
        `${p} -> api（url 原样 ${body.url ?? JSON.stringify(body)}）`,
      );
    }

    section('[2] BFF 路由仍归 web');
    for (const p of WEB_PATHS) {
      const body = await fetchJson(`${base}${p}`);
      assert(body.role === 'web', `${p} -> web`);
    }

    section('[3] SSE 经 Caddy 逐写刷新（未缓冲 / 未压缩）');
    {
      const started = Date.now();
      const res = await fetch(`${base}/llm-gateway/v1/chat`, { method: 'POST' });
      assert(
        res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/event-stream'),
        'SSE 响应 200 + text/event-stream',
      );
      const reader = res.body?.getReader();
      if (!reader) {
        bad('SSE 响应无 body');
      } else {
        const decoder = new TextDecoder();
        const first = await reader.read();
        const firstAt = Date.now() - started;
        const firstText = decoder.decode(first.value);
        assert(firstText.includes('data: 1'), '首块已含 data: 1');
        assert(firstAt < 400, `首块在 400ms 内到达（实测 ${firstAt}ms，证明未被缓冲）`);
        let rest = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          rest += decoder.decode(value);
        }
        assert(rest.includes('data: 3'), '后续事件按序到达（流完整）');
      }
    }
  } finally {
    await run('docker', ['rm', '-f', CONTAINER]);
    await new Promise((resolve) => apiServer?.close(resolve));
    await new Promise((resolve) => webServer?.close(resolve));
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\n共 ${checks} 项检查`);
  return failures > 0 ? 1 : 0;
}

const code = await main().catch((error) => {
  console.error('\n\x1b[31mLB 验证异常：\x1b[0m', error instanceof Error ? error.message : error);
  return 1;
});
if (failures > 0) console.error(`\x1b[31mLB 验证失败 ${failures} 项\x1b[0m`);
else if (checks > 0) console.log('\x1b[32mLB 验证全部通过\x1b[0m');
process.exit(code);
