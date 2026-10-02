#!/usr/bin/env node
/**
 * 集群冒烟脚本（S10 / PLAN-runtime-foundation）。
 *
 *   node scripts/smoke-cluster.mjs
 *
 * 起**两个真实 API 进程**（`apps/api/dist/server.js`，同一镜像在上生产形态），
 * 共用一套 PostgreSQL + Redis 与同一数据目录，逐项验证「拆掉单机假设」后的
 * 跨副本保证：
 *
 *   [1] 会话共享（S3）       节点 A 登录，节点 B 立即认得同一会话
 *   [2] 限流共享（S4）       跨副本共用同一计数，超限统一 429
 *   [3] 事件跨节点（S5）     outbox relay 只认领一次，并广播到 Redis 频道
 *   [4] 任务唯一执行（S6）   BullMQ 任务只被一个副本消费、不重复执行
 *   [5] 运行时一致性（S8）   A 上停用插件，B 无需重启即收敛
 *   [6] 健康就绪（S9）       /health 存活、/ready 校验 PG + Redis + 存储
 *   [7] 生产 fail-fast（S9） 生产缺 Redis 时启动即失败（中文提示）
 *   [8] 编排契约（S7/S9）    两份 compose 都带 worker、共享构建卷、单构建者
 *   [8b] 镜像分发契约（IMG-DIST）release 工作流（GHCR/semver/多架构/SBOM/cosign/Release Notes）
 *                              + STACKPANEL_IMAGE 覆盖 + verify-image.sh + deploy.sh --image
 *
 * 运行前置：
 *   - 已构建 API：`pnpm --filter @stackpanel/api build`
 *   - 已构建内置插件：`node scripts/build-plugin.mjs`（各插件包内，或 pnpm build）
 *   - 本机 PostgreSQL / Redis 可达
 *
 * 连接串（有默认值，可用环境变量覆盖）：
 *   SMOKE_DATABASE_URL  默认 TEST_DATABASE_URL 或 stackpanel_smoke
 *   SMOKE_REDIS_URL     默认 REDIS_URL 或 redis://127.0.0.1:6379/5
 *   SMOKE_BASE_PORT     两个副本端口基准（默认 3110 -> 3110/3111）
 *
 * 退出码非 0 表示失败。脚本自建自销毁临时库与数据目录，可重复运行。
 *
 * 说明（S7 单一构建者）：前端「只构建一次」由单元测试
 * `apps/api/tests/unit/frontend-build.test.ts` 覆盖；本脚本无法在无 web 镜像的
 * 环境里跑真实 `next build`，故改为**静态校验**两份 compose 的 worker 单实例
 * 与共享构建卷契约（见 [8]）。已在部署文档记录该降级。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ENTRY = path.join(ROOT, 'apps', 'api', 'dist', 'server.js');
const requireFromApi = createRequire(path.join(ROOT, 'apps', 'api', 'package.json'));

const DATABASE_URL =
  process.env['SMOKE_DATABASE_URL'] ??
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://stackpanel:stackpanel@127.0.0.1:5432/stackpanel_smoke';
const REDIS_URL =
  process.env['SMOKE_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379/5';
const BASE_PORT = Number(process.env['SMOKE_BASE_PORT'] ?? 3110);
const PORT_A = BASE_PORT;
const PORT_B = BASE_PORT + 1;
const ADMIN_EMAIL = 'smoke-admin@stackpanel.local';
const ADMIN_PASSWORD = 'SmokeAdminPass123';

const REDIS_EVENTS_CHANNEL = 'sp:pubsub:events';

let failures = 0;
let checks = 0;
const ok = (msg) => {
  checks += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
};
const bad = (msg) => {
  checks += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const assert = (condition, label, detail = '') => {
  if (condition) ok(label);
  else bad(`${label}${detail ? `（${detail}）` : ''}`);
};
const section = (title) => console.log(`\n${title}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await predicate();
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(200);
  }
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

const children = new Set();

/** 启动一个 API 副本进程，返回其 ChildProcess。 */
function startReplica(port, extraEnv = {}) {
  const child = spawn(process.execPath, [API_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      API_LOG_LEVEL: 'warn',
      DATABASE_URL,
      REDIS_URL,
      STACKPANEL_DATA_DIR: DATA_DIR,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: path.join(DATA_DIR, 'storage'),
      STACKPANEL_FRONTEND_AUTOBUILD: '0',
      JWT_SECRET: 'smoke_jwt_secret_at_least_32_chars_0123456789',
      SETTINGS_ENCRYPTION_KEY: 'smoke_settings_key_at_least_32_chars_012345',
      STACKPANEL_BOOTSTRAP_EMAIL: ADMIN_EMAIL,
      STACKPANEL_BOOTSTRAP_PASSWORD: ADMIN_PASSWORD,
      LOGIN_RATE_LIMIT_MAX: '0',
      REGISTER_RATE_LIMIT_MAX: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  const collect = (chunk) => logs.push(chunk.toString());
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.logs = logs;
  children.add(child);
  return child;
}

function stopReplica(child) {
  children.delete(child);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** 运行子命令并等待退出，返回 { code, output }。 */
function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let output = '';
    child.stdout?.on('data', (c) => (output += c.toString()));
    child.stderr?.on('data', (c) => (output += c.toString()));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
    child.on('error', (error) => resolve({ code: 1, output: error.message }));
  });
}

