#!/usr/bin/env node
/**
 * 生成可直接粘贴的反代配置 —— 把「读模板 + 手改占位符」变成一条命令。
 *
 * 为什么需要生成器而不是「一份写好的示例文件」：模板里的 4 个占位符各自取决于
 * **你的拓扑**（TLS 在哪终止、反代在不在同一个 docker 网络、前面有没有 CDN），
 * 手改的失败率极高，而失败症状全部伪装成别的问题：
 *
 *   - `X-Forwarded-Proto` 写错 → 后台所有 POST 403「请求来源无效」（页面正常）
 *   - 真实 IP 网段没写     → 全员共用一个 IP，整站被限流
 *   - 前缀漏一个           → 插件前端 / 主题资源 / 支付回调 404
 *
 * 用法：
 *   node scripts/proxy-config.mjs --topology same-host --domain sp.example.com
 *   node scripts/proxy-config.mjs --topology container --domain sp.example.com \
 *     --real-ip-from 172.18.0.0/16 --out /etc/nginx/conf.d/stackpanel.conf
 *   node scripts/proxy-config.mjs --topology cdn --cdn cloudflare,cloudfront \
 *     --domain sp.example.com --out /tmp/sp.conf
 *
 * 拓扑：
 *   same-host    nginx 与 StackPanel 同机（compose 就在本机）：TLS 在 nginx 终止
 *   container    反代是另一个 docker 网络里的容器（1Panel / 群晖反代）
 *   cdn          前面还有 Cloudflare / CloudFront / 云 LB，TLS 在 CDN 终止
 *   passthrough  完全信任上游写好的 X-Forwarded-Proto（自建多级反代）
 *
 * 选项：
 *   --domain <host>         server_name（默认 localhost）
 *   --listen <spec>         listen 参数（默认 80；配了 --tls 时 443 ssl http2）
 *   --tls                   在 listen 上加 ssl http2（证书行需自己填，见输出尾部提示）
 *   --web-upstream <addr>   Web 上游（默认按拓扑推断）
 *   --api-upstream <addr>   API 上游（默认按拓扑推断）
 *   --real-ip-from <cidrs>  覆盖自动推断的真实 IP 网段（逗号分隔）
 *   --cdn <names>           展开各家官方回源 CIDR（cloudflare,cloudfront,fastly,akamai）
 *   --edge-proto <mode>     覆盖协议策略：scheme|https|forwarded
 *   --out <file>            写入文件（默认打印到 stdout）
 *   --cdn-update            强制刷新 CDN 段缓存（默认用内置快照，15 天内不重拉）
 *   --json                  以 JSON 输出（给自动化/测试用）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const TEMPLATE = path.join(repoRoot, 'docker', 'proxy', 'nginx.conf.example');
const CACHE_FILE = path.join(homedir(), '.cache', 'stackpanel', 'cdn-cidrs.json');
const CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000;

/**
 * 各家 CDN 的官方回源网段来源。
 *
 * 内置一份**快照**是刻意的：生成器要在没有外网、或被墙的部署机上也能跑。快照会
 * 过期，所以：① 超过 {@link CACHE_TTL_MS} 会在能联网时自动刷新；② `--cdn-update`
 * 强制刷新；③ 输出里会打印这份段来自「内置快照」还是「线上拉取」，运维能判断。
 */
const CDN_SOURCES = {
  cloudflare: {
    url: 'https://api.cloudflare.com/client/v4/ips',
    extract: (json) => [
      ...(json?.result?.ipv4_cidrs ?? []),
      ...(json?.result?.ipv6_cidrs ?? []),
    ],
  },
  cloudfront: {
    url: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    extract: (json) => [
      ...(json?.prefixes ?? [])
        .filter((entry) => entry.service === 'CLOUDFRONT')
        .map((entry) => entry.ip_prefix),
      ...(json?.ipv6_prefixes ?? [])
        .filter((entry) => entry.service === 'CLOUDFRONT')
        .map((entry) => entry.ipv6_prefix),
    ],
  },
  fastly: {
    url: 'https://api.fastly.com/public-ip-list',
    extract: (json) => [...(json?.addresses ?? []), ...(json?.ipv6_addresses ?? [])],
  },
  akamai: {
    // Akamai 的段是逐个交付的，没有稳定的公开 JSON；用官方文档里的固定段。
    url: null,
    extract: () => [
      '23.32.0.0/11',
      '23.192.0.0/11',
      '96.6.0.0/15',
      '96.16.0.0/15',
      '184.24.0.0/13',
      '104.64.0.0/10',
      '2.16.0.0/13',
    ],
  },
};

