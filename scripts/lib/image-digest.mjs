#!/usr/bin/env node
/**
 * 取镜像**清单索引**（multi-arch manifest list）的摘要，不下载任何层。
 *
 * 为什么需要它：`cosign sign` 签的是清单索引的摘要，而
 *   - `docker buildx imagetools inspect` 能直接给，但很多机器没装 buildx 插件；
 *   - `docker manifest inspect --verbose` 给的是**平台清单**摘要，拿它去验签只会得到
 *     「no signatures found」，看着像镜像没签名，其实是验错了对象；
 *   - `docker image inspect` 的 RepoDigests 只在本地已拉取时才有。
 *
 * 所以这里直接问 registry：带 `Accept: …index.v1+json` 发 GET，读响应头
 * `Docker-Content-Digest`。私有包用 `docker login` 已存的凭据（config.json 的
 * `auths[host].auth`），匿名可读的包也能取到。
 *
 * 用法：
 *   node scripts/lib/image-digest.mjs ghcr.io/owner/stackpanel:1.2.3
 *   node scripts/lib/image-digest.mjs ghcr.io/owner/stackpanel   # 默认 :latest
 *
 * 输出：`sha256:...`（失败时非 0 退出，stderr 说明原因）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** `ghcr.io/o/x:1.2.3` → { host, repository, reference } */
export function parseImageRef(ref) {
  const withoutDigest = ref.split('@')[0];
  const slash = withoutDigest.indexOf('/');
  if (slash === -1) throw new Error(`不是完整的镜像引用（缺少 registry 域名）：${ref}`);
  const host = withoutDigest.slice(0, slash);
  const rest = withoutDigest.slice(slash + 1);
  const lastColon = rest.lastIndexOf(':');
  const lastSlash = rest.lastIndexOf('/');
  const hasTag = lastColon > lastSlash;
  return {
    host,
    repository: hasTag ? rest.slice(0, lastColon) : rest,
    reference: hasTag ? rest.slice(lastColon + 1) : 'latest',
  };
}

/** 读 docker 已登录的凭据（Basic auth 的 base64）。取不到返回 null。 */
function storedCredentials(host) {
  const candidates = [
    process.env.DOCKER_CONFIG,
    join(homedir(), '.docker'),
  ].filter(Boolean);
  for (const dir of candidates) {
    let raw;
    try {
      raw = readFileSync(join(dir, 'config.json'), 'utf8');
    } catch {
      continue;
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      continue;
    }
    const auths = config.auths ?? {};
    for (const [key, value] of Object.entries(auths)) {
      const authHost = key.replace(/^https?:\/\//, '').split('/')[0];
      if (authHost === host && value?.auth) return value.auth;
    }
  }
  const user = process.env.STACKPANEL_REGISTRY_USER;
  const pass = process.env.STACKPANEL_REGISTRY_PASSWORD;
  if (user && pass) return Buffer.from(`${user}:${pass}`).toString('base64');
  return null;
}

async function bearerToken(host, repository, basic) {
  const url = `https://${host}/token?service=${encodeURIComponent(host)}&scope=repository:${repository}:pull`;
  const res = await fetch(url, {
    headers: basic ? { authorization: `Basic ${basic}` } : {},
  });
  if (!res.ok) throw new Error(`取 token 失败：HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.token) throw new Error('取 token 失败：响应里没有 token');
  return body.token;
}

async function manifestDigest(host, repository, reference, token) {
  const res = await fetch(`https://${host}/v2/${repository}/manifests/${reference}`, {
    method: 'HEAD',
    headers: { accept: ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const digest = res.headers.get('docker-content-digest');
  return { status: res.status, digest };
}

async function main() {
  const ref = process.argv[2];
  if (!ref) {
    console.error('用法：node scripts/lib/image-digest.mjs <镜像引用>');
    process.exit(2);
  }
  const { host, repository, reference } = parseImageRef(ref);
  const basic = storedCredentials(host);

  // 1. 先试匿名 / 已存凭据的 Basic auth（GHCR 接受 Bearer，但部分 registry 直接收 Basic）。
  let attempt = await manifestDigest(host, repository, reference, null);
  if (!attempt.digest && basic) {
    const token = await bearerToken(host, repository, basic);
    attempt = await manifestDigest(host, repository, reference, token);
  }
  if (!attempt.digest) {
    // 2. 再走 token 交换（无凭据时也可能因包公开而成功）。
    try {
      const token = await bearerToken(host, repository, basic);
      attempt = await manifestDigest(host, repository, reference, token);
    } catch {
      /* 落到下面的报错 */
    }
  }
  if (!attempt.digest) {
    throw new Error(
      `${host}/${repository}:${reference} 未返回 Docker-Content-Digest（HTTP ${attempt.status}）；` +
        '镜像不存在、未推送，或需要 docker login（私有包）',
    );
  }
  process.stdout.write(attempt.digest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
