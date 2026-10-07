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
  turbopack: {
    root: path.join(__dirname, '../..'),
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
          // HSTS (SECURITY-AUDIT-2026-10-04 M-2); ignored over plaintext.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Content-Security-Policy is owned by `src/proxy.ts`, which emits a
          // per-request nonce (SECURITY-AUDIT-2026-10-04 L-2). Setting it here
          // too would create a second, stricter-by-merge policy and undo the
          // nonce, so it deliberately lives in the proxy only.
        ],
      },
    ];
  },
};

export default nextConfig;
