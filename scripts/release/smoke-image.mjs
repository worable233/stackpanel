#!/usr/bin/env node
/**
 * 发布前冒烟：**用官方镜像起一套真实 compose，然后按用户路径验一遍。**
 *
 * 为什么必须存在（v0.1.0 / v0.1.1 的真实事故）：那两个 tag 的镜像
 * ① 漏打 `.next/static`（页面无样式、不 hydrate）、② 插件子进程入口打错（任何
 * isolated 插件都装不上）、③ 首页 500（服务端组件跨客户端边界）、④ 全新实例没有
 * 信任根（市场里一个包都装不上）。这四个问题在构建机、类型检查、单元测试里全绿，
 * 只有「拉镜像、从零 up、装插件装主题」才会暴露。
 *
 * 用法：
 *   node scripts/release/smoke-image.mjs --image ghcr.io/owner/stackpanel:0.1.2
 *   node scripts/release/smoke-image.mjs --image stackpanel-test:local --keep
 *
 * 选项：
 *   --image <ref>     必填，被测镜像（tag 或 @sha256:）
 *   --project <name>  compose 项目名（默认 stackpanel-smoke，隔离卷与容器）
 *   --web-port <n>    宿主机 Web 端口（默认 18000）
 *   --api-port <n>    宿主机 API 端口（默认 18001）
 *   --plugin <id>     额外指定要安装的插件 id（默认自动挑选：captcha 优先）
 *   --theme <id>      额外指定要安装的主题 id（默认自动挑选）
 *   --timeout <sec>   单步等待上限（默认 300）
 *   --keep            失败/成功后都保留栈，便于人工排查
 *   --offline         跳过需要外网的两步（市场安装），只验静态资源/健康/信任根
 *
 * 退出码：0 全部通过；非 0 表示失败（打印 compose ps 与容器日志尾部）。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const image = typeof args.image === 'string' ? args.image : '';
if (!image) {
  console.error('缺少 --image <ref>（被测镜像）');
  process.exit(2);
}
const project = typeof args.project === 'string' ? args.project : 'stackpanel-smoke';
const webPort = Number(args['web-port'] ?? 18000);
const apiPort = Number(args['api-port'] ?? 18001);
const stepTimeoutMs = Number(args.timeout ?? 300) * 1000;
const keep = Boolean(args.keep);
const offline = Boolean(args.offline);

const WEB = `http://127.0.0.1:${webPort}`;
const API = `http://127.0.0.1:${apiPort}`;
const setupToken = randomBytes(24).toString('hex');
const adminEmail = 'smoke@example.invalid';
const adminPassword = `Sm0ke-${randomBytes(12).toString('hex')}!`;

let failures = 0;
const passed = [];

function ok(label, detail = '') {
  passed.push(label);
  console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`);
}

async function check(label, fn) {
  try {
    const detail = await fn();
    ok(label, typeof detail === 'string' ? detail : '');
  } catch (error) {
    failures += 1;
    console.log(`  \u2717 ${label} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------- process helpers
function sh(command, argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 15 * 60_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const composeArgs = ['compose', '-p', project, '-f', path.join(repoRoot, 'docker-compose.yml')];
let envFile = null;
function compose(argv, options = {}) {
  return sh('docker', [...composeArgs, `--env-file`, envFile, ...argv], options);
}

// ---------------------------------------------------------------- http helpers
async function http(url, init = {}) {
  const response = await fetch(url, { redirect: 'manual', ...init });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON（HTML 页面）。
  }
  return { status: response.status, text, json, headers: response.headers };
}

async function waitFor(label, fn, timeoutMs = stepTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== false && result !== undefined && result !== null) return result;
      lastError = '条件未满足';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s，最后状态：${lastError}）`);
}

const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------- stack
async function startStack() {
  const dir = mkdtempSync(path.join(tmpdir(), 'stackpanel-smoke-'));
  envFile = path.join(dir, '.env');
  writeFileSync(
    envFile,
    [
      `STACKPANEL_IMAGE=${image}`,
      // 每把密钥现生成：冒烟绝不依赖开发机 .env，也绝不复用真实实例的密钥。
      `JWT_SECRET=${randomBytes(48).toString('hex')}`,
      `SETTINGS_ENCRYPTION_KEY=${randomBytes(48).toString('hex')}`,
      // 这三个密码在 compose 里**没有默认值**（默认值等于「装了就能被访问」），
      // 留空会让 postgres / minio 的 healthcheck 直接失败。
      `POSTGRES_PASSWORD=${randomBytes(18).toString('hex')}`,
      `MINIO_ROOT_PASSWORD=${randomBytes(18).toString('hex')}`,
      `STACKPANEL_SETUP_TOKEN=${setupToken}`,
      `STACKPANEL_API_PORT=${apiPort}`,
      `STACKPANEL_WEB_PORT=${webPort}`,
      `STACKPANEL_PUBLIC_URL=${WEB}`,
      `STACKPANEL_API_PUBLIC_URL=${API}`,
      '',
    ].join('\n'),
  );

  // 只起本冒烟关心的服务：不碰 `updater`。升级路径由 `release:rehearse` 覆盖，而
  // updater 镜像在本机未必可拉（本地构建验证时就是这样），把它拉进来只会让冒烟
  // 因为一个无关服务失败。
  const services = ['postgres', 'redis', 'minio', 'minio-init', 'migrate', 'api', 'worker', 'web'];
  const up = await compose(['up', '-d', ...services], { timeoutMs: 20 * 60_000 });
  if (up.code !== 0) {
    throw new Error(`docker compose up 失败：\n${up.stderr || up.stdout}`.slice(0, 4000));
  }
  return dir;
}

async function dumpDiagnostics() {
  console.log('\n--- docker compose ps ---');
  const ps = await compose(['ps']);
  console.log(ps.stdout.trim() || ps.stderr.trim());
  for (const service of ['api', 'worker', 'web', 'migrate']) {
    console.log(`\n--- logs: ${service} (尾部 80 行) ---`);
    const logs = await compose(['logs', '--no-color', '--tail', '80', service]);
    console.log((logs.stdout || logs.stderr).trim());
  }
}

async function stopStack(dir) {
  if (keep) {
    console.log(`\n--keep：栈保留（project=${project}，env 文件 ${envFile}）`);
    console.log(`  docker compose -p ${project} -f docker-compose.yml down -v   # 用完清理`);
    return;
  }
  await compose(['down', '-v', '--remove-orphans'], { timeoutMs: 10 * 60_000 });
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- checks
async function checkHomeAndAssets() {
  const home = await http(`${WEB}/`);
  if (home.status !== 200) throw new Error(`GET / = ${home.status}`);
  // Next 只在 standalone 目录里找 `.next/static`：镜像漏拷时这里 302/404，
  // 页面看起来 200，但完全没有样式、也没有 hydration。
  const assets = [...home.text.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  if (assets.length === 0) throw new Error('首页没有任何 /_next/static 引用（构建产物异常？）');
  const checked = assets.slice(0, 5);
  for (const asset of checked) {
    const response = await http(`${WEB}${asset}`);
    if (response.status !== 200) throw new Error(`${asset} = ${response.status}`);
    if (response.text.length === 0) throw new Error(`${asset} 是空文件`);
  }
  return `${checked.length} 个静态资源 200，共发现 ${assets.length} 个引用`;
}

async function checkHealth() {
  const health = await http(`${API}/health`);
  if (health.status !== 200) throw new Error(`/health = ${health.status}`);
  const ready = await http(`${API}/ready`);
  if (ready.status !== 200) {
    throw new Error(`/ready = ${ready.status}：${JSON.stringify(ready.json)}`);
  }
  const version = await http(`${API}/version`);
  if (version.status !== 200) throw new Error(`/version = ${version.status}`);
  if (typeof version.json?.version !== 'string') throw new Error('/version 没有 version 字段');
  return `version=${version.json.version} commit=${version.json.commit ?? '-'}`;
}

async function checkTrustSeeded() {
  const version = await http(`${API}/version`);
  const trust = version.json?.trust;
  if (!trust) throw new Error('/version 没有 trust 段（旧镜像？）');
  if (!(trust.packageKeys >= 1)) {
    throw new Error(`全新实例没有 package 公钥（trust=${JSON.stringify(trust)}）`);
  }
  if (!(trust.catalogKeys >= 1) || !(trust.kernelKeys >= 1)) {
    throw new Error(`信任根用途不全：${JSON.stringify(trust)}`);
  }
  if (trust.signatureRequired && trust.packageKeys < 1) throw new Error('签名策略与信任根不一致');
  return `keyring=${trust.keyringPath}（catalog ${trust.catalogKeys} / package ${trust.packageKeys} / kernel ${trust.kernelKeys}）`;
}

async function checkUnauthenticatedMe() {
  const me = await http(`${API}/api/v1/me`);
  if (me.status !== 401) throw new Error(`未登录 GET /api/v1/me = ${me.status}（期望 401）`);
  return '401';
}

async function createAdmin() {
  // `/setup` 挂在根路径下（不是 `/api/v1/setup`）：安装认领属于引导流程，故意和
  // 业务 API 分开，provision 模式里还只注册 `/setup/provision`。
  const setup = await http(`${API}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword, setupToken }),
  });
  if (setup.status !== 201) {
    throw new Error(`POST /api/v1/setup = ${setup.status}：${setup.text.slice(0, 400)}`);
  }
  const token = setup.json?.token;
  if (!token) throw new Error('setup 没有返回会话令牌');
  const me = await http(`${API}/api/v1/me`, { headers: authHeaders(token) });
  if (me.status !== 200) throw new Error(`创建管理员后 GET /me = ${me.status}`);
  return token;
}

/**
 * 市场是随内核发行的**内置插件**，但内置不等于已启用：全新实例里它是 `registered`，
 * `/api/v1/market/admin/*` 全是 404。用户视角的「打开应用市场」第一步就是启用它，
 * 冒烟必须走同一条路。
 */
