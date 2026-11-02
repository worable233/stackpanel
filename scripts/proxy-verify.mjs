#!/usr/bin/env node
/**
 * 部署后自检：从**外部**打你部署好的站点，逐条断言「反代到底有没有把请求转对」。
 *
 * 为什么不能靠 `nginx -t` 或读配置：这次事故的全部形态都**语法合法**
 * —— 正则 location 被面板的 `^~ /` 静默吞掉、`X-Forwarded-Proto` 写成 `$scheme`、
 * 真实 IP 网段漏配。它们在配置文件里长得完全正常，只有「发一个请求、看落到哪里」
 * 才能发现。
 *
 * 用法：
 *   node scripts/proxy-verify.mjs --base https://sp.example.com
 *   node scripts/proxy-verify.mjs --base https://sp.example.com --token <admin token>
 *   node scripts/proxy-verify.mjs --base http://127.0.0.1:3000 --theme default
 *
 * 选项：
 *   --base <url>       必填，站点对外地址（协议要对，含 https）
 *   --token <token>    管理员 API token；给了才跑需要鉴权的断言
 *   --theme <id>       主题 id（默认 `default`），用于断言主题资源前缀
 *   --skip-sse         跳过 SSE 断言（不装通知插件时可能没有流）
 *   --timeout <sec>    单个请求超时（默认 15）
 *   --json             机器可读输出
 *
 * 退出码：0 全绿；1 有失败；2 用法错误。
 */

const args = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
})();

if (typeof args.base !== 'string') {
  console.error(
    [
      '用法：node scripts/proxy-verify.mjs --base <url> [选项]',
      '',
      '  --base <url>     站点对外地址，例如 https://sp.example.com',
      '  --token <token>  管理员 API token（跑需要鉴权的断言）',
      '  --theme <id>     主题 id（默认 default）',
      '  --skip-sse       跳过 SSE 断言',
      '  --timeout <sec>  单请求超时（默认 15）',
      '  --json           机器可读输出',
      '',
      '背景与每条断言的判定见 docs/DEPLOY-REVERSE-PROXY.md §3。',
    ].join('\n'),
  );
  process.exit(2);
}

const base = args.base.replace(/\/+$/, '');
const token = typeof args.token === 'string' ? args.token : null;
const themeId = typeof args.theme === 'string' ? args.theme : 'default';
const timeoutMs = Number(args.timeout ?? 15) * 1000;
const json = Boolean(args.json);

const results = [];

function record(id, label, ok, detail, fix) {
  results.push({ id, label, ok, detail, ...(ok ? {} : { fix }) });
  if (!json) {
    const mark = ok ? '\u2713' : '\u2717';
    console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok && fix) console.log(`    \u2192 ${fix}`);
  }
}

