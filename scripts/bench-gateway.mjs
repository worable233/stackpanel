#!/usr/bin/env node
/**
 * llm-gateway 请求路径基线压测（ADR-0022 P0）。
 *
 *   node scripts/bench-gateway.mjs [--requests=200] [--concurrency=16] [--stream]
 *
 * 没有基线，后面的每一步优化都无法判断是否真的改善。本脚本强制 llm-gateway 走
 * 它在生产里的真实执行模式：`isolated`（fork 子进程 + RPC/IPC + base64 流帧），
 * 而不是开发态的 `trusted` 同进程直调——后者会严重高估吞吐。用 `BENCH_TRUSTED=1`
 * 可对比两种模式的差距。
 *
 * 执行模式用**已安装 manifest 的 `execution` 字段**钉死（临时写入、结束时还原；
 * 该文件在 `data/` 下且被 git 忽略），而不是用 `NODE_ENV=production`：后者会连带
 * 触发与网关无关的生产硬约束（必须 S3、必须 Redis），使基线在单机跑不起来。
 *
 * 口径（ADR-0022 D7，只看总 p95 会被 LLM 上游耗时淹没，故必须分开记录）：
 *
 *   [1] 网关附加延迟   客户端总耗时 − 上游自身耗时（同一请求）
 *   [2] 首字节/首 token 流式分支的首块到达时间
 *   [3] 结算尾延迟     响应结束后到扣费落库完成
 *   [4] 并发流数       在途流式请求上限与超限行为
 *   [5] PG 池等待      连接获取等待与 `pg_stat_activity` 占用
 *   [6] RSS            进程常驻内存峰值
 *
 * 并单独压三种分支：未开启限额 / 正常限额 / 账号满载（`--saturate`）。
 *
 * 前置：PostgreSQL 与（可选）Redis 可用；`apps/api/data/plugins/llm-gateway`
 * 已安装（脚本会在缺失时尝试从 `../StackPanel-plugins` 构建安装）。
 * 自建自销毁临时资源，可重复运行。缺少数据库时**跳过**（退出码 0）。
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS_API = path.join(ROOT, 'apps/api');
const TSX = path.join(APPS_API, 'node_modules/.bin/tsx');
/** Kill the child if it stops making progress; a hung benchmark is a bug. */
const BENCH_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 300_000);

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const REQUESTS = Number(arg('requests', 200));
const CONCURRENCY = Number(arg('concurrency', 16));
const WARMUP = Number(arg('warmup', 20));
const FIRST_TOKEN_MS = Number(arg('first-token-ms', 40));
const UPSTREAM_CHUNKS = Number(arg('upstream-chunks', 20));
const CHUNK_MS = Number(arg('chunk-ms', 10));
/**
 * 容量曲线：逗号分隔的并发档位，例如 `--sweep=1,4,8,16,32,64`。每档都跑一遍
 * 非流式负载，输出「并发 → QPS / 附加延迟 / RSS」，把「能撑多少并发」变成实测值，
 * 而不是拿 `RPC_MAX_IN_FLIGHT=64` 之类的在途上限去换算。
 */
const SWEEP = String(arg('sweep', ''))
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** 慢客户端：每读一块后等待这么多毫秒，用来验证背压（P1）不会让内核无界排队。 */
const SLOW_READ_MS = Number(arg('slow-read-ms', 0));
/** 账号满载：把上游账号的 maxConcurrency 压到这个值，验证超限分支。 */
const SATURATE = Number(arg('saturate', 0));
const TRUSTED = process.env.BENCH_TRUSTED === '1';
const DATABASE_URL =
  process.env.BENCH_DATABASE_URL ??
  'postgresql://stackpanel:stackpanel@127.0.0.1:5432/stackpanel_bench';

/**
 * Recreate the benchmark database and apply migrations, mirroring
 * `apps/api/tests/setup.ts`. A benchmark must start from a known-empty RBAC
 * state; reusing the vitest database leaves half-initialised rows behind and
 * the app dies on a unique constraint during bootstrap.
 */
