import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import zhCN from '@/i18n/messages/zh-CN.json';
import enUS from '@/i18n/messages/en-US.json';
import { LOCALES, CATALOGS } from '@/i18n/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Every error `code` the backend can emit must have a translated message.
 *
 * ADR-0012 makes `code` the only machine-readable part of a problem response and
 * ADR-0016 makes the interface own the copy (`error.<code>`). A code without a
 * catalog entry silently degrades to `common.operationFailed`, which is exactly
 * the "error gives no actionable information" failure this audit set out to fix.
 *
 * The scan is source-based on purpose: it covers codes that are only thrown on
 * rare paths, which no integration test exercises.
 */

const CODE_SHAPE = /^[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9_]+)+$/;

/** A stable error code, not an i18n key or a wire message type. */
const EXCLUDED = new Set([
  // Message discriminators (`raw-body`, `raw-body-error`) are not error codes.
  'raw.body',
]);

const EXCLUDED_PREFIXES = [
  // Isolated-plugin RPC plumbing: surfaced to plugin authors, never to end users.
  'rpc.',
];

function isErrorCode(value: string): boolean {
  if (!CODE_SHAPE.test(value)) return false;
  if (EXCLUDED.has(value)) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function walk(dir: string, visit: (file: string) => void): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) visit(full);
  }
}

const PATTERNS = [
  /\bcode:\s*'([^']+)'/g,
  /\bcode:\s*"([^"]+)"/g,
  /\b(?:PluginError|MediaError|FrontendError|ThemeError|CatalogMarketError|BrandError|SignatureError)\(\s*'([^']+)'/g,
  /\b(?:PluginError|MediaError|FrontendError|ThemeError|CatalogMarketError|BrandError|SignatureError)\(\s*"([^"]+)"/g,
  /\bcodedError\([^,]+,\s*'([^']+)'/g,
  /\bcodedError\([^,]+,\s*"([^"]+)"/g,
];

function collectCodes(): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (file: string): void => {
    const source = readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const code = match[1]!;
        if (isErrorCode(code) && !found.has(code)) {
          found.set(code, path.relative(root, file));
        }
      }
    }
  };
  walk(path.join(root, 'apps/api/src'), visit);
  walk(path.join(root, 'packages/sdk/src'), visit);
  const plugins = path.join(root, 'packages/plugins');
  for (const entry of readdirSync(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(plugins, entry.name, 'src');
    walk(src, visit);
  }
  return found;
}

function flatten(node: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value as Record<string, unknown>, full));
    } else if (typeof value === 'string') {
      out[full] = value;
    }
  }
  return out;
}

const codes = collectCodes();
const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [locale, flatten(CATALOGS[locale] as Record<string, unknown>)]),
);

describe('error code coverage', () => {
  it('finds the backend error codes to check', () => {
    // Guards the scanner itself: a refactor that changes how codes are declared
    // must not silently turn this suite into a no-op.
    expect(codes.size).toBeGreaterThan(100);
  });

  it('translates every emitted code in every shipped locale', () => {
    const missing: string[] = [];
    for (const [code, source] of codes) {
      for (const locale of LOCALES) {
        if (!catalogs[locale]![`error.${code}`]) missing.push(`${locale}: error.${code} (${source})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps zh-CN and en-US code coverage identical', () => {
    const zh = Object.keys(flatten(zhCN.error));
    const en = Object.keys(flatten(enUS.error));
    expect(en.sort()).toEqual(zh.sort());
  });

  it('resolves Agent problem codes through the error namespace', () => {
    // The Agent BFF forwards problem `code`s (`agent.budget_exhausted`) while its
    // own proxy uses top-level `agentRoute.*` keys. Both must resolve, otherwise
    // agentErrorText falls back to upstream English prose.
    const t = (key: string): string => catalogs['zh-CN']![key] ?? key;
    expect(t('error.agent.disabled')).not.toBe('error.agent.disabled');
    expect(t('agentRoute.notFound')).not.toBe('agentRoute.notFound');
  });
});
