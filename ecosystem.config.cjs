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
        NODE_ENV: 'development',
        STACKPANEL_DATA_DIR: DATA_DIR,
      },
      out_file: '../../logs/api-out.log',
      error_file: '../../logs/api-error.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'stackpanel-web',
      cwd: __dirname,
      script: './scripts/frontend-supervisor.mjs',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        STACKPANEL_DATA_DIR: DATA_DIR,
        STACKPANEL_FRONTEND_AUTOBUILD: process.env.STACKPANEL_FRONTEND_AUTOBUILD || '1',
      },
      out_file: '../../logs/web-out.log',
      error_file: '../../logs/web-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