// 临时数据目录放在仓库内，插件裸导入 `@stackpanel/sdk` 才能沿目录上溯到根
// node_modules。用后整体删除。
let DATA_DIR = '';

async function recreateDatabase() {
  const { Client } = requireFromApi('pg');
  const url = new URL(DATABASE_URL);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const admin = new Client({ connectionString: maintenance.toString() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const migrate = await run('pnpm', ['--filter', '@stackpanel/db', 'migrate:deploy'], {
    DATABASE_URL,
  });
  if (migrate.code !== 0) {
    throw new Error(`迁移失败：\n${migrate.output}`);
  }
}

async function ensureBuildArtifacts() {
  if (!existsSync(API_ENTRY)) {
    throw new Error(`缺少 API 构建产物：${API_ENTRY}\n请先执行 pnpm --filter @stackpanel/api build`);
  }
  const missing = [];
  for (const id of [
    'login',
    'store',
    'store-wallet',
    'store-product-server',
    'store-product-card',
  ]) {
    const entry = path.join(ROOT, 'packages', 'plugins', id, 'dist', 'index.js');
    if (!existsSync(entry)) missing.push(id);
  }
  if (missing.length > 0) {
    console.log(
      `  \x1b[33m•\x1b[0m 以下内置插件未构建，将被跳过：${missing.join(', ')}\n` +
        `    如冒烟需要，请在各 packages/plugins/<id> 下运行 node ../../../scripts/build-plugin.mjs`,
    );
  }
}

/** 等待 /health 与 /ready 就绪。 */
async function waitForReady(port, child) {
  await waitFor(
    async () => {
      const health = await fetchJson(`http://127.0.0.1:${port}/health`);
      return health.status === 200;
    },
    40_000,
    `副本 :${port} /health`,
  );
  await waitFor(
    async () => {
      const ready = await fetchJson(`http://127.0.0.1:${port}/ready`);
      return ready.status === 200;
    },
    40_000,
    `副本 :${port} /ready`,
  );
  if (child.exitCode !== null) {
    throw new Error(`副本 :${port} 提前退出：\n${child.logs.join('')}`);
  }
}

async function loginOn(port, email, password) {
  const res = await fetchJson(`http://127.0.0.1:${port}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let replicaA = null;
let replicaB = null;
let redis = null;
let subscriber = null;

async function main() {
  const started = Date.now();
  DATA_DIR = await mkdtemp(path.join(ROOT, 'apps', 'api', '.sp-smoke-'));
  console.log(`\n\x1b[1mStackPanel 集群冒烟\x1b[0m`);
  console.log(`  数据库   ${DATABASE_URL}`);
  console.log(`  Redis    ${REDIS_URL}`);
  console.log(`  副本     :${PORT_A} / :${PORT_B}（同进程镜像，共用存储）`);
  console.log(`  数据目录 ${DATA_DIR}`);

  await ensureBuildArtifacts();

  section('[0] 准备：重建冒烟库 + 迁移');
  await recreateDatabase();
  ok('数据库已重建并应用迁移');

  const db = await import(pathToFileURL(path.join(ROOT, 'packages', 'db', 'dist', 'client.js')));
  redis = await db.getRedis(REDIS_URL);
  assert((await redis.ping()) === 'PONG', 'Redis 可达');

  // 清掉上次遗留的限流/队列状态，避免干扰断言。
  const rateKeys = await redis.keys('sp:ratelimit:*');
  if (rateKeys.length > 0) await redis.del(...rateKeys);

  // 先起 A，确保 bootstrap 管理员只由 A 创建（避免两副本并发建号竞态）。
  replicaA = startReplica(PORT_A);
  await waitForReady(PORT_A, replicaA);
  replicaB = startReplica(PORT_B);
  await waitForReady(PORT_B, replicaB);
  ok('两个 API 副本均 /health + /ready 通过');

  // ---- [6] 健康就绪 -------------------------------------------------------
  section('[6] 健康就绪（S9）');
  {
    const ready = await fetchJson(`http://127.0.0.1:${PORT_A}/ready`);
    assert(
      ready.status === 200 &&
        ready.json?.database === 'ok' &&
        ready.json?.redis === 'ok' &&
        ready.json?.storage === 'ok',
      '/ready 报告 database/redis/storage 全 ok',
      JSON.stringify(ready.json),
    );
    const health = await fetchJson(`http://127.0.0.1:${PORT_A}/health`);
    assert(health.status === 200 && health.json?.status === 'ok', '/health 存活探针 ok');
  }

  // ---- [1] 会话共享（S3） -------------------------------------------------
  section('[1] 会话共享（S3）');
  let token = '';
  {
    const login = await loginOn(PORT_A, ADMIN_EMAIL, ADMIN_PASSWORD);
    assert(login.status === 200 && typeof login.json?.token === 'string', '节点 A 登录成功');
    token = login.json?.token ?? '';
    const onB = await fetchJson(`http://127.0.0.1:${PORT_B}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert(
      onB.status === 200 && onB.json?.user?.email === ADMIN_EMAIL,
      '节点 B 立即认得 A 的会话（跨副本共享）',
      `status=${onB.status}`,
    );
  }

  // ---- [2] 限流共享（S4） -------------------------------------------------
  section('[2] 限流共享（S4）');
  {
    // `/auth/oauth/providers` 声明 10/min；两副本共用同一 Redis 计数。
    let lastStatus = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await fetchJson(`http://127.0.0.1:${PORT_A}/auth/oauth/providers`);
      lastStatus = res.status;
    }
    assert(lastStatus === 200, '节点 A 前 10 次未被限流');
    const overflow = await fetchJson(`http://127.0.0.1:${PORT_B}/auth/oauth/providers`);
    assert(
      overflow.status === 429 && overflow.headers.get('retry-after') != null,
      '节点 B 第 11 次被共享计数拒绝（429 + Retry-After）',
      `status=${overflow.status}`,
    );
  }

  // ---- [3] 事件跨节点（S5） -----------------------------------------------
  section('[3] 事件跨节点（S5：outbox + Redis 广播）');
  {
    const received = [];
    subscriber = redis.duplicate();
    await subscriber.subscribe(REDIS_EVENTS_CHANNEL);
    subscriber.on('message', (_channel, message) => {
      try {
        received.push(JSON.parse(message));
      } catch {
        /* 忽略非 JSON */
      }
    });

    const topic = `smoke.cross.${Date.now()}`;
    const { Client } = requireFromApi('pg');
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO outbox_events (id, topic, payload, "createdAt", attempts)
         VALUES ($1, $2, $3, NOW(), 0)`,
        [randomUUID(), topic, JSON.stringify({ body: JSON.stringify({ topic, payload: { hi: 1 } }) })],
      );
      const got = await waitFor(
        () => received.some((m) => m?.topic === topic),
        15_000,
        'outbox 跨节点广播',
      ).catch(() => false);
      assert(got, 'relay 将新事件广播到 Redis 跨节点频道');

      const row = await client.query(
        'SELECT "publishedAt", "lockedBy" FROM outbox_events WHERE topic = $1',
        [topic],
      );
      assert(
        row.rows.length === 1 && row.rows[0].publishedAt != null,
        'outbox 行仅被一个副本认领并标记已发布',
      );
    } finally {
      await client.end();
      await subscriber.unsubscribe(REDIS_EVENTS_CHANNEL).catch(() => undefined);
      await subscriber.quit().catch(() => undefined);
      subscriber = null;
    }
  }

  // ---- [4] 任务唯一执行（S6） ---------------------------------------------
  section('[4] 任务唯一执行（S6：BullMQ）');
  {
    const { Queue } = requireFromApi('bullmq');
    const queue = new Queue('stackpanel', {
      connection: { host: new URL(REDIS_URL).hostname, port: Number(new URL(REDIS_URL).port || 6379), db: Number((new URL(REDIS_URL).pathname || '/0').slice(1)) },
      prefix: 'bull:',
    });
    try {
      const total = 6;
      const ids = [];
      const tag = Date.now();
      for (let i = 0; i < total; i += 1) {
        const id = `smoke-${tag}-${i}`;
        ids.push(id);
        await queue.add(
          'kernel.state.sweep',
          { fullName: 'kernel.state.sweep', payload: null },
          { jobId: id, attempts: 1, removeOnComplete: false, removeOnFail: false },
        );
      }
      await waitFor(
        async () => {
          const states = await Promise.all(ids.map((id) => queue.getJob(id)));
          return (await Promise.all(states.map((job) => job?.isCompleted()))).every(Boolean);
        },
        20_000,
        '任务完成',
      );
      const jobs = await Promise.all(ids.map((id) => queue.getJob(id)));
      const completed = jobs.filter((job) => job && job.attemptsMade === 1);
      assert(
        completed.length === total,
        `入队 ${total} 个内核任务全部只执行一次（跨副本消费无重复）`,
        `完成 ${completed.length}/${total}`,
      );
      for (const id of ids) {
        const job = await queue.getJob(id);
        if (job) await job.remove().catch(() => undefined);
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  }

  // ---- [5] 运行时一致性（S8） ---------------------------------------------
  section('[5] 运行时一致性（S8：跨副本失效）');
  {
    const before = await fetchJson(`http://127.0.0.1:${PORT_B}/hello`);
    assert(before.status === 200, '节点 B 初始可服务 hello 插件路由');

    const off = await fetchJson(`http://127.0.0.1:${PORT_A}/admin/plugins/hello`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert(off.status === 200, '节点 A 停用 hello 插件');

    const converged = await waitFor(
      async () => (await fetchJson(`http://127.0.0.1:${PORT_B}/hello`)).status === 404,
      8_000,
      'B 收敛为停用',
    ).catch(() => false);
    assert(converged, '节点 B 无需重启即停止服务该插件路由（Redis 失效广播生效）');

    const on = await fetchJson(`http://127.0.0.1:${PORT_B}/admin/plugins/hello`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert(on.status === 200, '节点 B 重新启用 hello 插件');
    const reconverged = await waitFor(
      async () => (await fetchJson(`http://127.0.0.1:${PORT_A}/hello`)).status === 200,
      8_000,
      'A 收敛为启用',
    ).catch(() => false);
    assert(reconverged, '节点 A 反向收敛（对称一致性）');
  }

  // ---- [7] 生产 fail-fast（S9） -------------------------------------------
  section('[7] 生产 fail-fast（S9）');
  {
    const prod = await run(process.execPath, [API_ENTRY], {
      NODE_ENV: 'production',
      DATABASE_URL,
      API_PORT: String(BASE_PORT + 9),
      API_LOG_LEVEL: 'warn',
      JWT_SECRET: 'smoke_jwt_secret_at_least_32_chars_0123456789',
      SETTINGS_ENCRYPTION_KEY: 'smoke_settings_key_at_least_32_chars_012345',
      STACKPANEL_DATA_DIR: DATA_DIR,
      REDIS_URL: '',
    });
    assert(prod.code !== 0 && /REDIS|Redis/.test(prod.output), '生产缺 Redis 时启动即失败（退出码非 0）');
    assert(/基础设施初始化失败/.test(prod.output), '失败信息为中文，明确指出基础设施初始化失败');
  }

  // ---- [8] 编排契约（S7/S9） ----------------------------------------------
  section('[8] 编排契约（S7/S9）');
  {
    const defaults = await readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const cluster = await readFile(path.join(ROOT, 'docker-compose.cluster.yml'), 'utf8');
    assert(/entrypoint-worker/.test(defaults), '默认档包含独立 worker 服务');
    assert(/entrypoint-worker/.test(cluster), '集群档包含独立 worker 服务');
    assert(/stackpanel-web-build:/.test(defaults), '默认档声明共享构建卷 stackpanel-web-build');
    assert(/stackpanel-web-build:/.test(cluster), '集群档声明共享构建卷 stackpanel-web-build');
    assert(
      /worker:[\s\S]*?replicas:\s*1/.test(cluster),
      '集群档 worker 固定单副本（唯一构建者，避免并发构建竞态）',
    );
    assert(
      /- stackpanel-web-build:\/app\/apps\/web\/\.next:ro/.test(cluster),
      '集群档 web 只读挂载构建产物（副本从不自行构建）',
    );

    // ---- [8b] 镜像分发契约（IMG-DIST）------------------------------------
    // 只做静态校验（无 CI runner 无法真正 build/push/签名）。
    assert(
      /\$\{STACKPANEL_IMAGE:-/.test(defaults) && /\$\{STACKPANEL_IMAGE:-/.test(cluster),
      '两份 compose 的镜像可由 STACKPANEL_IMAGE 覆盖（发布版不本地构建）',
    );
    assert(
      /image:\s*\$\{STACKPANEL_IMAGE:-stackpanel-api:latest\}/.test(defaults) &&
        /image:\s*\$\{STACKPANEL_IMAGE:-stackpanel-api:latest\}/.test(cluster),
      'api / worker 与 web 指向同一可覆盖镜像引用',
    );

    const release = await readFile(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    assert(/tags:\s*\n\s*- 'v\*'/.test(release), 'release 工作流由 v* 标签触发');
    assert(/ghcr\.io/.test(release) && /IMAGE_NAME:\s*stackpanel/.test(release), '发布镜像推送到 GHCR');
    assert(
      /docker\/metadata-action@v5/.test(release) &&
        /type=semver,pattern=\{\{version\}\}/.test(release) &&
        /type=semver,pattern=\{\{major\}\}/.test(release),
      'semver 标签派生（1.2.3 / 1.2 / 1）',
    );
    assert(/linux\/amd64,linux\/arm64/.test(release), '多架构镜像（amd64 + arm64）');
    assert(/sbom:\s*true/.test(release) && /provenance:\s*true/.test(release), '附带 SBOM 与 SLSA 来源证明');
    assert(/sigstore\/cosign-installer@v3/.test(release) && /cosign sign --yes/.test(release), 'cosign keyless 签名');
    assert(
      /cosign verify[\s\S]*?--certificate-identity-regexp[\s\S]*?release\.yml@[\s\S]*?--certificate-oidc-issuer/.test(
        release,
      ),
      '签名绑定签发身份（release.yml）+ OIDC 签发方',
    );
    assert(
      /softprops\/action-gh-release@v2/.test(release) &&
        /generate_release_notes:\s*true/.test(release),
      'v* 标签自动生成 Release Notes',
    );

    const verify = await readFile(path.join(ROOT, 'scripts/verify-image.sh'), 'utf8');
    assert(/cosign verify/.test(verify) && /--certificate-identity-regexp/.test(verify), 'verify-image.sh 执行 cosign 验签');

    const deploy = await readFile(path.join(ROOT, 'scripts/deploy.sh'), 'utf8');
    assert(/--image/.test(deploy) && /STACKPANEL_IMAGE/.test(deploy), 'deploy.sh 支持 --image 发布镜像部署');

    // ---- [8c] LB 路由与流式契约（DEPLOY-LB / B9）--------------------------
    // 只做静态校验（无公网域名/证书时不起真实 Caddy）。真实运行时校验见
    // scripts/verify-lb.mjs（docker/Caddyfile + 两个假上游，需 docker）。
    const caddy = await readFile(path.join(ROOT, 'docker', 'Caddyfile'), 'utf8');
    assert(
      /@api path[\s\S]*?\/api\/v1\/\*[\s\S]*?\/mcp[\s\S]*?\/sp\/v1\/\*[\s\S]*?\/llm-gateway\/\*/.test(
        caddy,
      ),
      'Caddyfile 将开放平台机器面（/api/v1、/mcp、/sp/v1、/llm-gateway）路由到 API',
    );
    assert(
      /handle @api \{[\s\S]*?reverse_proxy \{\$API_UPSTREAM\}/.test(caddy) &&
        /flush_interval -1/.test(caddy),
      'API 反代保留原路径（前缀不剥离）且 flush_interval -1（SSE 逐写刷新，不缓冲）',
    );
    assert(
      !/^\s*handle_path\s/m.test(caddy),
      'Caddyfile 不含 handle_path 指令（会剥离 /api 前缀，令开放平台 404）',
    );
    // encode gzip 只允许出现在 web 兜底块内；机器面若被压缩会破坏 SSE。
    const apiBlockMatch = caddy.match(/handle @api \{[\s\S]*?\n\t\}/);
    assert(
      apiBlockMatch != null && !/encode/.test(apiBlockMatch[0]),
      'API 机器面不套 encode gzip（避免缓冲/压缩压坏 text/event-stream）',
    );
    assert(
      /stream_close_delay/.test(caddy),
      'API 反代声明 stream_close_delay（Caddy 重载时不断开在途 SSE/流）',
    );
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n共 ${checks} 项检查，用时 ${elapsed}s`);
}

async function cleanup() {
  for (const child of [...children]) stopReplica(child);
  await subscriber?.quit().catch(() => undefined);
  try {
    await redis?.quit();
  } catch {
    /* 忽略 */
  }
  if (DATA_DIR) await rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
}

try {
  await main();
  await cleanup();
  if (failures > 0) {
    console.error(`\x1b[31m冒烟失败 ${failures} 项\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32m集群冒烟全部通过\x1b[0m');
  process.exit(0);
} catch (error) {
  console.error('\n\x1b[31m冒烟异常：\x1b[0m', error instanceof Error ? error.message : error);
  if (replicaA?.logs?.length) console.error('\n--- 副本 A 日志 ---\n' + replicaA.logs.join(''));
  if (replicaB?.logs?.length) console.error('\n--- 副本 B 日志 ---\n' + replicaB.logs.join(''));
  await cleanup();
  process.exit(1);
}