/** 内置快照（生成器在无外网时的兜底；不追求完整，只求「别让人共用一个 IP」）。 */
const CDN_SNAPSHOT = {
  cloudflare: [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
  ],
};

/** 每种拓扑的默认值。生成器的核心就是这张表。 */
const TOPOLOGIES = {
  'same-host': {
    summary: 'nginx 与 StackPanel 同机（compose 就在本机），TLS 在本机 nginx 终止',
    webUpstream: '127.0.0.1:3000',
    apiUpstream: '127.0.0.1:3001',
    edgeProto: '$scheme',
    edgePort: '443',
    realIpFrom: [],
    notes: [
      'TLS 在本机 nginx 终止：$scheme 对访客与 nginx 这一跳都是 https，所以协议用 $scheme 是对的。',
      '上游走宿主端口（127.0.0.1:3000/3001）；compose 默认把这两个端口发布到宿主。',
    ],
  },
  container: {
    summary: '反代是另一个 docker 网络里的容器（1Panel 反代、群晖反向代理、独立 nginx）',
    webUpstream: 'stackpanel-web:3000',
    apiUpstream: 'stackpanel-api:3001',
    edgeProto: '$scheme',
    edgePort: '443',
    realIpFrom: [],
    notes: [
      '默认上游用服务名（web:3000 / api:3001）——**仅当**反代容器与 StackPanel 在同一个 docker 网络时能解析。',
      '反代在另一个网络（1Panel / 群晖的默认布局）时用宿主地址，并用 --web-upstream / --api-upstream 覆盖。',
      'nginx 会在**加载配置时**解析 upstream 主机名，所以名字不通时 `nginx -t` 会直接报',
      '`host not found in upstream` —— 看到这句就说明上游地址选错了，不是配置语法问题。',
      '**必须**把反代容器所在网段写进 --real-ip-from，否则内核把所有访客认成同一个 IP。',
    ],
  },
  cdn: {
    summary: '前面还有 CDN / 云 LB，TLS 在 CDN 终止，回源 http',
    webUpstream: '127.0.0.1:3000',
    apiUpstream: '127.0.0.1:3001',
    edgeProto: 'https',
    edgePort: '443',
    realIpFrom: [],
    notes: [
      'TLS 在 CDN 终止、回源走 http：`$scheme` 会得到 http，而浏览器 Origin 是 https，',
      '同源守卫必然 403。所以这里写死 `https`（--edge-proto forwarded 可改为信任 CDN 的头）。',
      '--cdn 选中的各家回源段会自动展开进 set_real_ip_from，否则整站会被认成一个 IP。',
      'CDN 侧记得把「回源段」加入 WAF 白名单：有些面板的 CC 防护会把回源当攻击封掉。',
    ],
  },
  passthrough: {
    summary: '自建多级反代，完全信任上游写好的 X-Forwarded-Proto',
    webUpstream: '127.0.0.1:3000',
    apiUpstream: '127.0.0.1:3001',
    edgeProto: '$http_x_forwarded_proto',
    edgePort: '443',
    realIpFrom: [],
    notes: [
      '仅当**你自己就是上游**、能保证它一定写了正确的 X-Forwarded-Proto 时才用这个模式。',
      '用它而上游没写时，协议会落成空串 → 同源守卫仍会失败。',
    ],
  },
};

// ------------------------------------------------------------------ args
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

function fail(message) {
  console.error(`proxy-config: ${message}`);
  process.exit(2);
}