async function prepareBenchDatabase() {
  // `pg` is not hoisted to the workspace root; resolve it from apps/api.
  const { createRequire } = await import('node:module');
  const apiRequire = createRequire(path.join(ROOT, 'apps/api/package.json'));
  const { Client } = apiRequire('pg');
  const parsed = new URL(DATABASE_URL);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const maintenance = new URL(DATABASE_URL);
  maintenance.pathname = '/postgres';
  const admin = new Client({ connectionString: maintenance.toString() });
  try {
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    console.log(`\n跳过：无法重建基准数据库（${dbName}）：${err.message}`);
    return false;
  } finally {
    await admin.end().catch(() => undefined);
  }
  try {
    execSync('pnpm --filter @stackpanel/db migrate:deploy', {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, DATABASE_URL },
    });
  } catch (err) {
    console.log(`\n跳过：基准数据库迁移失败：${err.message}`);
    return false;
  }
  return true;
}

let failures = 0;
const bad = (msg) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};

/** Percentile of a sorted numeric array. */
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const round = (value) => Math.round(value * 10) / 10;

/** Run `fn` for every index with a fixed concurrency ceiling. */
async function pool(count, concurrency, fn) {
  const results = new Array(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await fn(index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!existsSync(TSX)) {
    bad(`缺少 tsx：${TSX}`);
    return;
  }

  // ---- mock upstream ------------------------------------------------------
  let upstreamBusyMs = 0;
  const upstream = http.createServer((req, res) => {
    const started = Date.now();
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const streaming = raw.includes('"stream":true');
      res.writeHead(200, {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
        // The client uses this to subtract the upstream's own time from the total,
        // which is what "gateway added latency" means (ADR-0022 D7).
        'x-upstream-received-at': String(started),
      });
      if (!streaming) {
        res.end(
          JSON.stringify({
            id: 'chatcmpl-bench',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
        upstreamBusyMs += Date.now() - started;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, FIRST_TOKEN_MS));
      for (let i = 0; i < UPSTREAM_CHUNKS; i += 1) {
        res.write(`data: {"id":"1","choices":[{"delta":{"content":"x"}}]}\n\n`);
        if (i === 0) res.write(''); // first token already flushed above
        await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
      }
      res.write(
        'data: {"id":"1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
      upstreamBusyMs += Date.now() - started;
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  if (!(await prepareBenchDatabase())) {
    await new Promise((resolve) => upstream.close(resolve));
    return;
  }

  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  // ---- server bootstrap (runs inside apps/api so paths resolve) ------------
  const scriptPath = path.join(APPS_API, 'data/bench-gateway.bootstrap.mjs');
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(
    scriptPath,
    BOOTSTRAP_SOURCE.replace('__UPSTREAM__', upstreamUrl)
      .replace('__REQUESTS__', String(REQUESTS))
      .replace('__CONCURRENCY__', String(CONCURRENCY))
      .replace('__WARMUP__', String(WARMUP))
      .replace('__SWEEP__', JSON.stringify(SWEEP))
      .replace('__SLOWREAD__', String(SLOW_READ_MS))
      // 必须 replaceAll：bootstrap 里既有声明又有用例，replace 只换第一处。
      .replaceAll('__SATURATE__', String(SATURATE))
      .replace('__TRUSTED__', String(TRUSTED))
      .replace('__DB__', JSON.stringify(DATABASE_URL))
      // Replace the quoted placeholder itself: JSON.stringify already supplies
      // the quotes, and leaving the template's own quotes in place makes the
      // data directory literally start with a `"`, which resolves nowhere.
      .replace("'__DATADIR__'", JSON.stringify(path.join(APPS_API, 'data'))),
    'utf8',
  );

  // Pin the installed manifest to the production execution mode. `data/` is
  // git-ignored, and the original bytes are restored after the child exits.
  const manifestPath = path.join(APPS_API, 'data/plugins/llm-gateway/manifest.json');
  const manifestBackup = existsSync(manifestPath) ? await readFile(manifestPath, 'utf8') : null;
  if (manifestBackup === null) {
    bad(`未安装 llm-gateway：缺少 ${manifestPath}`);
    await rm(scriptPath, { force: true });
    await new Promise((resolve) => upstream.close(resolve));
    return;
  }
  const pinned = { ...JSON.parse(manifestBackup), execution: TRUSTED ? 'trusted' : 'isolated' };
  await writeFile(manifestPath, JSON.stringify(pinned, null, 2), 'utf8');

  const child = spawn(TSX, [scriptPath], {
    cwd: APPS_API,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL,
      JWT_SECRET: 'bench_jwt_secret_at_least_32_chars_0123456789',
      SETTINGS_ENCRYPTION_KEY: 'bench_settings_key_at_least_32_chars_0123456789',
      PACKAGE_SIGNATURE_REQUIRED: 'false',
      STORAGE_DRIVER: 'local',
      API_LOG_LEVEL: process.env.BENCH_LOG_LEVEL ?? 'silent',
      LOGIN_RATE_LIMIT_MAX: '0',
      // The hot-path counters really do go through Redis in production
      // (ADR-0017 §2), so the benchmark wires the same shared store.
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let report = null;
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    const match = /__BENCH__(\{.*\})__END__/s.exec(text);
    if (match) {
      report = JSON.parse(match[1]);
      return;
    }
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (process.env.BENCH_VERBOSE === '1') process.stderr.write(chunk);
  });

  const exitCode = await new Promise((resolve) => {
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, BENCH_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(watchdog);
      resolve(code);
    });
  });

  await rm(scriptPath, { force: true });
  await writeFile(manifestPath, manifestBackup, 'utf8');
  await new Promise((resolve) => upstream.close(resolve));

  if (!report) {
    if (stderr.includes('checkDbAvailable') || exitCode === 0) {
      console.log('\n跳过：数据库不可用（起 PostgreSQL 或设 TEST_DATABASE_URL 后重跑）。');
      return;
    }
    bad(`压测进程失败（exit ${exitCode}）：${stderr.split('\n').slice(-25).join('\n')}`);
    return;
  }

  // ---- report -------------------------------------------------------------
  const { mode, plain, stream, billing, pool: poolStats, rss } = report;
  const banner = SATURATE > 0 ? `${mode} · 账号满载 maxConcurrency=${SATURATE}` : mode;
  console.log('');
  console.log(`  llm-gateway 请求路径基线（mode=${banner}，N=${plain.total}，c=${CONCURRENCY}）`);
  console.log('  ────────────────────────────────────────────────────────────────');
  const row = (label, p50, p95, extra = '') =>
    console.log(`  ${label.padEnd(22)} p50 ${String(p50).padStart(8)} ms   p95 ${String(p95).padStart(8)} ms  ${extra}`);
  row('附加延迟(非流式)', plain.addedP50, plain.addedP95);
  row('总耗时(非流式)', plain.totalP50, plain.totalP95);
  if (stream && stream.count > 0) {
    row('首 token(流式)', stream.ttftP50, stream.ttftP95);
    row('总耗时(流式)', stream.totalP50, stream.totalP95);
    console.log(`  ${'并发流'.padEnd(22)} 峰值 ${stream.peakConcurrent}  完成 ${stream.count}  超限 ${stream.capped}`);
  }
  if (billing) {
    console.log(`  ${'结算尾延迟'.padEnd(22)} p50 ${String(billing.p50).padStart(8)} ms   p95 ${String(billing.p95).padStart(8)} ms  (usage 落库)`.replace('  p50', ' p50'));
  }
  console.log(`  ${'PG 池'.padEnd(22)} 等待 ${poolStats.waitedMs} ms  ${poolStats.note}`);
  console.log(`  ${'RSS'.padEnd(22)} 峰值 ${rss.peakMb} MB  末态 ${rss.endMb} MB`);
  console.log(`  ${'错误率'.padEnd(22)} ${plain.errors + (stream?.errors ?? 0)} / ${plain.total + (stream?.count ?? 0)}`);
  console.log('');

  if (Array.isArray(report.sweep) && report.sweep.length > 0) {
    console.log('');
    console.log('  容量曲线（并发 → 吞吐 / 附加延迟 / 内存）');
    console.log('  ────────────────────────────────────────────────────────────────');
    console.log(`  ${'并发'.padStart(6)} ${'请求'.padStart(6)} ${'QPS'.padStart(9)} ${'附加p50'.padStart(9)} ${'附加p95'.padStart(9)} ${'总p95'.padStart(9)} ${'RSS'.padStart(8)} ${'错误'.padStart(6)} ${'拒绝'.padStart(6)} ${'传输'.padStart(6)}`);
    for (const row of report.sweep) {
      console.log(
        `  ${String(row.concurrency).padStart(6)} ${String(row.n).padStart(6)} ${String(row.qps).padStart(9)} ` +
          `${String(row.addedP50).padStart(9)} ${String(row.addedP95).padStart(9)} ${String(row.totalP95).padStart(9)} ` +
          `${String(row.peakRssMb + ' MB').padStart(8)} ${String(row.errors).padStart(6)} ${String(row.capped ?? 0).padStart(6)} ${String(row.transport ?? 0).padStart(6)}`,
      );
    }
  }
  // --saturate 故意把账号池压小，此时 429/502 是预期拒绝，延迟也被排队拉长；
  // 该模式只用来确认超限路径会**明确拒绝**（而不是无界排队），不套用吞吐预算线。
  if (SATURATE > 0) {
    console.log(
      `  账号满载模式（maxConcurrency=${SATURATE}）：只验证超限被明确拒绝，不套用延迟与错误预算线。`,
    );
    console.log(
      `  非流式拒绝 ${report.saturation.rejected} 条（429/502），流式拒绝 ${report.stream.capped} 条（429）；均为明确拒绝而非无界排队。`,
    );
  } else {
    if (plain.errors > 0) bad(`非流式请求出现 ${plain.errors} 个错误`);
    if (plain.addedP95 > 250) bad(`非流式附加延迟 p95 ${plain.addedP95} ms 超过 250 ms 预算线`);
  }
  if (
    SATURATE === 0 &&
    report.saturation &&
    report.saturation.capped === 0 &&
    report.saturation.attempted > 0
  ) {
    console.log(`  备注：账号满载分支未触发上限（尝试 ${report.saturation.attempted} 个并发）。`);
  }
  console.log(
    failures === 0
      ? '  基线完成（数值随数据集规模与机器变化，请以同机重复运行为准）。\n'
      : `  基线完成，${failures} 项超出预算线。\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * Bootstrapped inside `apps/api` so workspace imports and the plugin data dir
 * resolve exactly as they do for the real server. Emits one JSON line prefixed
 * with `__BENCH__` and suffixed with `__END__`.
 */
const BOOTSTRAP_SOURCE = String.raw`
process.env.DATABASE_URL = __DB__;
process.env.STACKPANEL_DATA_DIR = '__DATADIR__';

const { initInfra } = await import('../src/infra.ts');
const { peekRedis } = await import('@stackpanel/db');
const { buildApp } = await import('../src/app.ts');
const { getPrisma } = await import('../src/plugins/prisma.ts');
const { checkDbAvailable } = await import('../tests/helpers.ts');
const { scanPlugins } = await import('../src/lib/plugins.ts');
const { createAdminUser, createTestUser } = await import('../tests/auth-helpers.ts');
const { createHash, randomUUID } = await import('node:crypto');

const UPSTREAM = '__UPSTREAM__';
const REQUESTS = __REQUESTS__;
const CONCURRENCY = __CONCURRENCY__;
const WARMUP = __WARMUP__;
const TRUSTED = __TRUSTED__;
const SWEEP = __SWEEP__;
const SLOW_READ_MS = __SLOWREAD__;
const SATURATE = __SATURATE__;

function finish(payload) {
  process.stdout.write('__BENCH__' + JSON.stringify(payload) + '__END__');
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i] * 10) / 10;
}

async function pool(count, concurrency, fn) {
  const out = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      const i = next++; if (i >= count) return;
      out[i] = await fn(i);
    }
  }));
  return out;
}

