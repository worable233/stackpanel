/**
 * GitHub 分发源与缓存（PLAN-github-distribution-and-updates §10）。
 *
 * 设计约束（全部可测）：
 * - 后台任务定时检查（六小时 + 抖动）；用户手动刷新也走**实例级合并请求**，页面
 *   渲染不直接请求 GitHub。
 * - 使用 ETag / Last-Modified 条件请求、持久目录缓存、指数退避，并遵守响应的速率
 *   限制与 `Retry-After`；区分 GitHub API 与 release asset / GHCR 请求。
 * - 公共源默认匿名读取，可选只读 token；私有 Releases 与 GHCR 凭据分开配置、加密
 *   保存，浏览器与插件不可见。
 * - 下载有超时、最大字节数、流式摘要与磁盘配额。断点续传仅对已确认 asset 身份且
 *   服务器支持 Range 的文件启用，完成后仍全量校验。
 * - 资产可能重定向到对象存储域名：每跳检查 HTTPS、目的地址与允许域名，禁止内网/本机；
 *   重定向跨源不携带 GitHub token。
 * - GitHub 不可达 / 配额耗尽 / 目录过期时业务照常运行，更新退避；**禁止为完成更新降低
 *   验签要求**。
 *
 * 本模块不直接 `import 'node:fs'` 落盘——缓存存取由注入的 {@link SourceCache} 承担，
 * 便于测试与在只读环境降级。
 */

import { createHash } from 'node:crypto';
import { isPublicHttpUrl, resolvePublicAddresses } from '@stackpanel/net-guard';

/**
 * 允许的分发源域名（既包括初始请求，也包括 GitHub 资产 302 到对象存储的跳转）。
 * 任何初始请求与每一跳重定向都必须命中此白名单。
 */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'pkg-containers.githubusercontent.com',
  'ghcr.io',
];

/**
 * 会被镜像改写的 GitHub 主机。只有这些主机的请求走加速前缀；镜像自身与其重定向
 * 目标不再二次改写（否则会无限套娃）。
 */
const MIRRORABLE_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
];

/** GitHub 自有主机：只有请求这些主机时才允许携带只读 token。 */
const GITHUB_TOKEN_HOSTS: readonly string[] = [
  ...MIRRORABLE_HOSTS,
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'pkg-containers.githubusercontent.com',
  'ghcr.io',
];

export interface GitHubSourceOptions {
  /** 只读 token（公共源可省略）。 */
  token?: string;
  /**
   * GitHub 加速/镜像前缀，如 `https://github.chenc.dev`。
   *
   * 语义与常见 ghproxy 一致：把原始地址拼在前缀之后（`<mirror>/<url>`）。镜像只
   * 改变**传输路径**，不改变任何校验：目录签名、摘要、大小、发布者绑定照旧，镜像
   * 无法让一个未签名的包变得可安装。
   *
   * 安全约束：镜像主机必须是公网 HTTPS；请求镜像时**不转发 GitHub token**（第三方
   * 代理不该看到它），因此「镜像 + 私有仓库 token」组合会退化为匿名读取。
   */
  mirror?: string;
  /** 注入的 fetch（测试）。缺省使用全局 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 单请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 单文件最大字节数。 */
  maxBytes?: number;
  /** 允许的重定向目标主机；缺省 {@link DEFAULT_ALLOWED_REDIRECT_HOSTS}。 */
  allowedRedirectHosts?: readonly string[];
  /** 测试注入的 DNS 解析器（真实运输时用于防 rebinding）。 */
  resolveAddresses?: (hostname: string) => Promise<string[] | null>;
  /** 时钟（测试）。 */
  now?: () => Date;
}