const topologyName = typeof args.topology === 'string' ? args.topology : 'same-host';
const topology = TOPOLOGIES[topologyName];
if (!topology) {
  fail(
    `未知拓扑 "${topologyName}"。可选：${Object.keys(TOPOLOGIES).join(' / ')}\n` +
      '每种拓扑的适用场景见 docs/DEPLOY-REVERSE-PROXY.md 第 2 节。',
  );
}

const domain = typeof args.domain === 'string' ? args.domain : 'localhost';
const webUpstream = typeof args['web-upstream'] === 'string' ? args['web-upstream'] : topology.webUpstream;
const apiUpstream = typeof args['api-upstream'] === 'string' ? args['api-upstream'] : topology.apiUpstream;
const listenSpec =
  typeof args.listen === 'string' ? args.listen : args.tls ? '443 ssl http2' : '80';
const edgeProto =
  typeof args['edge-proto'] === 'string'
    ? args['edge-proto'] === 'scheme'
      ? '$scheme'
      : args['edge-proto'] === 'https'
        ? 'https'
        : '$http_x_forwarded_proto'
    : topology.edgeProto;

// ------------------------------------------------------------------ CDN CIDRs
function readCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function resolveCdnCidrs(names, { refresh }) {
  const cache = refresh ? null : readCache();
  const fresh = cache ? Date.now() - (cache.at ?? 0) < CACHE_TTL_MS : false;
  const out = {};
  const warnings = [];

  for (const name of names) {
    const source = CDN_SOURCES[name];
    if (!source) {
      warnings.push(`未知 CDN "${name}"，已忽略（可选：${Object.keys(CDN_SOURCES).join(' / ')}）`);
      continue;
    }
    if (fresh && Array.isArray(cache.cidrs?.[name]) && cache.cidrs[name].length > 0) {
      out[name] = { cidrs: cache.cidrs[name], origin: 'cache' };
      continue;
    }
    if (source.url) {
      try {
        const response = await fetch(source.url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const cidrs = source.extract(await response.json()).filter(
          (entry) => typeof entry === 'string' && entry.includes('/'),
        );
        if (cidrs.length === 0) throw new Error('返回里没有 CIDR');
        out[name] = { cidrs, origin: 'live' };
        continue;
      } catch (error) {
        warnings.push(
          `拉取 ${name} 的官方段失败（${error instanceof Error ? error.message : String(error)}），` +
            '回退到内置快照（可能已过期，联网后跑 --cdn-update 刷新）',
        );
      }
    }
    out[name] = { cidrs: CDN_SNAPSHOT[name] ?? [], origin: 'snapshot' };
    if ((CDN_SNAPSHOT[name] ?? []).length === 0) {
      warnings.push(`${name} 既无内置快照也无法拉取：set_real_ip_from 会缺失，请手工补它的回源段`);
    }
  }

  if (Object.values(out).some((entry) => entry.origin === 'live')) {
    try {
      mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify(
          { at: Date.now(), cidrs: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.cidrs])) },
          null,
          2,
        ),
      );
    } catch {
      // 缓存写不了不影响生成结果。
    }
  }
  return { resolved: out, warnings };
}

// ------------------------------------------------------------------ render
/** 两个共享的 proxy 指令块（模板里以一行占位符出现，展开后是完整指令）。 */
function proxyBlock(upstream, { stream = false } = {}) {
  const lines = [
    'proxy_pass http://' + upstream + ';',
    'proxy_http_version 1.1;',
    'proxy_set_header Host              $host;',
    'proxy_set_header X-Real-IP         $remote_addr;',
    'proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Proto $sp_forwarded_proto;',
    'proxy_set_header X-Forwarded-Port  $sp_forwarded_port;',
    'proxy_set_header X-Forwarded-Host  $host;',
    'proxy_set_header Upgrade           $http_upgrade;',
    'proxy_set_header Connection        $sp_connection_upgrade;',
    // 缓冲必须关：SSE（进度、备份下载、LLM 流式）在 proxy_buffering on 时会被攒着
    // 一起发，客户端表现是「进度条不动 / 流式输出一次性出来」。
    'proxy_buffering off;',
    'proxy_cache off;',
    'proxy_read_timeout 3600s;',
  ];
  if (stream) lines.push('proxy_send_timeout 300s;');
  // 每行独立、行尾不留缩进：模板里 `<location …> { __SP_PROXY_WEB__ }` 的 `}` 会
  // 紧跟最后一条指令，`lines.join('\n        ')` 之类带尾随空格的写法会把它拼成
  // `proxy_read_timeout 3600s; }`。那不只是难看 —— 任何按行扫描块的工具（包括
  // 我们自己的模板回归用例）都会因此算错块的边界。
  return lines.map((line) => `        ${line}`).join('\n');
}

