#!/usr/bin/env node
/**
 * i18n literal gate (ADR-0016, PLAN-i18n-completion §3 阶段 0).
 *
 * Scans the kernel web UI, shared `@stackpanel/ui` primitives and every plugin /
 * theme frontend for unregistered human-language literals. A literal is
 * "registered" when it lives in a message catalog and is resolved through a
 * stable id. Everything else must either be migrated or explicitly exempted.
 *
 * Rules
 *   A. Han literal   — any string/template literal containing a CJK ideograph.
 *   B. UI attribute  — a user-facing JSX attribute (aria-label/title/…) whose
 *                      literal value is prose (English or Chinese).
 *   C. JSX text      — JSX text children containing CJK ideographs.
 *
 * Allowances (never reported)
 *   - comments (the parser never yields them as literals),
 *   - tests, fixtures, generated `dist/`, declaration files,
 *   - the message catalogs themselves,
 *   - a literal matching the allowlist below (brands, protocol/code values),
 *   - any line carrying an inline `i18n-exempt` comment, or a file carrying a
 *     `@i18n-exempt` banner.
 *
 * Ratchet
 *   Every violation is keyed by `<file>::<rule>::<text>`. `.i18n-literals.json`
 *   stores the accepted baseline; `--check` fails when a key is absent from it
 *   (a new/unregistered literal), and the baseline may only shrink as Phase 1
 *   migrates copy. `--update-baseline` rewrites it after a migration.
 *
 * Usage
 *   node scripts/scan-i18n-literals.mjs            # report, exit 0
 *   node scripts/scan-i18n-literals.mjs --check    # gate (CI), exit 1 on new
 *   node scripts/scan-i18n-literals.mjs --update-baseline
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = process.cwd();
const baselineFile = path.join(root, '.i18n-literals.json');

const SCAN_ROOTS = [
  'apps/web/src',
  'packages/ui/src',
  ...readdirSync(path.join(root, 'packages/plugins'))
    .map((id) => `packages/plugins/${id}/frontend/src`)
    .filter((dir) => existsSync(path.join(root, dir))),
  ...readdirSync(path.join(root, 'packages/themes'))
    .map((id) => `packages/themes/${id}/frontend/src`)
    .filter((dir) => existsSync(path.join(root, dir))),
];

/** Skip tests, fixtures, declarations, build output and OS noise. */
const SKIP_PATH =
  /(^|\/)(node_modules|dist|\.next|coverage|__tests__|tests?|fixtures?)(\/|$)|\.d\.ts$/;

/**
 * Values that are not platform UI copy: brands, protocol/code tokens, format
 * identifiers and single symbols. Matching is case-insensitive and either exact
 * or a whole-string token.
 */
const ALLOWLIST = new Set(
  [
    'StackPanel',
    'Agent',
    'MCP',
    'OAuth',
    'API',
    'HTTP',
    'HTTPS',
    'JSON',
    'URL',
    'URI',
    'ID',
    'IDs',
    'RPM',
    'PNG',
    'JPEG',
    'JPG',
    'GIF',
    'WebP',
    'SVG',
    'PDF',
    'SMTP',
    'SSH',
    'TLS',
    'DNS',
    'CSP',
    'CSRF',
    'CORS',
    'SQL',
    'DB',
    'UUID',
    'SHA',
    'HMAC',
    'JWT',
    'TOTP',
    'GitHub',
    'Docker',
    'Redis',
    'PostgreSQL',
    'MinIO',
    'S3',
    'CDN',
    'OpenAPI',
    'Git',
    'CNY',
    'USD',
    'EUR',
    'JPY',
    'AES',
    'DAG',
    'OK',
    'AI',
    'cloud-tools',
    'check-service',
  ].map((value) => value.toLowerCase()),
);

const HAN = /\p{Script=Han}/u;
const LATIN = /[A-Za-z]/;

/** Attributes whose string value is user-facing copy rather than markup. */
const UI_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
]);

function collectFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full);
    if (SKIP_PATH.test(rel)) continue;
    const info = statSync(full);
    if (info.isDirectory()) collectFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
}

/** True when the literal text is allowed without registration. */
function isAllowed(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (ALLOWLIST.has(trimmed.toLowerCase())) return true;
  // Pure punctuation, numbers, symbols, format strings, ids/keys, urls, paths.
  if (!HAN.test(trimmed) && !LATIN.test(trimmed)) return true;
  if (/^[a-z0-9-_.:/#@%{}$\s]+$/.test(trimmed)) return true; // code-ish/slug/format
  // A single latin word with no spaces and not capitalised prose (e.g. `cuid`).
  if (!HAN.test(trimmed)) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 1 && !/^[A-Z]/.test(trimmed)) return true;
  }
  return false;
}

