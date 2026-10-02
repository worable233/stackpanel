import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Canonical filesystem-path resolution for the StackPanel kernel.
 *
 * Both `apps/api` (Fastify) and `apps/web` (Next.js) read the SAME on-disk
 * data directory (`<repo-root>/data` by default). This module is the single
 * source of truth for where that directory lives, so the API, the web server,
 * and the frontend build script can never drift apart again.
 *
 * This module is server-only: it imports `node:fs`/`node:path` and must never
 * be imported by plugin/theme frontend code that may run in a browser.
 */

export interface StackPanelPathOptions {
  /** Environment lookup (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Anchor file URL or absolute path used to locate the repo root. */
  moduleUrl?: string;
  /** Fallback working directory when the repo root cannot be discovered. */
  cwd?: string;
}

function toDir(moduleUrl: string | undefined, fallback: string): string {
  if (!moduleUrl) return fallback;
  if (moduleUrl.startsWith('file:')) {
    return path.dirname(fileURLToPath(moduleUrl));
  }
  // A bare path (used by tests and build scripts).
  return path.dirname(moduleUrl);
}

/**
 * Walk upward from `startDir` until the monorepo root is found.
 *
 * The definitive marker is `pnpm-workspace.yaml`. As a fallback for packaged
 * deployments that strip workspace files, a `package.json` whose `name` is
 * `stackpanel` is also accepted.
 */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'stackpanel') return dir;
      } catch {
        // Unreadable package.json; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the canonical StackPanel data directory.
 *
 * 1. `STACKPANEL_DATA_DIR` (when set and non-empty) wins — resolved to an
 *    absolute path. Production deployments MUST set this.
 * 2. Otherwise discover the repo root by walking up from the caller module,
 *    then return `<root>/data`.
 * 3. If discovery fails, fall back to `<cwd>/data`.
 */
export function resolveStackPanelDataDir(options: StackPanelPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env['STACKPANEL_DATA_DIR'];
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }

  const fallbackCwd = options.cwd ?? process.cwd();
  const anchorDir = toDir(options.moduleUrl, fallbackCwd);

  const root = findRepoRoot(anchorDir) ?? findRepoRoot(fallbackCwd) ?? fallbackCwd;
  return path.join(root, 'data');
}

/**
 * Resolve a Prisma connection string so `file:`-relative paths are anchored to
 * the canonical data directory instead of the process working directory.
 *
 * - `file:./stackpanel.db` → `<dataDir>/stackpanel.db`
 * - `file:/abs/path/stackpanel.db` → unchanged
 * - `mysql://...` → unchanged
 */
export function resolveStackPanelDatabaseUrl(databaseUrl: string, dataDir: string): string {
  if (databaseUrl.startsWith('file:')) {
    const filePath = databaseUrl.slice('file:'.length);
    if (filePath && !path.isAbsolute(filePath)) {
      return `file:${path.resolve(dataDir, filePath)}`;
    }
  }
  return databaseUrl;
}