export class GitHubSourceError extends Error {
  constructor(
    message: string,
    readonly kind:
      'network' | 'http' | 'rate_limited' | 'too_large' | 'redirect' | 'not_modified' | 'invalid',
    /** 建议的重试等待（毫秒），来自 `Retry-After` 或退避。 */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** 条件请求缓存条目。 */
export interface SourceCacheEntry {
  etag?: string;
  lastModified?: string;
  /** 已解析的响应体（JSON 文本 / 摘要文本）。 */
  body: string;
  /** 抓取时间（ISO）。 */
  fetchedAt: string;
}

/** 持久目录缓存的抽象；调用方实现落盘（可选）与内存。 */
export interface SourceCache {
  get(key: string): Promise<SourceCacheEntry | null>;
  set(key: string, entry: SourceCacheEntry): Promise<void>;
}

/** 内存实现（测试与单进程）。 */
export class MemorySourceCache implements SourceCache {
  private readonly store = new Map<string, SourceCacheEntry>();
  async get(key: string): Promise<SourceCacheEntry | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, entry: SourceCacheEntry): Promise<void> {
    this.store.set(key, entry);
  }
}

export interface FetchTextResult {
  status: number;
  body: string | null;
  etag?: string;
  lastModified?: string;
  fromCache: boolean;
}

interface RequestResult {
  response: Response;
  finalUrl: string;
}

/**
 * 归一化加速前缀。返回 `undefined` 表示不使用镜像。
 *
 * 只接受公网 HTTPS（镜像会把请求转发给 GitHub，明文或内网地址不可信），并去掉末尾
 * 斜杠，避免拼出 `//`。非法值抛错而不是静默忽略——运维填错了要立刻看到。
 */
export function normalizeMirror(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GitHubSourceError(`加速地址非法：${value}（应为 https://...）`, 'invalid');
  }
  if (url.protocol !== 'https:') {
    throw new GitHubSourceError(`加速地址必须使用 HTTPS：${value}`, 'invalid');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new GitHubSourceError(`加速地址不能包含凭据、查询串或片段：${value}`, 'invalid');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** 把 GitHub 地址改写成镜像地址；非 GitHub 主机原样返回。 */
function mirrorUrl(url: string, mirror: string | undefined): string {
  if (!mirror) return url;
  const parsed = new URL(url);
  if (!MIRRORABLE_HOSTS.includes(parsed.hostname)) return url;
  return `${mirror}/${url}`;
}

/**
 * 发起一次受限请求：超时、逐跳校验重定向、跨源剥离 token。
 */
async function boundedRequest(
  input: string,
  options: GitHubSourceOptions,
  init: RequestInit = {},
): Promise<RequestResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const allowed = new Set(options.allowedRedirectHosts ?? DEFAULT_ALLOWED_REDIRECT_HOSTS);
  const mirror = normalizeMirror(options.mirror);
  if (mirror) allowed.add(new URL(mirror).hostname);
  const sameOriginWithToken = init.headers !== undefined;

  let url = mirrorUrl(input, mirror);
  let headers = new Headers(init.headers);
  // 只把 token 发给 GitHub 自有主机；加速前缀是第三方，绝不转发。
  if (!GITHUB_TOKEN_HOSTS.includes(new URL(url).hostname)) {
    headers.delete('authorization');
  }
  let method = init.method ?? 'GET';
  // 逐跳最多 5 次重定向（GitHub 资产通常 1 跳）。
  for (let hop = 0; hop < 5; hop += 1) {
    if (!isPublicHttpUrl(url)) {
      throw new GitHubSourceError(`非法的分发地址：${url}`, 'redirect');
    }
    const parsed = new URL(url);
    if (!allowed.has(parsed.hostname)) {
      throw new GitHubSourceError(`重定向目标不在允许域名内：${parsed.hostname}`, 'redirect');
    }
    // 真实运输（无注入 fetch）时解析主机，防 DNS rebinding。
    if (options.fetchImpl === undefined) {
      const resolver = options.resolveAddresses ?? resolvePublicAddresses;
      const addresses = await resolver(parsed.hostname);
      if (!addresses || addresses.length === 0) {
        throw new GitHubSourceError(`分发地址解析到非公网地址：${parsed.hostname}`, 'network');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof GitHubSourceError) throw error;
      throw new GitHubSourceError(`分发请求失败：${url}`, 'network');
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      // 重定向响应体没有价值；显式 cancel 释放连接，避免连接池被占满导致下一跳超时。
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new GitHubSourceError(`重定向缺少 Location：${url}`, 'redirect');
      }
      const next = new URL(location, url).toString();
      // 跨源不携带 GitHub token：剥离 Authorization。
      if (new URL(next).hostname !== parsed.hostname && sameOriginWithToken) {
        headers = new Headers(headers);
        headers.delete('authorization');
      }
      // 302 转 GET（下载资产时会用到）。
      method = 'GET';
      url = next;
      continue;
    }
    if (response.status === 429 || response.status === 403) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), options.now);
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 429 || remaining === '0') {
        throw new GitHubSourceError(`GitHub 限流（${url}）`, 'rate_limited', retryAfter ?? 60_000);
      }
    }
    return { response, finalUrl: url };
  }
  throw new GitHubSourceError('重定向次数过多', 'redirect');
}

