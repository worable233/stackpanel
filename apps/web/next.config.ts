import path from 'node:path';
import type { NextConfig } from 'next';

function getApiStyleOrigin(): string {
  try {
    const url = new URL(process.env.API_BASE_URL ?? 'http://127.0.0.1:3001');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

const apiStyleOrigin = getApiStyleOrigin();

const nextConfig: NextConfig = {
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
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:${apiStyleOrigin ? ` ${apiStyleOrigin}` : ''}; font-src 'self' data:; style-src 'self' 'unsafe-inline'${apiStyleOrigin ? ` ${apiStyleOrigin}` : ''}; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== 'production' ? " 'unsafe-eval'" : ''}; connect-src 'self'${apiStyleOrigin ? ` ${apiStyleOrigin}` : ''}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
