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
  try {
    return process.env.SITE_URL ? [new URL(process.env.SITE_URL).hostname] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: publicDevOrigins(),
  // Spike hook (runtime-frontend-loading, Stage 1): allow the throwaway harness
  // to build into a sibling distDir so it never fights the running dev server's
  // `.next`. Unset in normal runs, so production is unaffected.
  distDir: process.env.NEXT_SPIKE_DIST_DIR ?? '.next',
  turbopack: {
    root: path.join(__dirname, '../..'),
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
    return [{ source: '/media/:path*', destination: `${api}/media/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
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