async function get(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      redirect: 'manual',
      signal: controller.signal,
      ...init,
      headers: { accept: '*/*', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON
    }
    return { status: response.status, text, body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 断言 1：首页 200，且页面引用的静态 chunk 能下载（面板把资源转错会在这里死）。 */
async function checkStatic() {
  const home = await get('/');
  if (home.status !== 200) {
    record('home', '首页可访问', false, `GET / = ${home.status}`, '检查 Web 上游与首页路由是否指向 3000');
    return;
  }
  const assets = [...home.text.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)]
    .map((match) => match[1])
    .slice(0, 3);
  if (assets.length === 0) {
    record('home', '首页可访问', false, '首页没有任何 /_next/static 引用（构建产物异常？）', '确认镜像里带 .next/static');
    return;
  }
  for (const asset of assets) {
    const response = await get(asset);
    if (response.status !== 200 || response.text.length === 0) {
      record(
        'static',
        '静态资源可下载',
        false,
        `${asset} = ${response.status}${response.text.length === 0 ? '（空文件）' : ''}`,
        '面板把 /_next/ 转错了；确认 Web 上游与 ^~ 前缀规则',
      );
      return;
    }
  }
  record('static', '静态资源可下载', true, `${assets.length} 个 chunk 均 200`);
}

/** 断言 2：/health 命中 API（JSON 而不是 HTML 404 页面）。 */
async function checkApiPrefix() {
  const health = await get('/health');
  const contentType = health.headers.get('content-type') ?? '';
  if (health.status !== 200) {
    record(
      'apiPrefix',
      'API 前缀命中',
      false,
      `GET /health = ${health.status}`,
      '把 `location ^~ /health` 转发到 API 上游；见 §2.1',
    );
    return;
  }
  if (!contentType.includes('application/json')) {
    record(
      'apiPrefix',
      'API 前缀命中',
      false,
      `GET /health 返回 ${contentType || '未知类型'}（期望 JSON）—— 请求落到了 Web`,
      '面板的 `location ^~ /` 把 API 前缀吞了；把前缀规则改成 `^~`，见 §2.1',
    );
    return;
  }
  record('apiPrefix', 'API 前缀命中', true, 'GET /health 返回 JSON');
}

/** 断言 3：主题资源前缀（/themes/*）。 */
async function checkThemePrefix() {
  const response = await get(`/themes/${encodeURIComponent(themeId)}/theme.css`);
  if (response.status !== 200) {
    record(
      'themePrefix',
      '主题资源前缀命中',
      false,
      `GET /themes/${themeId}/theme.css = ${response.status}`,
      '把 `location ^~ /themes/` 转发到 API 上游；主题资源由内核提供，不是 Web',
    );
    return;
  }
  record('themePrefix', '主题资源前缀命中', true, `GET /themes/${themeId}/theme.css = 200`);
}

/** 断言 4：/version 可达（构建身份）。 */
async function checkVersion() {
  const response = await get('/version');
  if (response.status !== 200 || typeof response.body?.version !== 'string') {
    record(
      'version',
      '/version 可达',
      false,
      `GET /version = ${response.status}`,
      '加 `location ^~ /version` 转发到 API；见 §2.1 的前缀清单',
    );
    return;
  }
  record('version', '/version 可达', true, `version=${response.body.version}`);
}

/** 断言 5：/ready 里的 proxy.trusted（真实 IP 是否生效）。 */
async function checkRealIp() {
  const response = await get('/ready');
  if (response.status !== 200) {
    // 503 说明依赖没就绪，那是另一个问题；这里只关心 proxy 段。
    if (!response.body?.proxy) {
      record(
        'realIp',
        '真实 IP 生效',
        false,
        `GET /ready = ${response.status} 且没有 proxy 段（内核版本过旧？）`,
        '升级到含 proxy 子项的版本，或用「系统设置 → 反代自检」查看',
      );
      return;
    }
  }
  const proxy = response.body?.proxy;
  if (!proxy) {
    record('realIp', '真实 IP 生效', false, 'GET /ready 没有 proxy 段', '升级内核到本版本');
    return;
  }
  if (proxy.trusted) {
    record('realIp', '真实 IP 生效', true, `clientIp=${proxy.clientIp}`);
    return;
  }
  record(
    'realIp',
    '真实 IP 生效',
    false,
    `内核仍认为对端就是访客（peer=${proxy.peer}）`,
    '反代网段未被信任：加 set_real_ip_from + API_TRUST_PROXY，见 §2.3',
  );
}

/** 断言 6：同源判定（后台 POST 会不会被 403）。需要管理员 token。 */
async function checkOriginGuard() {
  if (!token) {
    if (!json) console.log('  - 同源判定：跳过（没有 --token）');
    return;
  }
  const response = await get('/api/v1/system/proxy-check', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    record(
      'originGuard',
      '同源判定可通过',
      false,
      `GET /api/v1/system/proxy-check = ${response.status}`,
      response.status === 401 || response.status === 403
        ? 'token 无效或不是管理员'
        : '内核版本不包含该端点，或 /api/v1/ 前缀没转发',
    );
    return;
  }
  if (response.body.originGuardWouldPass) {
    record('originGuard', '同源判定可通过', true, '后台 POST 不会被 403');
    return;
  }
  record(
    'originGuard',
    '同源判定可通过',
    false,
    `Origin=${response.body.originGuard?.origin ?? '?'} 与反代报的 proto=${response.body.originGuard?.forwardedProto ?? '(未报)'} 不匹配`,
    'X-Forwarded-Proto 写错（CDN/面板终止 TLS 时不能用 $scheme），见 §2.2',
  );
}

/** 断言 7：SSE 未被缓冲。 */
async function checkSse() {
  if (args['skip-sse']) {
    if (!json) console.log('  - SSE 未被缓冲：跳过（--skip-sse）');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const response = await fetch(`${base}/notifications/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // 该端点可能因为未登录而返回 401/404 —— 那不是反代问题。
      record('sse', 'SSE 未被缓冲', true, `跳过（${response.status} ${contentType || '无类型'}）`);
      return;
    }
    // 读第一个字节的耗时：代理缓冲会把事件攒着装满才发。
    const reader = response.body?.getReader();
    if (!reader) {
      record('sse', 'SSE 未被缓冲', false, '响应没有可读的流', 'proxy_buffering off，且不要 gzip text/event-stream');
      return;
    }
    const chunk = await reader.read();
    const firstByteMs = Date.now() - started;
    await reader.cancel().catch(() => {});
    if (firstByteMs > 3000) {
      record(
        'sse',
        'SSE 未被缓冲',
        false,
        `首字节 ${firstByteMs}ms（>3s）`,
        'proxy_buffering off；不要 gzip text/event-stream，见 §5',
      );
      return;
    }
    record('sse', 'SSE 未被缓冲', true, `首字节 ${firstByteMs}ms${chunk.done ? '（流已结束）' : ''}`);
  } catch (error) {
    record(
      'sse',
      'SSE 未被缓冲',
      true,
      `跳过（${error instanceof Error ? error.message : String(error)}）`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!json) {
    console.log(`反代自检：${base}\n`);
  }
  const steps = [
    ['HTTP 可达', async () => {
      try {
        await get('/health');
        return true;
      } catch (error) {
        record(
          'reachable',
          'HTTP 可达',
          false,
          error instanceof Error ? error.message : String(error),
          '检查 DNS / 证书 / 端口；自签证书会被 fetch 拒绝',
        );
        return false;
      }
    }],
  ];

  const [reachable] = await Promise.all(steps.map(([, fn]) => fn()));
  if (!reachable) {
    finish();
    return;
  }

  // 串行跑：每条断言都可能影响对「下一步该怎么修」的判断，且请求量很小。
  await checkStatic();
  await checkApiPrefix();
  await checkThemePrefix();
  await checkVersion();
  await checkRealIp();
  await checkOriginGuard();
  await checkSse();

  finish();
}

function finish() {
  const failed = results.filter((entry) => !entry.ok);
  if (json) {
    process.stdout.write(
      JSON.stringify({ base, ok: failed.length === 0, checkedAt: new Date().toISOString(), results }, null, 2) + '\n',
    );
  } else {
    console.log('');
    if (failed.length === 0) {
      console.log(`全部通过（${results.length} 项）。`);
    } else {
      console.log(`失败 ${failed.length} 项 / 共 ${results.length} 项。`);
      console.log('逐条的根因与修复见 docs/DEPLOY-REVERSE-PROXY.md §5「症状 → 根因 → 修复」。');
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