/**
 * True when a JSX attribute value reads as human prose (English sentence or
 * capitalised multi-word phrase) rather than a code token, URL, PEM block or
 * single proper noun. Used to keep the `ui-attr` rule from crying wolf.
 */
function looksLikeProse(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (HAN.test(trimmed)) return false; // handled by han-literal
  if (ALLOWLIST.has(trimmed.toLowerCase())) return false;
  if (/-----BEGIN|-----END|^[A-Za-z+/\d]+=*$/.test(trimmed)) return false; // PEM/base64
  if (/^[a-z0-9-_.:/#@%{}$\s]+$/.test(trimmed)) return false; // slug/code/url/path
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 3) return true; // a phrase or sentence
  return words.length === 2 && words.every((w) => /^[A-Z]/.test(w)); // e.g. "Go to"
}

/** True when a line is explicitly exempted. */
function lineExempt(sourceFile, line) {
  const text = sourceFile.getFullText();
  const lines = text.split('\n');
  const content = lines[line] ?? '';
  return /i18n-exempt|i18n-allow|@i18n-exempt/.test(content);
}

function fileExempt(sourceFile) {
  return /@i18n-exempt/.test(sourceFile.getFullText().split('\n').slice(0, 5).join('\n'));
}

/** The nearest preceding line of a node, used for inline exemption checks. */
function startLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
}

function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (fileExempt(sourceFile)) return [];
  const rel = path.relative(root, file);
  const violations = [];

  const push = (rule, node, value) => {
    if (isAllowed(value)) return;
    if (lineExempt(sourceFile, startLine(sourceFile, node))) return;
    violations.push({ file: rel, line: startLine(sourceFile, node) + 1, rule, text: value.trim() });
  };

  const visit = (node) => {
    // Rule A: Chinese string/template literals (comments are never literals).
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const isUiAttr =
        ts.isJsxAttribute(parent) && parent.name && ts.isIdentifier(parent.name)
          ? UI_ATTRS.has(parent.name.text)
          : false;
      if (HAN.test(node.text)) {
        push('han-literal', node, node.text);
      } else if (isUiAttr && looksLikeProse(node.text)) {
        push('ui-attr', node, node.text);
      }
    } else if (ts.isTemplateExpression(node)) {
      const joined = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('');
      if (HAN.test(joined)) push('han-template', node, joined);
    } else if (ts.isJsxText(node)) {
      // Rule C: JSX text children with CJK.
      const value = node.text.replace(/\s+/g, ' ').trim();
      if (HAN.test(value)) push('jsx-text', node, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

const files = [];
for (const scanRoot of SCAN_ROOTS) collectFiles(path.join(root, scanRoot), files);

const violations = files.flatMap(scanFile);
const keyOf = (v) => `${v.file}::${v.rule}::${v.text}`;

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--update-baseline')
    ? 'update'
    : 'report';

const baseline = existsSync(baselineFile)
  ? new Set(JSON.parse(readFileSync(baselineFile, 'utf8')).keys ?? [])
  : new Set();

if (mode === 'update') {
  const keys = [...new Set(violations.map(keyOf))].sort();
  writeFileSync(
    baselineFile,
    `${JSON.stringify(
      {
        note: 'Accepted i18n literal baseline (ratchet). May only shrink; regenerate with --update-baseline after migrating copy.',
        count: keys.length,
        keys,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`i18n baseline updated: ${keys.length} accepted literals`);
  process.exit(0);
}

const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

const new_violations = violations.filter((v) => !baseline.has(keyOf(v)));
const fixed = [...baseline].filter((key) => !violations.some((v) => keyOf(v) === key));

if (mode === 'check') {
  if (fixed.length > 0) {
    console.log(
      `i18n: ${fixed.length} baseline literal(s) no longer present — run --update-baseline to shrink the ratchet.`,
    );
  }
  if (new_violations.length > 0) {
    console.error(`i18n: ${new_violations.length} unregistered literal(s) found:\n`);
    for (const v of new_violations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}] ${JSON.stringify(v.text)}`);
    }
    console.error(
      '\nRegister the copy in a message catalog, or annotate the line with `// i18n-exempt`.',
    );
    process.exit(1);
  }
  console.log(`i18n: OK (${violations.length} known literals, 0 new)`);
  process.exit(0);
}

// report mode
console.log(`i18n literal scan: ${violations.length} literal(s) across ${byFile.size} file(s)`);
console.log(`  accepted baseline: ${baseline.size}`);
console.log(`  new (not in baseline): ${new_violations.length}`);
console.log(`  baseline no longer present: ${fixed.length}`);
for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
  console.log(`  ${list.length.toString().padStart(3)}  ${file}`);
}