function renderRealIpFrom({ cidrs, explicit }) {
  const entries = [];
  if (explicit) entries.push(...explicit);
  for (const [name, cidrs_] of Object.entries(cidrs)) {
    entries.push(...cidrs_.cidrs.map((cidr) => `${cidr} # ${name}`));
  }
  if (entries.length === 0) {
    return [
      '# 本拓扑不需要 set_real_ip_from：',
      '# 反代与内核之间没有别的代理，客户端 IP 由 X-Forwarded-For 正确追加。',
      '# 如果你前面**还有**一层（CDN / 云 LB / 面板反代容器），必须在这里补它的回源段，',
      '# 否则内核把所有访客认成同一个 IP（整站被限流）。重新生成时加 --cdn 或 --real-ip-from。',
    ].join('\n');
  }
  // IPv6 与 IPv4 一起写；nginx 允许混合。
  const lines = entries.map((entry) => {
    const [cidr, ...comment] = entry.split('#').map((part) => part.trim());
    return `set_real_ip_from ${cidr};${comment.length > 0 ? `  # ${comment.join(' ')}` : ''}`;
  });
  lines.push('real_ip_header X-Forwarded-For;');
  lines.push('real_ip_recursive on;');
  return lines.join('\n');
}

/**
 * 模板顶部的说明段（含 `__SP_*__` 字样）由生成器剔除：那一段是给**读文件的人**
 * 看的，生成器会自己写等价的头部。不剔除会出现两个问题：① 输出里残留
 * `__SP_` 让人以为没替换；② 同一件事写两遍，早晚不一致。
 */
function stripTemplateHeader(source) {
  const begin = source.indexOf('# ===== TEMPLATE-HEADER-BEGIN');
  const end = source.indexOf('# ===== TEMPLATE-HEADER-END');
  if (begin === -1 || end === -1 || end < begin) return source;
  const after = source.slice(end);
  const newline = after.indexOf('\n');
  return after.slice(newline + 1).replace(/^\n+/, '');
}

/**
 * 只替换**非注释行**里的占位符。
 *
 * 这不是洁癖：`real_ip_from` / `proxy_pass` 那几个值是多行的，一旦被替换进
 * 以 `#` 开头的说明行，多出来的行就落到注释外面去了 —— 实测 `nginx -t` 报
 * `unknown directive "由生成器替换："`。模板需要能在注释里指名道姓地解释这些
 * 占位符，所以「按行、跳过注释」是唯一稳定的做法。
 *
 * 替换后仍会校验有没有漏网的 `__SP_...__`（见 main）。
 */
function applyPlaceholders(template, values) {
  return template
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return line;
      // 多行值（proxy 指令块、set_real_ip_from 段）自己带缩进，所以当整行**只是**
      // 一个占位符时，用替换值原地替换整行、不要保留模板里的行首缩进 —— 否则第一
      // 行会有两份缩进，后面几行对齐也乱。
      const sole = /^\s*(__SP_[A-Z_]+__)\s*$/.exec(line);
      if (sole && values[sole[1]] !== undefined) return values[sole[1]];
      let next = line;
      for (const [token, value] of Object.entries(values)) {
        if (next.includes(token)) next = next.split(token).join(value);
      }
      return next;
    })
    .join('\n');
}