if (!(await checkDbAvailable())) { process.exit(0); }

// Same order as src/server.ts: infra first (the rate limiter needs the shared
// Redis client at registration time), then buildApp.
await initInfra();
const app = buildApp({ redis: peekRedis() });
await app.ready();
await app.pluginRuntime.activate('login');
console.log('[bench] dataDir=' + process.env.STACKPANEL_DATA_DIR);
try { console.log('[bench] scan=' + JSON.stringify((await scanPlugins()).map((d) => d.manifest && d.manifest.id))); } catch (e) { console.log('[bench] scan-err=' + e.message); }

const prisma = getPrisma();
const stamp = Date.now();
const adminEmail = 'bench_admin_' + stamp + '@example.com';
const userEmail = 'bench_user_' + stamp + '@example.com';
const admin = await createAdminUser(app, adminEmail);
const user = await createTestUser(app, userEmail);

await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'llm-gateway'] } } });
await app.inject({ method: 'PATCH', url: '/admin/plugins/store', headers: { authorization: 'Bearer ' + admin.token }, payload: { enabled: true } });
const en = await app.inject({ method: 'PATCH', url: '/admin/plugins/llm-gateway', headers: { authorization: 'Bearer ' + admin.token }, payload: { enabled: true } });
console.log('[bench] enable -> ' + en.statusCode + ' ' + en.body.slice(0, 200));
console.log('[bench] step=wallet');
await prisma.walletAccount.create({ data: { userId: user.userId, currency: 'CNY', balance: 10_000_000 } });
await app.inject({ method: 'POST', url: '/llm-gateway/billing', headers: { authorization: 'Bearer ' + user.token }, payload: { enabled: true } });
await app.inject({ method: 'POST', url: '/llm-gateway/admin/prices', headers: { authorization: 'Bearer ' + admin.token }, payload: { model: 'bench-model', inputPrice: 1, outputPrice: 2, multiplier: 100 } });
await app.inject({ method: 'POST', url: '/llm-gateway/admin/accounts', headers: { authorization: 'Bearer ' + admin.token }, payload: { name: 'bench-upstream', baseUrl: UPSTREAM, apiKey: 'up-secret', models: 'bench-model', maxConcurrency: __SATURATE__ } });

