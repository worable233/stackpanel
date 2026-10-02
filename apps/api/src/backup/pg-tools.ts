/**
 * PostgreSQL client tooling for export/import (ADR-0018 §3, §4).
 *
 * `pg_dump` / `pg_restore` are external binaries, not npm packages, so we
 * locate them on `PATH` (and common install locations) and fail explicitly
 * when they are missing. That keeps the failure mode obvious instead of
 * producing a silently-empty dump.
 *
 * Prefer the version-matched path: the tools must be at least as new as the
 * server, otherwise `pg_dump` refuses (or downgrades) the archive.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type PgToolName = 'pg_dump' | 'pg_restore';

/** Common locations to fall back to when the tool is not on `PATH`. */
function fallbackPaths(name: PgToolName): string[] {
  const candidates: string[] = [];
  const dirs = [
    '/usr/lib/postgresql',
    '/usr/local/pgsql/bin',
    '/opt/homebrew/opt',
    '/usr/local/opt',
    path.join(homedir(), '.local/bin'),
  ];
  for (const dir of dirs) {
    if (dir.endsWith('/opt')) continue;
    candidates.push(path.join(dir, 'bin', name));
  }
  // Versioned Homebrew installs: /opt/homebrew/opt/postgresql@16/bin/pg_dump.
  for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const version of [17, 16, 15, 14]) {
      candidates.push(path.join(root, `postgresql@${version}`, 'bin', name));
    }
  }
  return candidates;
}

/** Resolve a pg tool to an absolute path, or null when unavailable. */
export function resolvePgTool(name: PgToolName): string | null {
  const fromPath = lookupOnPath(name);
  if (fromPath) return fromPath;
  for (const candidate of fallbackPaths(name)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function lookupOnPath(name: string): string | null {
  const pathValue = process.env['PATH'] ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface PgToolsStatus {
  pgDump: string | null;
  pgRestore: string | null;
  available: boolean;
}

/** Test seam: force a tools status (null restores real detection). */
let toolsOverride: PgToolsStatus | null = null;

export function setPgToolsOverride(next: PgToolsStatus | null): void {
  toolsOverride = next;
}

/** Whether both tools needed for export+import are present. */
export function pgToolsStatus(): PgToolsStatus {
  if (toolsOverride) return toolsOverride;
  const pgDump = resolvePgTool('pg_dump');
  const pgRestore = resolvePgTool('pg_restore');
  return { pgDump, pgRestore, available: pgDump !== null && pgRestore !== null };
}

export class PgToolError extends Error {}

export interface RunPgOptions {
  /** Extra arguments appended to the tool invocation. */
  args: string[];
  /** When set, stderr/stdout are captured for the error message. */
  label: string;
}

/** Run a pg tool to completion; reject with its stderr on a non-zero exit. */
async function run(tool: string, options: RunPgOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tool, options.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on('error', (error) => reject(new PgToolError(`${options.label} 启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new PgToolError(`${options.label} 失败（退出码 ${code ?? 'unknown'}）：${stderr.trim()}`));
    });
  });
}

/** Options for {@link runPgDump}; unset fields keep the whole-instance default. */
export interface PgDumpOptions {
  /**
   * Tables whose *data* is skipped while their schema is still dumped
   * (ADR-0018 §7 selective export). Implemented with `--exclude-table-data`.
   */
  excludeTableData?: readonly string[];
}

/** Produce a custom-format (`-Fc`) snapshot of the database. */
export async function runPgDump(
  databaseUrl: string,
  outputPath: string,
  options: PgDumpOptions = {},
): Promise<void> {
  const tool = resolvePgTool('pg_dump');
  if (!tool) throw new PgToolError('未找到 pg_dump，请安装 postgresql-client');
  const args = ['--format=custom', '--no-owner', '--no-privileges'];
  for (const table of options.excludeTableData ?? []) {
    // The table name comes from the static domain map (never user input), but
    // double-quote it so any mixed-case identifier stays exact.
    args.push('--exclude-table-data', `"${table}"`);
  }
  args.push('--file', outputPath, databaseUrl);
  await run(tool, { label: 'pg_dump', args });
}

/**
 * Restore a custom-format snapshot over the target database. `--clean
 * --if-exists` makes the import replace existing objects; the caller is
 * responsible for entering maintenance mode first (ADR-0018 §4).
 */
export async function runPgRestore(databaseUrl: string, inputPath: string): Promise<void> {
  const tool = resolvePgTool('pg_restore');
  if (!tool) throw new PgToolError('未找到 pg_restore，请安装 postgresql-client');
  await run(tool, {
    label: 'pg_restore',
    args: [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--dbname',
      databaseUrl,
      inputPath,
    ],
  });
}
