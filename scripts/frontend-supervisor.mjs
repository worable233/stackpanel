#!/usr/bin/env node
/**
 * Web frontend supervisor (S7 / ADR-0017 §5) — consumer half.
 *
 * Runs `next start` and, when the shared artifact signature changes, restarts
 * itself so the new bundle is served. It **never builds**: a single builder (the
 * worker) produces the web bundle exactly once and publishes the signature. Each
 * web replica independently notices the signature and restarts only itself.
 *
 * Why restart and not hot-swap: the plugin frontend registry is generated into
 * `apps/web/src/lib` before `next build` and imported statically at build time,
 * so a new bundle is required for plugin/theme frontend changes. Restarting is
 * the correct, minimal action for a replica.
 *
 * The worker writes the shared `apps/web/.next` volume (see docker-compose*.yml),
 * so the restart picks up the freshly built bundle. The progress UI is owned by
 * the builder; this process only reads the status.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.STACKPANEL_DATA_DIR
  ? path.resolve(process.env.STACKPANEL_DATA_DIR)
  : path.join(ROOT, 'data');
const PORT = process.env.WEB_PORT ?? '3000';

const SIGNATURE_FILE = path.join(DATA_DIR, 'frontend-apply.signature');
const LOG_PREFIX = '[frontend-supervisor]';
/** Poll interval for the shared build signature. */
const POLL_MS = 3000;

/** Autobuild off => plain `next start`, no signature watching. */
const AUTOBUILD = process.env.STACKPANEL_FRONTEND_AUTOBUILD !== '0';

let child = null;
let shuttingDown = false;
let restarting = false;
let lastSignature = null;

function log(message) {
  process.stdout.write(`${LOG_PREFIX} ${message}\n`);
}

async function readSignature() {
  try {
    return (await readFile(SIGNATURE_FILE, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

function startNext() {
  const nextBin = path.join(ROOT, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) {
    log(`next binary not found at ${nextBin}`);
    process.exit(1);
  }
  child = spawn(process.execPath, [nextBin, 'start', '-p', PORT], {
    cwd: path.join(ROOT, 'apps', 'web'),
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown || restarting) return;
    // If next crashes on its own, exit so the container restarts it.
    log(`next exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    process.exit(code ?? 1);
  });
  log(`next started on :${PORT}`);
}

async function stopNext() {
  if (!child) return;
  const current = child;
  restarting = true;
  const exited = new Promise((resolve) => current.once('exit', resolve));
  current.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child === current) current.kill('SIGKILL');
  }, 10_000);
  await exited;
  clearTimeout(timer);
  child = null;
  restarting = false;
}

/**
 * Restart next to serve the freshly built bundle. Containers restart themselves
 * (compose/k8s keep the replica name) — the builder already produced the
 * artifacts, so nothing is rebuilt here.
 */
async function restartForNewArtifacts(signature) {
  log(`new frontend artifacts (${lastSignature ?? 'none'} -> ${signature}); restarting next`);
  await stopNext();
  startNext();
  lastSignature = signature;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  startNext();
  if (!AUTOBUILD) {
    log('autobuild disabled (STACKPANEL_FRONTEND_AUTOBUILD=0): plain next start');
    return;
  }
  lastSignature = await readSignature();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (shuttingDown) return;
    const signature = await readSignature();
    if (signature && signature !== lastSignature) {
      await restartForNewArtifacts(signature);
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}, shutting down`);
  await stopNext();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
