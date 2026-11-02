/**
 * 反代自检 —— 把「配置对不对」从猜症状变成一条命令/一个后台面板。
 *
 * 为什么会存在：0.1.x 的线上事故里，四条里有三条的症状都伪装成了别的问题
 *
 *   - `X-Forwarded-Proto` 没透传 → 后台 POST 403「请求来源无效」（页面完全正常）
 *   - 反代网段未被信任           → 全员共用一个 IP，整站被限流
 *   - `X-Forwarded-Proto`/Host 错配 → 同源判定失败（同第一条）
 *
 * 运维看到的是「保存设置失败」，能想到的方向是权限、数据库、插件 —— 没人会想到是
 * 反代的头。所以这里把「内核实际看到的对端、头、判定结果」全部摊开，并给出可执行
 * 的修复文案。
 *
 * **判定逻辑只有一份**：同源结论直接调 `@stackpanel/sdk` 的 `checkOrigin`，
 * 与 Web BFF 用的是同一个函数。两处各写一份就会出现「诊断说通过、真实请求 403」。
 */
import type { FastifyRequest } from 'fastify';
import { checkOrigin } from '@stackpanel/sdk';

/** 一条自检结论。`ok=false` 的项会进 `warnings` 的可执行文案。 */
export interface ProxyCheckItem {
  id: string;
  ok: boolean;
  /** 一行现状（已脱敏，可安全贴进工单）。 */
  detail: string;
  /** 不 ok 时给出**可执行**的修复动作；ok 时省略。 */
  fix?: string;
  /** 对应的部署文档锚点（`docs/DEPLOY-REVERSE-PROXY.md#…`）。 */
  doc?: string;
}

export interface ProxyCheckReport {
  /** 全部项都 ok。仅作汇总，不要用它单独判断（看 items）。 */
  ok: boolean;
  /** 内核实际看到的对端地址（`request.ip`，受 `trustProxy` 影响）。 */
  peer: string;
  /** 内核相信的客户端地址。 */
  clientIp: string;
  /** 反代报的协议（`X-Forwarded-Proto`）；`null` = 没报。 */
  forwardedProto: string | null;
  /** 反代报的 host（`X-Forwarded-Host` / `Host`）。 */
  forwardedHost: string | null;
  /** `X-Forwarded-For` 原始值（已截断）。 */
  forwardedFor: string | null;
  /** 当前生效的 `API_TRUST_PROXY` 归一化值。 */
  trustProxy: string;
  /** 同源判定的逐项分解（与 Web BFF 同一实现）。 */
  originGuard: ReturnType<typeof checkOrigin>;
  /** 同源判定是否会通过 —— 与真实请求的行为一致。 */
  originGuardWouldPass: boolean;
  items: ProxyCheckItem[];
  warnings: string[];
}

export interface ProxyCheckInput {
  request: FastifyRequest;
  /** `describeTrustProxy()` 的结果，避免这里重复解析 env。 */
  trustProxy: string;
  /** 对外公开地址（`STACKPANEL_PUBLIC_URL`）；用于判断协议是否一致。 */
  publicUrl: string | null;
  /**
   * 生成一个"同源写请求"的探测 `Origin`。
   *
   * 没有浏览器参与时不可能有真的 `Origin`，所以要构造一个「如果浏览器从公网域名
   * 打开页面、发一个写请求时会带什么」。用 `publicUrl` 的 scheme + 请求自己的 host。
   */
  probeOrigin: string;
}

const DOC = 'docs/DEPLOY-REVERSE-PROXY.md';

/** `X-Forwarded-For` 只保留前 3 段，避免把整条链塞进响应与日志。 */
function clipForwardedFor(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value.join(', ') : value;
  const parts = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(0, 3).join(', ') + (parts.length > 3 ? `, …(+${parts.length - 3})` : '');
}