async function main() {
  const cdnNames =
    typeof args.cdn === 'string'
      ? args.cdn
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : [];
  const { resolved, warnings } = await resolveCdnCidrs(cdnNames, {
    refresh: Boolean(args['cdn-update']),
  });

  const explicitRealIp =
    typeof args['real-ip-from'] === 'string'
      ? args['real-ip-from']
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

  if (topologyName === 'cdn' && cdnNames.length === 0 && explicitRealIp.length === 0) {
    warnings.push(
      '选了 cdn 拓扑但没给 --cdn / --real-ip-from：set_real_ip_from 为空，内核会把所有访客' +
        '认成同一个 IP。加 `--cdn cloudflare` 之类的参数重新生成。',
    );
  }

  const template = stripTemplateHeader(readFileSync(TEMPLATE, 'utf8'));
  const webBlock = proxyBlock('stackpanel_web');
  const apiBlock = proxyBlock('stackpanel_api');

  const rendered = applyPlaceholders(template, {
    __SP_EDGE_PROTO__: edgeProto,
    __SP_EDGE_PORT__: topology.edgePort,
    __SP_WEB_UPSTREAM__: webUpstream,
    __SP_API_UPSTREAM__: apiUpstream,
    __SP_REAL_IP_FROM__: renderRealIpFrom({ cidrs: resolved, explicit: explicitRealIp }),
    __SP_PROXY_WEB__: webBlock,
    __SP_PROXY_API__: apiBlock,
    __SP_LISTEN__: listenSpec,
    __SP_SERVER_NAME__: domain,
  });

  // 生成器的新鲜度自检：模板新增了占位符但忘了在生成器里替换，会留下 `__SP_`，
  // nginx 会以「unknown directive」在 nginx -t 时才报 —— 提前在这里拦住。
  // 只看非注释行：注释里指名道姓解释占位符是**有意**的（见 applyPlaceholders）。
  const leftover = rendered
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => [...line.matchAll(/__SP_[A-Z_]+__/g)].map((match) => match[0]));
  if (leftover.length > 0) {
    fail(`模板里还有未替换的占位符：${[...new Set(leftover)].join(', ')}（请更新 scripts/proxy-config.mjs）`);
  }

  const header = [
    `# 由 scripts/proxy-config.mjs 生成 —— 拓扑：${topologyName}（${topology.summary}）`,
    `# 站点：${domain}   listen：${listenSpec}   协议：${edgeProto}`,
    `# 上游：web=${webUpstream}  api=${apiUpstream}`,
    '#',
    ...topology.notes.map((note) => `# ${note}`),
    '#',
    ...warnings.map((warning) => `# ⚠️  ${warning}`),
    ...(Object.values(resolved).length > 0
      ? [
          '#',
          `# CDN 回源段来源：${Object.entries(resolved)
            .map(([name, entry]) => `${name}=${entry.origin}(${entry.cidrs.length})`)
            .join(' ')}`,
        ]
      : []),
    '#',
    '# 落盘后：nginx -t && nginx -s reload',
    `# 再跑：node scripts/proxy-verify.mjs --base ${edgeProto === 'https' ? 'https' : 'http'}://${domain}`,
    '',
  ].join('\n');

  const output = header + rendered;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          topology: topologyName,
          domain,
          listen: listenSpec,
          edgeProto,
          webUpstream,
          apiUpstream,
          warnings,
          cdn: Object.fromEntries(
            Object.entries(resolved).map(([name, entry]) => [
              name,
              { origin: entry.origin, count: entry.cidrs.length },
            ]),
          ),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (typeof args.out === 'string') {
    mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    writeFileSync(path.resolve(args.out), output);
    console.error(`已写入 ${path.resolve(args.out)}`);
    if (topologyName !== 'same-host' && resolved && Object.keys(resolved).length === 0) {
      // 只在 stderr 提示，不阻断：生成的配置仍可用，只是真实 IP 会失真。
      console.error('提示：本次没有展开任何 CDN 段，真实客户端 IP 可能失真（见文件内注释）。');
    }
    return;
  }
  process.stdout.write(output);
}

await main();
