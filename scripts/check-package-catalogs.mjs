#!/usr/bin/env node
/**
 * Package message catalog gate (ADR-0016 §5).
 *
 * Every plugin / theme frontend that translates its own copy ships
 * `frontend/messages/<locale>.json`. Two rules make those catalogs safe to
 * resolve at runtime:
 *
 *   1. **Key parity** — every locale must declare the same key set. A key that
 *      exists only in `zh-CN` silently degrades to the key name on an English
 *      page, which is exactly the class of bug this gate exists to catch.
 *   2. **Placeholder parity** — a key may only use the same `{name}` placeholders
 *      in every locale. `{count} items` vs `{n} 项` renders a literal `{n}`.
 *   3. **Reference integrity** — every `labelKey` / `groupKey` / `titleKey` /
 *      `helpKey` / `placeholderKey` that the built manifest declares must exist in
 *      the package catalog. Neither the literal scanner (a key is not Chinese
 *      copy) nor key parity (both locales can miss the same key) would notice a
 *      typo; it would just render the key name in the admin UI.
 *
 * Usage:
 *   node scripts/check-package-catalogs.mjs           # report + exit 1 on error
 *   node scripts/check-package-catalogs.mjs --json    # machine-readable
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(root, 'packages');
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function placeholderNames(template) {
  const names = new Set();
  let match;
  while ((match = PLACEHOLDER.exec(template)) !== null) names.add(match[1]);
  return [...names].sort();
}

function listCatalogDirs() {
  const out = [];
  for (const kind of ['plugins', 'themes']) {
    const kindDir = path.join(packagesDir, kind);
    if (!existsSync(kindDir)) continue;
    for (const id of readdirSync(kindDir)) {
      const messagesDir = path.join(kindDir, id, 'frontend', 'messages');
      if (existsSync(messagesDir) && statSync(messagesDir).isDirectory()) {
        out.push({ id: `${kind}/${id}`, dir: messagesDir });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const problems = [];
const summaries = [];

/** Locale identifier fields that must resolve in the package's own catalog. */
const KEY_FIELDS = ['labelKey', 'groupKey', 'titleKey', 'helpKey', 'placeholderKey'];

/** Collect every `*Key` string reachable from a manifest, with its path. */
function collectMessageKeys(value, path = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMessageKeys(item, `${path}[${index}]`, out));
    return out;
  }
  if (typeof value !== 'object' || value === null) return out;
  for (const [field, child] of Object.entries(value)) {
    if (KEY_FIELDS.includes(field) && typeof child === 'string') {
      out.push({ key: child, at: `${path}.${field}` });
      continue;
    }
    collectMessageKeys(child, `${path}.${field}`, out);
  }
  return out;
}

for (const { id, dir } of listCatalogDirs()) {
  const locales = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  if (locales.length === 0) continue;

  const catalogs = {};
  for (const locale of locales) {
    const file = path.join(dir, `${locale}.json`);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        problems.push(`${id} ${locale}: catalog must be a JSON object`);
        continue;
      }
      catalogs[locale] = parsed;
    } catch (error) {
      problems.push(`${id} ${locale}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }
  }

  const known = Object.keys(catalogs);
  if (known.length === 0) continue;
  const [reference, ...rest] = known;
  const referenceKeys = new Set(Object.keys(catalogs[reference]));

  for (const locale of rest) {
    const keys = new Set(Object.keys(catalogs[locale]));
    for (const key of referenceKeys) {
      if (!keys.has(key))
        problems.push(`${id} ${locale}: missing key "${key}" (present in ${reference})`);
    }
    for (const key of keys) {
      if (!referenceKeys.has(key))
        problems.push(`${id} ${reference}: missing key "${key}" (present in ${locale})`);
    }
  }

  for (const key of referenceKeys) {
    const expected = placeholderNames(catalogs[reference][key]);
    for (const locale of rest) {
      const value = catalogs[locale][key];
      if (typeof value !== 'string') continue;
      const actual = placeholderNames(value);
      if (expected.join(',') !== actual.join(',')) {
        problems.push(
          `${id} ${locale}: placeholders for "${key}" are {${actual.join('}, {')}} but ${reference} uses {${expected.join('}, {')}}`,
        );
      }
    }
  }

  // Reference integrity against the built manifest, when one exists. A stale
  // manifest can only cause a false positive for a key that was just added, so
  // this runs after `build:frontend` in CI.
  const manifestPath = path.join(dir, '..', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const { key, at } of collectMessageKeys(manifest)) {
        // `messages` itself is the catalog; only metadata/schema refs matter.
        if (at.includes('.messages')) continue;
        for (const locale of known) {
          if (typeof catalogs[locale][key] !== 'string') {
            problems.push(
              `${id} ${locale}: manifest ${at} references "${key}" but the catalog has no such key`,
            );
          }
        }
      }
    } catch (error) {
      problems.push(`${id} manifest: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }
  }

  summaries.push({ id, locales, keys: referenceKeys.size });
}