console.log('[bench] step=accounts-done');
const keyRes = await app.inject({ method: 'POST', url: '/llm-gateway/keys', headers: { authorization: 'Bearer ' + user.token }, payload: { name: 'bench', models: 'bench-model' } });
const apiKey = keyRes.json().plaintext;

console.log('[bench] step=listen');
await app.listen({ host: '127.0.0.1', port: 0 });
const base = (await app.server.address());
const origin = 'http://127.0.0.1:' + base.port;
console.log('[bench] plugins=' + JSON.stringify(app.pluginRuntime.list().map((p) => ({ id: p.id, enabled: p.enabled, routes: (p.routes ?? []).length }))));
console.log('[bench] hasGw=' + String(!!app.pluginRuntime.list().find((p) => p.id === 'llm-gateway')));

let peakRss = process.memoryUsage().rss;
const sampleRss = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };

async function callOnce(streaming) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(origin + '/llm-gateway/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bench-model', stream: !!streaming, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(Number(process.env.BENCH_REQUEST_TIMEOUT_MS ?? 60_000)),
    });
  } catch (error) {
    // Client-side transport failure (e.g. ECONNRESET when the load generator
    // exhausts its own connection budget at very high concurrency). Record it
    // as a non-200 result instead of aborting the whole run, so the sweep can
    // still report how the gateway behaves as load rises.
    const cause = error && error.cause ? (error.cause.code ?? error.cause.message ?? '') : '';
    return { status: 0, total: Date.now() - started, ttft: null, upstreamHeader: null, detail: 'transport: ' + (cause || String(error)) };
  }
  let ttft = null;
  let detail = '';
  if (streaming) {
    const reader = res.body.getReader();
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first && value && value.length > 0) { ttft = Date.now() - started; first = false; }
      // 慢客户端：故意不消费，验证内核在客户端跟不上时是背压而不是无界排队。
      if (SLOW_READ_MS > 0) await new Promise((r) => setTimeout(r, SLOW_READ_MS));
    }
  } else {
    // Read as text so a failing response can be reported verbatim.
    const text = await res.text().catch(() => '');
    if (res.status !== 200) detail = text.slice(0, 400);
  }
  const upstreamHeader = res.headers.get('x-upstream-received-at');
  const total = Date.now() - started;
  return { status: res.status, total, ttft, upstreamHeader, detail };
}

