/**
 * PM2 process manager config.
 * Requires built artifacts: `pnpm build` (api dist + web .next).
 *
 * Both processes share a single on-disk data directory (see
 * packages/sdk/src/paths.ts). We pin STACKPANEL_DATA_DIR to an absolute path
 * here so the API and the web server can never resolve different `data/`
 * directories regardless of their individual working directories.
 */
const path = require('node:path');

const DATA_DIR = process.env.STACKPANEL_DATA_DIR || path.join(__dirname, 'data');
// PM2 must not silently run production as `development`: that would disable the
// Secure cookie default (security audit M-1) and other prod-only
// guards. Respect an explicit NODE_ENV, otherwise assume production.
const NODE_ENV = process.env.NODE_ENV || 'production';

module.exports = {
  apps: [
    {
      name: 'stackpanel-api',
      cwd: './apps/api',
      script: './dist/server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV,
        STACKPANEL_DATA_DIR: DATA_DIR,
      },
      out_file: '../../logs/api-out.log',
      error_file: '../../logs/api-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'stackpanel-web',
      cwd: path.join(__dirname, 'apps/web'),
      /**
       * `output: 'standalone'` emits `apps/web/.next/standalone/apps/web/server.js`
       * (ADR-0025). That server is self-contained: it does not consult
       * `node_modules/next` from the repo, and `next start` would not read the
       * standalone tree at all. Run the emitted entrypoint directly so the same
       * process definition works for both a checkout and a kernel artifact.
       */
      script: path.join(
        __dirname,
        'apps/web/.next/standalone/apps/web/server.js',
      ),
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV,
        STACKPANEL_DATA_DIR: DATA_DIR,
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
      },
      out_file: '../../logs/web-out.log',
      error_file: '../../logs/web-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