// ---------------------------------------------------------------------------
// Kernel catalogs (apps/web)
// ---------------------------------------------------------------------------
/**
 * The kernel catalog is **nested**, and `lookupMessage` resolves a key by
 * splitting it on `.` and walking the object. A literal key such as
 * `"admin.settings.payment.title"` sitting at the top level is therefore
 * unreachable: it looks fine in review, parses fine, and renders the raw key at
 * runtime. That exact mistake shipped once, so it is gated here.
 *
 * Package catalogs are the opposite (flat, literal lookup) and are checked
 * above; the two formats cannot be unified without breaking one of them.
 */
function flattenCatalog(value, path = '', out = new Map()) {
  if (typeof value === 'string') {
    out.set(path, value);
    return out;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/**
 * Keys that intentionally use different placeholder names per locale.
 *
 * `admin.rbac.discountPercent` renders a *different quantity* in Chinese and
 * English: zh says "打 9.8 折" (`{fold}`) while en says "2% off" (`{discount}`).
 * The caller passes both (`permission-group-manager.tsx`), so each locale picks
 * the one it needs. Everywhere else, a placeholder mismatch is a typo that
 * renders a literal `{name}` — keep this list empty unless the divergence is
 * semantic, not cosmetic.
 */
const KERNEL_PLACEHOLDER_EXCEPTIONS = new Set(['admin.rbac.discountPercent']);

const kernelMessagesDir = path.join(root, 'apps', 'web', 'src', 'i18n', 'messages');
if (existsSync(kernelMessagesDir)) {
  const kernelLocales = readdirSync(kernelMessagesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  const flat = {};
  for (const locale of kernelLocales) {
    const file = path.join(kernelMessagesDir, `${locale}.json`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`kernel ${locale}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
      continue;
    }
    for (const key of Object.keys(parsed)) {
      if (key.includes('.')) {
        problems.push(
          `kernel ${locale}: top-level key "${key}" contains a dot — it can never be resolved; nest it instead`,
        );
      }
    }
    flat[locale] = flattenCatalog(parsed);
  }

  const kernelKnown = Object.keys(flat);
  if (kernelKnown.length > 0) {
    const [reference, ...rest] = kernelKnown;
    for (const locale of rest) {
      for (const key of flat[reference].keys()) {
        if (!flat[locale].has(key)) {
          problems.push(`kernel ${locale}: missing key "${key}" (present in ${reference})`);
        }
      }
      for (const key of flat[locale].keys()) {
        if (!flat[reference].has(key)) {
          problems.push(`kernel ${reference}: missing key "${key}" (present in ${locale})`);
        }
      }
    }
    for (const [key, template] of flat[reference]) {
      if (KERNEL_PLACEHOLDER_EXCEPTIONS.has(key)) continue;
      const expected = placeholderNames(template);
      for (const locale of rest) {
        const value = flat[locale].get(key);
        if (typeof value !== 'string') continue;
        const actual = placeholderNames(value);
        if (expected.join(',') !== actual.join(',')) {
          problems.push(
            `kernel ${locale}: placeholders for "${key}" are {${actual.join('}, {')}} but ${reference} uses {${expected.join('}, {')}}`,
          );
        }
      }
    }
    summaries.push({ id: 'kernel catalogs', locales: kernelKnown, keys: flat[reference].size });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ packages: summaries, problems }, null, 2));
} else {
  for (const { id, locales, keys } of summaries) {
    console.log(`ok  ${id} — ${locales.join(', ')} — ${keys} keys`);
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} package catalog problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nEvery locale must declare the same key set with the same {placeholders}.');
  process.exit(1);
}

if (!process.argv.includes('--json')) {
  console.log(`\npackage catalogs: OK (${summaries.length} package(s))`);
}