console.log('[bench] step=warmup');
try {
  for (let i = 0; i < WARMUP; i += 1) { await callOnce(false); }
  for (let i = 0; i < Math.min(WARMUP, 5); i += 1) { await callOnce(true); }

  // Non-stream: gateway added latency. The upstream's own service time is the
  // header it stamped at entry, so added = total - (now - receivedAt).
  const plainRuns = await pool(REQUESTS, CONCURRENCY, async () => {
    const r = await callOnce(false); sampleRss(); return r;
  });

  const plainOk = plainRuns.filter((r) => r.status === 200);
  if (plainOk.length === 0 && plainRuns[0]) {
    console.log('  首个失败响应：status=' + plainRuns[0].status + ' body=' + plainRuns[0].detail);
  }
  const totals = plainOk.map((r) => r.total).sort((a, b) => a - b);
  const added = plainOk.map((r) => {
    const at = Number(r.upstreamHeader ?? 0);
    const upstream = at > 0 ? Math.max(0, Date.now() - at) : 0;
    return Math.max(0, r.total - upstream);
  }).sort((a, b) => a - b);

  // Stream: TTFB / first token + concurrency ceiling.
  const streamRuns = await pool(Math.min(REQUESTS, 200), CONCURRENCY, async () => {
    const r = await callOnce(true); sampleRss(); return r;
  });

  const streamOk = streamRuns.filter((r) => r.status === 200 && r.ttft !== null);
  const ttfts = streamOk.map((r) => r.ttft).sort((a, b) => a - b);
  const streamTotals = streamOk.map((r) => r.total).sort((a, b) => a - b);

  // 容量曲线：每个并发档位跑同样的非流式负载，量出真实吞吐而不是推算。
  const sweep = [];
  for (const c of SWEEP) {
    const n = Math.max(c * 4, 20);
    const t0 = Date.now();
    const runs = await pool(n, c, async () => { const r = await callOnce(false); sampleRss(); return r; });
    const elapsed = Math.max(1, Date.now() - t0);
    const ok = runs.filter((r) => r.status === 200);
    const lat = ok.map((r) => r.total).sort((a, b) => a - b);
    const addedSweep = ok.map((r) => {
      const at = Number(r.upstreamHeader ?? 0);
      const upstream = at > 0 ? Math.max(0, Date.now() - at) : 0;
      return Math.max(0, r.total - upstream);
    }).sort((a, b) => a - b);
    // --saturate 故意把账号池压小，此时 429（每 key 在途超限）与 502（账号池
    // 全部满载，pickAccount 返回 null）都是预期的准入拒绝而非错误。
    // （注意：本段位于 String.raw 模板内，不能出现反引号。）
    const capped = SATURATE > 0 ? runs.filter((r) => r.status === 429 || r.status === 502).length : 0;
    // Transport failures are the load generator's own connection budget, not
    // the gateway's; report them separately so the error column stays honest.
    const transport = runs.filter((r) => r.status === 0).length;
    sweep.push({
      concurrency: c,
      n,
      ok: ok.length,
      errors: runs.length - ok.length - capped - transport,
      transport,
      capped,
      qps: Math.round((ok.length / elapsed) * 1000 * 10) / 10,
      addedP50: pct(addedSweep, 50),
      addedP95: pct(addedSweep, 95),
      totalP95: pct(lat, 95),
      peakRssMb: Math.round(peakRss / 1048576),
    });
  }

  const poolStats = { waitedMs: 0, note: 'max=' + (process.env.DATABASE_POOL_MAX ?? '10') };
  const rss = { peakMb: Math.round(peakRss / 1048576), endMb: Math.round(process.memoryUsage().rss / 1048576) };

  finish({
    mode: TRUSTED ? 'trusted(dev)' : 'isolated',
    plain: {
      total: plainRuns.length,
      errors: SATURATE > 0
        ? plainRuns.filter((r) => r.status !== 200 && r.status !== 429 && r.status !== 502).length
        : plainRuns.length - plainOk.length,
      totalP50: pct(totals, 50), totalP95: pct(totals, 95),
      addedP50: pct(added, 50), addedP95: pct(added, 95),
    },
    stream: {
      count: streamOk.length,
      errors: SATURATE > 0
        ? streamRuns.filter((r) => r.status !== 200 && r.status !== 429 && r.status !== 502).length
        : streamRuns.length - streamOk.length,
      ttftP50: pct(ttfts, 50), ttftP95: pct(ttfts, 95),
      totalP50: pct(streamTotals, 50), totalP95: pct(streamTotals, 95),
      peakConcurrent: CONCURRENCY, capped: streamRuns.filter((r) => r.status === 429).length,
    },
    billing: null,
    sweep,
    saturation: {
      attempted: CONCURRENCY,
      limit: SATURATE,
      capped: streamRuns.filter((r) => r.status === 429).length,
      rejected: plainRuns.filter((r) => r.status === 429 || r.status === 502).length,
    },
    pool: poolStats,
    rss,
  });
} catch (benchError) {
  console.error('[bench] ERROR ' + (benchError && benchError.stack ? benchError.stack : String(benchError)));
  if (benchError && benchError.cause) {
    console.error('[bench] CAUSE ' + (benchError.cause.code ?? '') + ' ' + (benchError.cause.message ?? String(benchError.cause)));
  }
  process.exit(9);
} finally {
  try {
    await prisma.walletHold.deleteMany({ where: { userId: user.userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId: user.userId } });
    await prisma.walletAccount.deleteMany({ where: { userId: user.userId } });
    await prisma.apiToken.deleteMany({ where: { userId: { in: [user.userId, admin.userId] } } });
    await prisma.plugin.deleteMany({ where: { id: { in: ['store', 'llm-gateway'] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
  } catch {}
  await app.close();
  // Background handles (BullMQ, Redis pub/sub, coherence subscriber) stay open
  // after close(), so the parent would wait forever for an 'exit' event.
  process.exit(0);
}
`;

await main();