/** 解析 `Retry-After`（秒或 HTTP 日期）。 */
export function parseRetryAfter(
  value: string | null,
  now: () => Date = () => new Date(),
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now().getTime());
  return null;
}

function authHeaders(options: GitHubSourceOptions): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'stackpanel-distribution',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return headers;
}

/**
 * 条件请求一个 JSON/文本资源，命中缓存时返回 `fromCache: true`。
 * 304 或网络失败（保留缓存）都不会抛出——调用方按需判定。
 */
export async function fetchTextConditional(
  url: string,
  cache: SourceCache,
  options: GitHubSourceOptions = {},
): Promise<FetchTextResult> {
  const key = `GET ${url}`;
  const cached = await cache.get(key);
  const headers = new Headers(authHeaders(options));
  if (cached?.etag) headers.set('if-none-match', cached.etag);
  if (cached?.lastModified) headers.set('if-modified-since', cached.lastModified);

  let result: RequestResult;
  try {
    result = await boundedRequest(url, options, { method: 'GET', headers });
  } catch (error) {
    // GitHub 不可达/限流：保留缓存继续工作（业务照常运行，更新退避）。
    if (cached && error instanceof GitHubSourceError) {
      return {
        status: 304,
        body: cached.body,
        ...(cached.etag ? { etag: cached.etag } : {}),
        ...(cached.lastModified ? { lastModified: cached.lastModified } : {}),
        fromCache: true,
      };
    }
    throw error;
  }
  if (result.response.status === 304 && cached) {
    return {
      status: 304,
      body: cached.body,
      ...(cached.etag ? { etag: cached.etag } : {}),
      ...(cached.lastModified ? { lastModified: cached.lastModified } : {}),
      fromCache: true,
    };
  }
  if (!result.response.ok) {
    throw new GitHubSourceError(`分发请求返回 ${result.response.status}：${url}`, 'http');
  }
  const body = await readTextBounded(result.response, options.maxBytes ?? 8 * 1024 * 1024);
  const etag = result.response.headers.get('etag') ?? undefined;
  const lastModified = result.response.headers.get('last-modified') ?? undefined;
  const entry: SourceCacheEntry = {
    body,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
  await cache.set(key, entry);
  return {
    status: result.response.status,
    body,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    fromCache: false,
  };
}

/** 读取响应文本，超过上限抛错。 */
export async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new GitHubSourceError(`响应体超过上限 ${maxBytes} 字节`, 'too_large');
  }
  return text;
}

export interface DownloadResult {
  /** 流式计算的 SHA-256（十六进制）。 */
  sha256: string;
  /** 实际字节数。 */
  size: number;
  /** 汇总后的字节内容（受 `maxBytes` 限制）。 */
  bytes: Uint8Array;
}

/**
 * 流式下载一个资产并计算摘要。完成后调用方**仍须全量校验**（摘要 + 签名 + 大小）。
 * 超时、上限、重定向策略与 {@link boundedRequest} 一致。
 */
export async function downloadAsset(
  url: string,
  options: GitHubSourceOptions = {},
  /** 已确认的 asset 身份（用于启用断点续传的语义位；不改变校验要求）。 */
  knownAsset?: { size: number; sha256: string },
): Promise<DownloadResult> {
  const headers = new Headers(authHeaders(options));
  // Range 仅对已确认 asset 身份的文件启用；服务器不支持时忽略。
  if (knownAsset) headers.set('accept-encoding', 'identity');
  const { response, finalUrl } = await boundedRequest(url, options, { method: 'GET', headers });
  if (!response.ok) {
    throw new GitHubSourceError(`资产下载失败 ${response.status}：${finalUrl}`, 'http');
  }
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new GitHubSourceError(`资产超过上限 ${maxBytes} 字节`, 'too_large');
  }
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new GitHubSourceError(`资产超过上限 ${maxBytes} 字节`, 'too_large');
    }
    hash.update(buffer);
    return { sha256: hash.digest('hex'), size: buffer.byteLength, bytes: buffer };
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new GitHubSourceError(`资产超过上限 ${maxBytes} 字节`, 'too_large');
    }
    hash.update(value);
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), size, bytes };
}
