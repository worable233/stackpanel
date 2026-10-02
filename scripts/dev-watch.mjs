#!/usr/bin/env node
/**
 * StackPanel development watch.
 *
 * Watches plugin/theme source trees and hot-rebuilds them:
 *  - backend plugin src  -> rebuild that plugin's dist (tsc)
 *  - frontend src        -> rebuild all frontend packages + registry (build:frontend)
 *
 * After a rebuild it restarts the API process (tsx) so the kernel re-seeds the
 * built-in plugin and re-registers the updated definition. In production you
 * would instead upload a new package through the admin API.
 *
 * Usage: node scripts/dev-watch.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import chokidar from 'chokidar';

const require = createRequire(import.meta.url);
const root = process.cwd();

const PLUGINS_SRC = path.join(root, 'packages', 'plugins');
const THEMES_SRC = path.join(root, 'packages', 'themes');

/** Directories whose changes trigger a rebuild. */
const WATCH_GLOBS = [
  'packages/plugins/*/src/**/*.{ts,tsx,js,mjs}',
  'packages/plugins/*/frontend/src/**/*.{ts,tsx}',
  'packages/plugins/*/frontend/package.json',
  'packages/themes/*/frontend/src/**/*.{ts,tsx}',
  'packages/themes/*/frontend/package.json',
];

let apiProcess = null;
let restartTimer = null;
let pending = new Set();

function startApi() {
  if (apiProcess) apiProcess.kill('SIGTERM');
  console.log('[dev-watch] Starting API (tsx watch src/server.ts)…');
  apiProcess = spawn('pnpm', ['--filter', '@stackpanel/api', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  apiProcess.on('exit', (code) => {
    if (code !== null && code !== 0 && code !== 143) {
      console.warn(`[dev-watch] API exited with code ${code}`);
    }
    apiProcess = null;
  });
}

function restartApi(reason) {
  console.log(`[dev-watch] Change detected: ${reason}`);
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    startApi();
    restartTimer = null;
  }, 300);
}

async function rebuildPluginBackend(pluginId) {
  const pluginDir = path.join(PLUGINS_SRC, pluginId);
  const tsconfig = path.join(pluginDir, 'tsconfig.build.json');
  if (!existsSync(tsconfig)) {
    console.warn(`[dev-watch] No tsconfig.build.json for ${pluginId}; skipping backend rebuild`);
    return;
  }
  console.log(`[dev-watch] Rebuilding backend for ${pluginId}…`);
  execFileSync('pnpm', ['--filter', `@stackpanel/plugin-${pluginId}`, 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
}

async function rebuildFrontend() {
  console.log('[dev-watch] Rebuilding frontend packages + registry…');
  execFileSync('pnpm', ['build:frontend'], { cwd: root, stdio: 'inherit' });
}

async function run() {
  console.log('[dev-watch] Watching plugin/theme sources…');
  startApi();

  const watcher = chokidar.watch(WATCH_GLOBS, {
    cwd: root,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
  });

  const onBackendChange = async (filePath) => {
    const match = /^packages\/plugins\/([^/]+)\/src\//.exec(filePath);
    if (!match) return;
    const pluginId = match[1];
    if (pending.has(`backend:${pluginId}`)) return;
    pending.add(`backend:${pluginId}`);
    try {
      await rebuildPluginBackend(pluginId);
    } catch (err) {
      console.error(`[dev-watch] Backend rebuild failed for ${pluginId}:`, err.message);
    } finally {
      pending.delete(`backend:${pluginId}`);
    }
    restartApi(`backend ${pluginId}`);
  };

  const onFrontendChange = async (filePath) => {
    if (pending.has('frontend')) return;
    pending.add('frontend');
    try {
      await rebuildFrontend();
    } catch (err) {
      console.error('[dev-watch] Frontend rebuild failed:', err.message);
    } finally {
      pending.delete('frontend');
    }
    restartApi('frontend');
  };

  watcher.on('change', (filePath) => {
    if (/^packages\/plugins\/[^/]+\/src\//.test(filePath)) void onBackendChange(filePath);
    else if (
      /^packages\/(plugins|themes)\/[^/]+\/frontend\//.test(filePath) ||
      /^packages\/plugins\/[^/]+\/frontend\/package.json$/.test(filePath)
    ) {
      void onFrontendChange(filePath);
    }
  });
  watcher.on('add', (filePath) => {
    if (/^packages\/plugins\/[^/]+\/src\//.test(filePath)) void onBackendChange(filePath);
    else if (/^packages\/(plugins|themes)\/[^/]+\/frontend\//.test(filePath)) {
      void onFrontendChange(filePath);
    }
  });

  const shutdown = () => {
    if (apiProcess) apiProcess.kill('SIGTERM');
    void watcher.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

run().catch((err) => {
  console.error('[dev-watch] Fatal:', err);
  process.exit(1);
});