async function enableMarket(token) {
  const patch = await http(`${API}/api/v1/admin/plugins/market`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  if (patch.status >= 400) {
    throw new Error(`启用 market = ${patch.status}：${patch.text.slice(0, 300)}`);
  }
  await waitFor('market 激活', async () => {
    const status = await http(`${API}/api/v1/market/admin/status`, { headers: authHeaders(token) });
    if (status.status === 200) return true;
    if (status.status !== 404 && status.status !== 503) {
      throw new Error(`market 状态 = ${status.status}`);
    }
    return false;
  });
  return 'market → active';
}

async function listCatalog(token) {
  const response = await http(`${API}/api/v1/market/admin/plugins`, { headers: authHeaders(token) });
  if (response.status !== 200) {
    throw new Error(`目录列表 = ${response.status}：${response.text.slice(0, 300)}`);
  }
  return Array.isArray(response.json?.plugins) ? response.json.plugins : [];
}

async function installPlugin(token, pluginId) {
  const response = await http(`${API}/api/v1/market/admin/plugins/${pluginId}/install`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (response.status >= 400) {
    throw new Error(`安装 ${pluginId} = ${response.status}：${response.text.slice(0, 400)}`);
  }
  // 生产镜像里第三方插件一律 isolated：装完必须是 active，否则就是子进程没起来。
  const state = await waitFor(`插件 ${pluginId} 激活`, async () => {
    const list = await http(`${API}/api/v1/admin/plugins`, { headers: authHeaders(token) });
    const entry = (list.json?.plugins ?? []).find((plugin) => plugin.id === pluginId);
    if (entry?.state === 'active') return entry.state;
    if (entry?.state === 'failed') throw new Error(`插件状态 failed`);
    return false;
  });
  const logs = await compose(['logs', '--no-color', 'api', 'worker']);
  const activated = /Plugin activated/i.test(logs.stdout + logs.stderr);
  if (!activated) throw new Error('插件已 active，但日志里没有激活行（重定向到 stderr？）');
  return `${pluginId} → ${state}`;
}

async function installTheme(token, themeIds) {
  let lastError = '';
  for (const themeId of themeIds) {
    const response = await http(`${API}/api/v1/market/admin/themes/${themeId}/install`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    if (response.status < 400) {
      const home = await http(`${WEB}/`);
      if (home.status !== 200) throw new Error(`装主题后 GET / = ${home.status}`);
      if (/Application error|Internal Server Error/i.test(home.text)) {
        throw new Error('装主题后首页渲染失败');
      }
      return `${themeId}（首页 200）`;
    }
    lastError = `安装 ${themeId} = ${response.status}：${response.text.slice(0, 200)}`;
  }
  throw new Error(lastError || '没有可用的主题候选');
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`冒烟：image=${image} project=${project} web=${WEB} api=${API}`);
  let dir = null;
  let token = null;
  try {
    dir = await startStack();
    console.log('\n[1/6] 启动与健康');
    await check('镜像起来后 /health /ready /version 都 200', async () => {
      // 容器启动 + 迁移 + 插件注册需要时间；这里显式等待，而不是靠 compose --wait
      // （migrate 是 oneshot 服务，--wait 的语义容易踩坑）。
      await waitFor('/health', async () => (await http(`${API}/health`)).status === 200);
      await waitFor('/ready', async () => {
        const response = await http(`${API}/ready`);
        if (response.status !== 200) throw new Error(`ready=${response.status} ${JSON.stringify(response.json)}`);
        return true;
      });
      await waitFor('Web /', async () => (await http(`${WEB}/`)).status === 200);
      return checkHealth();
    });
    await check('全新数据卷自动写入信任根（无需人工放 keyring.json）', checkTrustSeeded);

    console.log('\n[2/6] 静态资源（镜像漏打 .next/static 会在这里失败）');
    await check('首页 200 且引用的 chunk 全部可下载', checkHomeAndAssets);

    console.log('\n[3/6] 鉴权');
    await check('未登录 /api/v1/me 返回 401', checkUnauthenticatedMe);
    await check('可以用 API 无浏览器初始化管理员（headless setup）', async () => {
      token = await createAdmin();
      return adminEmail;
    });

    console.log('\n[4/6] 市场安装插件（isolated 子进程）');
    if (offline) {
      console.log('  - 跳过（--offline）');
    } else if (!token) {
      console.log('  - 跳过（没有管理员会话）');
    } else {
      await check('启用内置 market 插件（全新实例默认是 registered）', () => enableMarket(token));
      await check('从市场安装插件并激活', async () => {
        const catalog = await listCatalog(token);
        const plugins = catalog.map((entry) => entry.id);
        const wanted = typeof args.plugin === 'string' ? args.plugin : 'captcha';
        const target = plugins.includes(wanted) ? wanted : plugins[0];
        if (!target) throw new Error('目录里没有任何插件条目');
        return installPlugin(token, target);
      });
    }

    console.log('\n[5/6] 市场安装主题');
    if (offline) {
      console.log('  - 跳过（--offline）');
    } else {
      await check('安装主题后首页仍可渲染', async () => {
        const catalog = await listCatalog(token);
        const themes = catalog.map((entry) => entry.id);
        const wanted = typeof args.theme === 'string' ? args.theme : 'default';
        const candidates = [wanted, ...themes].filter((id, index, all) => all.indexOf(id) === index);
        if (candidates.length === 0) throw new Error('目录里没有任何主题条目');
        return installTheme(token, candidates);
      });
    }

    console.log('\n[6/6] 收尾');
    const home = await http(`${WEB}/`);
    await check('最终首页仍 200', async () => {
      if (home.status !== 200) throw new Error(`GET / = ${home.status}`);
      return '200';
    });
  } catch (error) {
    failures += 1;
    console.log(`\n致命错误：${error instanceof Error ? error.message : String(error)}`);
    await dumpDiagnostics();
  } finally {
    if (failures > 0 && !keep) await dumpDiagnostics();
    if (dir) {
      await stopStack(dir);
    } else {
      // 启动阶段就失败：stack 可能半启动，仍然要收干净，否则下次冒烟撞端口/撞卷。
      await compose(['down', '-v', '--remove-orphans'], { timeoutMs: 10 * 60_000 });
      if (envFile) rmSync(path.dirname(envFile), { recursive: true, force: true });
    }
  }

  console.log(`\n通过 ${passed.length} 项，失败 ${failures} 项。`);
  if (failures > 0) process.exit(1);
}

await main();
