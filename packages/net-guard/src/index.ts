/**
 * 内部网络防护工具（审计 M-1/M-2/M-3）。
 *
 * 判定 IP 字面量、主机名与 URL 是否指向保留/内网/回环地址，供内核与内置插件
 * 在发起出站请求前统一拦截 SSRF。纯 `node:*` 依赖，避免各处重复实现导致口径漂移。
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** IPv4 保留/内网网段，`[网络地址, 前缀位数]`。 */
const UNSAFE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10（CGNAT）
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16（链路本地 / 云元数据）
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24（TEST-NET-1）
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15（基准测试）
  [0xc6336400, 24], // 198.51.100.0/24（TEST-NET-2）
  [0xcb007100, 24], // 203.0.113.0/24（TEST-NET-3）
  [0xe0000000, 4], // 224.0.0.0/4（组播）
  [0xf0000000, 4], // 240.0.0.0/4（保留，含广播）
];

function ipv4ToInt(octets: readonly number[]): number {
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function isUnsafeV4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }
  const value = ipv4ToInt(octets);
  return UNSAFE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/** 将 IPv6 字面量（含 `::` 压缩、内嵌点分 IPv4、zone id）展开为 16 字节。 */
function parseIpv6(address: string): Uint8Array | null {
  let value = address;
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);

  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  if (!head) return null;

  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tailGroups = parseGroups(halves[1] ?? '');
    if (!tailGroups) return null;
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tailGroups];
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] ?? 0;
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function zeroRange(bytes: Uint8Array, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function embeddedV4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset] ?? 0}.${bytes[offset + 1] ?? 0}.${bytes[offset + 2] ?? 0}.${bytes[offset + 3] ?? 0}`;
}

function isUnsafeV6(bytes: Uint8Array): boolean {
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (zeroRange(bytes, 0, 15) && bytes[15] === 1) return true; // ::1
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true; // fc00::/7（ULA）
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true; // fe80::/10（链路本地）
  if (bytes[0] === 0xff) return true; // ff00::/8（组播）
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32
  // ::ffff:0:0/96（IPv4-mapped，含十六进制形式）
  if (zeroRange(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isUnsafeV4(embeddedV4(bytes, 12));
  }
  // ::/96（IPv4-compatible，已废弃）
  if (zeroRange(bytes, 0, 12)) return isUnsafeV4(embeddedV4(bytes, 12));
  // 64:ff9b::/96（NAT64）
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    zeroRange(bytes, 4, 12)
  ) {
    return isUnsafeV4(embeddedV4(bytes, 12));
  }
  // 2002::/16（6to4）
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isUnsafeV4(embeddedV4(bytes, 2));
  return false;
}

/**
 * 是否为指向保留/内网/回环等非公网地址的 IP 字面量。非 IP 输入一律视为不安全。
 */
export function isUnsafeIpAddress(address: string): boolean {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const version = isIP(normalized);
  if (version === 4) return isUnsafeV4(normalized);
  if (version === 6) {
    const bytes = parseIpv6(normalized);
    return bytes ? isUnsafeV6(bytes) : true;
  }
  return true;
}

/** 内网/特殊用途主机名后缀。 */
const UNSAFE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'] as const;

/** 主机名（不含端口）是否指向本机或内网：localhost、内网 TLD、私有 IP 字面量。 */
export function isUnsafeHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (host === 'localhost') return true;
  if (UNSAFE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return isUnsafeIpAddress(host);
  return false;
}

export interface PublicUrlOptions {
  /** 允许 `http:`；默认仅接受 `https:`。 */
  allowHttp?: boolean;
}

/**
 * 是否为可安全出站的公网 HTTP(S) URL：协议白名单、无内嵌凭证、主机非内网。
 * 注意：这只校验字面量/主机名，DNS 解析到内网需另行用 {@link resolvesToUnsafeAddress}。
 */
export function isPublicHttpUrl(value: string, options: PublicUrlOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const schemeAllowed =
    url.protocol === 'https:' || (options.allowHttp === true && url.protocol === 'http:');
  if (!schemeAllowed) return false;
  if (url.username !== '' || url.password !== '') return false;
  return !isUnsafeHostname(url.hostname);
}

/**
 * 主机名解析后是否包含内网地址（防 DNS rebinding）。解析失败返回 `false`，交由
 * 传输层暴露不可达；调用方如需「解析失败即拒绝」可自行处理。
 */
export async function resolvesToUnsafeAddress(hostname: string): Promise<boolean> {
  if (isUnsafeHostname(hostname)) return true;
  // IP 字面量无需 DNS：`isUnsafeHostname` 已按其字面量判定，到达此处即为安全公网
  // 地址。跳过 `dns.lookup` 可避免占用解析线程池（同时也让测试不依赖外部 DNS）。
  const literal = hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0) return false;
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return true;
    return addresses.some((entry) => isUnsafeIpAddress(entry.address));
  } catch {
    return false;
  }
}