function single(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? (value[0] ?? null) : value;
  return raw === null || raw.trim() === '' ? null : raw.trim();
}

/**
 * 判定「真实 IP 是否生效」。
 *
 * 只比 `request.ip` 与 `request.socket.remoteAddress`：两者相同说明内核**没有**
 * 采信 `X-Forwarded-For`（要么没配 trustProxy，要么对端不在信任网段里）。这不是
 * 绝对的错误 —— 直连部署（没有反代）本来就该相等 —— 所以只在「报了 XFF 却不采信」
 * 时才判失败，那才是真正的配置问题。
 */
export function readProxyCheck(input: ProxyCheckInput): ProxyCheckReport {
  const { request, trustProxy, publicUrl, probeOrigin } = input;
  const headers = request.headers;
  const peer = request.socket.remoteAddress ?? 'unknown';
  const clientIp = request.ip ?? peer;
  const forwardedProto = single(headers['x-forwarded-proto']);
  const forwardedHost =
    single(headers['x-forwarded-host']) ?? single(headers['host']) ?? null;
  const forwardedFor = clipForwardedFor(headers['x-forwarded-for']);

  const originGuard = checkOrigin({ headers: headers as Record<string, string | undefined> });

  // 用构造出来的「浏览器真实写请求」再判定一次：诊断请求自己可能是不带 Origin 的
  // curl，直接拿它判定永远失败，那会把「curl 没有 Origin」误报成「反代配错了」。
  const syntheticGuard = checkOrigin({
    headers: {
      origin: probeOrigin,
      host: forwardedHost ?? '',
      'x-forwarded-host': forwardedHost ?? undefined,
      'x-forwarded-proto': forwardedProto ?? undefined,
    },
  });

  const items: ProxyCheckItem[] = [];

  // ---- 1. 协议透传 ------------------------------------------------------
  const publicProto = publicUrl ? (() => {
    try {
      return new URL(publicUrl).protocol.replace(/:$/, '');
    } catch {
      return null;
    }
  })() : null;

  const protoOk = (() => {
    // 没报协议：直连或同机反代不设这个头也能工作（同源判定不因它拒绝）。
    if (forwardedProto === null) return true;
    // 报了就要和对外地址一致；没配 publicUrl 时无法判断，按通过处理。
    if (publicProto === null) return true;
    return forwardedProto === publicProto;
  })();
  items.push({
    id: 'proto',
    ok: protoOk,
    detail:
      forwardedProto === null
        ? '反代没有发送 X-Forwarded-Proto'
        : `X-Forwarded-Proto=${forwardedProto}${publicProto ? `，对外地址是 ${publicProto}` : ''}`,
    ...(protoOk
      ? {}
      : {
          fix:
            `反代把协议写成了 ${forwardedProto}，但访客看到的是 ${publicProto}。` +
            '不要用 nginx 的 $scheme（CDN/面板终止 TLS 后回源是 http，它永远错）。' +
            '改用 map 优先透传上游的头：map $http_x_forwarded_proto $sp_forwarded_proto ' +
            '{ default $http_x_forwarded_proto; \'\' https; }，再 proxy_set_header ' +
            'X-Forwarded-Proto $sp_forwarded_proto;',
          doc: `${DOC}#症状-2`,
        }),
  });

  // ---- 2. 真实 IP -------------------------------------------------------
  const xffPresent = forwardedFor !== null;
  const clientIpApplied = clientIp !== peer;
  // 只有「报了 XFF 却没采信」才是配置错误；直连部署里两者相等是正常的。
  const realIpOk = !xffPresent || clientIpApplied;
  items.push({
    id: 'realIp',
    ok: realIpOk,
    detail: xffPresent
      ? `X-Forwarded-For=${forwardedFor}；内核采信的客户端 IP=${clientIp}，对端=${peer}`
      : `没有 X-Forwarded-For；客户端 IP=${clientIp}，对端=${peer}`,
    ...(realIpOk
      ? {}
      : {
          fix:
            `反代报了 X-Forwarded-For，但内核没有采信（仍认为是 ${peer}）。` +
            `当前 API_TRUST_PROXY=${trustProxy}。把反代所在网段加进去，例如 ` +
            'API_TRUST_PROXY=loopback,linklocal,uniquelocal,172.18.0.0/16；' +
            '前面还有 CDN 时同时配 set_real_ip_from。不修的话所有访客共用一个 IP，' +
            '按 IP 的限流、验证码冷却、封禁、审计全部失真。',
          doc: `${DOC}#症状-3`,
        }),
  });

  // ---- 3. 同源判定（与 Web BFF 同一实现）--------------------------------
  items.push({
    id: 'originGuard',
    ok: syntheticGuard.passes,
    detail: syntheticGuard.passes
      ? `用 ${probeOrigin} + host=${forwardedHost ?? '(无)'} 判定：通过`
      : `用 ${probeOrigin} + host=${forwardedHost ?? '(无)'} 判定：不通过` +
        `（host 匹配=${syntheticGuard.hostMatches}，协议匹配=${syntheticGuard.protoMatches}）`,
    ...(syntheticGuard.passes
      ? {}
      : {
          fix:
            !syntheticGuard.hostMatches
              ? `反代没有正确设置 Host / X-Forwarded-Host（浏览器看到的是 ${probeOrigin}）。` +
                '加上 proxy_set_header Host $host; 与 proxy_set_header X-Forwarded-Host $host;'
              : `协议不匹配：浏览器 Origin 是 ${syntheticGuard.originProto}，反代报的是 ` +
                `${syntheticGuard.forwardedProto ?? '(未报)'}。修 X-Forwarded-Proto（见上一项）。` +
                '这一项不修，后台所有 POST 都会 403「请求来源无效」。',
          doc: `${DOC}#症状-2`,
        }),
  });

  // ---- 4. 前缀路由（前缀是否被面板吞掉）---------------------------------
  // 内核无法直接观测反代的路由表，但能观测「这个请求是不是从预期路径进来的」。
  // 真正的断言矩阵由 `scripts/proxy-verify.mjs` 跑（它从外部打所有前缀）。
  items.push({
    id: 'route',
    ok: true,
    detail: `当前请求 ${request.method} ${request.url} 到达了内核，说明至少有一条前缀路由可用`,
    // 提示而不判失败：单条请求命中不能证明其余前缀都对。
  });

  const warnings = items
    .filter((item) => !item.ok)
    .map((item) => `${item.detail} → ${item.fix ?? '见部署文档'}${item.doc ? `（${item.doc}）` : ''}`);

  return {
    ok: items.every((item) => item.ok),
    peer,
    clientIp,
    forwardedProto,
    forwardedHost,
    forwardedFor,
    trustProxy,
    originGuard,
    originGuardWouldPass: syntheticGuard.passes,
    items,
    warnings,
  };
}

/**
 * `/ready` 里那一段**精简**的反代自检。
 *
 * 为什么放进 `/ready`：面板的健康检查、容器编排的探针、同机 `curl` 都能看到它，
 * 不需要管理员登录。这是「一眼看出反代配错」的最低成本入口 —— 详细版在
 * `/api/v1/system/proxy-check`（需要管理员，会给出修复文案）。
 */
export interface ProxyHealth {
  /** 内核是否采信了反代的真实 IP（`request.ip` 与对端不同）。 */
  trusted: boolean;
  clientIp: string;
  peer: string;
  proto: string | null;
}

export function readProxyHealth(request: FastifyRequest): ProxyHealth {
  const peer = request.socket.remoteAddress ?? 'unknown';
  const clientIp = request.ip ?? peer;
  return {
    trusted: clientIp !== peer,
    clientIp,
    peer,
    proto: single(request.headers['x-forwarded-proto']),
  };
}
