import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Next blocks cross-origin requests to dev-only endpoints (`/_next/*`, HMR
 * websocket) unless the requesting host is allowlisted. When the dev server is
 * reached through the public tunnel, the browser origin is the tunnel host (see
 * `SITE_URL`) rather than `localhost`, so HMR would otherwise be refused. This is
 * dev-only: Next ignores `allowedDevOrigins` in production, and an unset/invalid
 * `SITE_URL` simply yields an empty allowlist.
 */
function publicDevOrigins(): string[] {
  const origins = ['localhost', '127.0.0.1'];
  try {
    if (process.env.SITE_URL) origins.push(new URL(process.env.SITE_URL).hostname);
  } catch {
    // Keep the local development origins above when SITE_URL is unset or invalid.
  }
  return [...new Set(origins)];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: publicDevOrigins(),
  /**
   * Emit a self-contained server bundle (`.next/standalone`) so a kernel
   * artifact can be shipped and run without a full `node_modules` tree
   * (ADR-0025). This only affects `next build`; `next dev` is unchanged.
   */
  output: 'standalone',
  /**
   * Monorepo root for dependency tracing. Without this Next walks up from
   * `apps/web` and fails to include the workspace packages (`@stackpanel/*`)
   * that the server bundle imports at runtime.
   */
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Spike hook (runtime-frontend-loading, Stage 1): allow the throwaway harness
  // to build into a sibling distDir so it never fights the running dev server's
  // `.next`. Unset in normal runs, so production is unaffected.
  distDir: process.env.NEXT_SPIKE_DIST_DIR ?? '.next',
  turbopack: {
    root: path.join(__dirname, '../..'),
  },
  /**
   * 按需编译 workspace 里的 UI 包。
   *
   * `@stackpanel/ui` 是单一入口桶（101 个导出），其中 `MetricsExplorer` 依赖
   * recharts。没有这条配置时，打包器会把整个桶当一个模块处理 —— 任何页面
   * `import { Button } from '@stackpanel/ui'` 都会把 recharts(647KB)、
   * zod(911KB)、lucide(359KB) 拖进首屏 chunk。
   *
   * 实测（本地，gzip 后）：`/login` 首屏 **1028 KB / 31 个请求**。
   * 按 4G 一般网络（5 Mbps / RTT 100ms）估算首屏 ≈ 1.9s，3G ≈ 6s。
   * 这才是"页面加载慢"的主因 —— 服务端渲染只要 46ms。
   *
   * 开启后 Next 把 `import { X } from '@stackpanel/ui'` 改写成
   * `import X from '@stackpanel/ui/X'` 的按需形式，未使用的导出不再打包。
   */
  experimental: {
    optimizePackageImports: ['@stackpanel/ui'],
  },
  /**
   * Kernel media URLs are same-origin paths (`/media/<id>/content`) returned by
   * the API and rendered by plugin frontends. Under the bundled Caddy profile
   * `/media/*` is proxied to the API, but a plain `http://host:3000` deployment
   * (no reverse proxy) has no such route on the web origin, so every image
   * 404s. Proxying here makes the default deployment behave the same without
   * requiring Caddy. The destination is a fixed server-side base URL, never
   * user-controlled.
   */
  async rewrites() {
    const api = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
    // 内核对外的 `/media` 直链（头像以外的媒体上传/对象存储回源）。
    //
    // 单端口模式（`STACKPANEL_SINGLE_PORT=1`）**不在这里**实现：`rewrites()` 在
    // `next build` 时就把结果内联进 `.next/routes-manifest.json`，运行时再设环境
    // 变量完全没有效果（实测：镜像里 manifest 只有这一条）。那个模式在
    // `src/proxy.ts` 的 middleware 里做，见 `src/lib/single-port.ts`。
    return [{ source: '/media/:path*', destination: `${api}/media/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // HSTS (security audit M-2); ignored over plaintext.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Content-Security-Policy is owned by `src/proxy.ts`, which emits a
          // per-request nonce (security audit L-2). Setting it here
          // too would create a second, stricter-by-merge policy and undo the
          // nonce, so it deliberately lives in the proxy only.
        ],
      },
    ];
  },
};

export default nextConfig;
