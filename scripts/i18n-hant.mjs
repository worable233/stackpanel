#!/usr/bin/env node
/**
 * Generate the Traditional Chinese catalogs (`zh-TW`, `zh-HK`) from `zh-CN`.
 *
 * ADR-0016 ships four interface locales. Hand-maintaining two extra copies of
 * ~1.5k messages invites drift, so Traditional Chinese is *derived*: the
 * Simplified catalog stays the single authored source and this script rewrites
 * both Traditional files deterministically.
 *
 * Conversion rules
 *   - `zh-TW` uses OpenCC `cn → twp`: fully traditional characters plus Taiwan
 *     vocabulary (軟體 / 網路 / 設定 / 螢幕 …).
 *   - `zh-HK` starts from the same text and applies a Hong Kong vocabulary
 *     overlay (軟件 / 網絡 / 默認 / 設置 / 用戶 …).
 *   - Structure, key order and `{placeholders}` are preserved byte for byte, so
 *     the key/placeholder parity gates keep passing.
 *   - `locale.*` endonyms are proper nouns and are written verbatim.
 *
 * Usage
 *   node scripts/i18n-hant.mjs            # rewrite every zh-TW / zh-HK catalog
 *   node scripts/i18n-hant.mjs --check    # fail if a committed catalog is stale
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const toTW = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** Hong Kong vocabulary overrides applied on top of the Taiwan text. */
const HK_TERMS = [
  ['軟體', '軟件'],
  ['硬體', '硬件'],
  ['程式', '程序'],
  ['網路', '網絡'],
  ['網際網路', '互聯網'],
  ['預設', '默認'],
  ['設定', '設置'],
  ['使用者', '用戶'],
  ['登入', '登錄'],
  // `儲存` covers both "storage" and "save" in Traditional Chinese. Rewriting it
  // to `保存` would turn 「存储桶」(storage bucket) into 「保存桶」(save bucket),
  // so Hong Kong keeps `儲存` — it is the standard term for both senses there.
  ['檔案', '文件'],
  ['快取', '緩存'],
  ['執行緒', '線程'],
];

/**
 * `台`/`游`/`准` are genuine traditional forms (臺/台, 遊/游, 準/准 coexist), so
 * the leftover-simplified check must not flag them.
 */
const VALID_TRADITIONAL = new Set(['台', '游', '准']);

/** Endonyms shown by the language picker: never converted. */
const LOCALE_LABELS = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣）',
  'zh-HK': '繁體中文（香港）',
  'en-US': 'English',
};

function toHK(text) {
  let next = text;
  for (const [from, to] of HK_TERMS) next = next.split(from).join(to);
  return next;
}

/** Convert every string leaf; leave non-Han strings (ids, urls) untouched. */
function convert(node, transform) {
  if (typeof node === 'string') {
    return /\p{Script=Han}/u.test(node) ? transform(node) : node;
  }
  if (Array.isArray(node)) return node.map((item) => convert(item, transform));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = convert(value, transform);
    return out;
  }
  return node;
}

function simplifiedLeftovers(text) {
  const found = new Set();
  for (const char of text) {
    if (!/\p{Script=Han}/u.test(char)) continue;
    if (toTW(char) !== char && !VALID_TRADITIONAL.has(char)) found.add(char);
  }
  return [...found].join('');
}

/** Every directory that holds a `zh-CN.json` catalog. */
function catalogDirs() {
  const dirs = [path.join(root, 'apps', 'web', 'src', 'i18n', 'messages')];
  for (const kind of ['plugins', 'themes']) {
    const kindDir = path.join(root, 'packages', kind);
    let entries;
    try {
      entries = readdirSync(kindDir);
    } catch {
      continue;
    }
    for (const id of entries) {
      const dir = path.join(kindDir, id, 'frontend', 'messages');
      try {
        if (statSync(dir).isDirectory()) dirs.push(dir);
      } catch {
        // Not a frontend package.
      }
    }
  }
  return dirs.filter((dir) => {
    try {
      return statSync(path.join(dir, 'zh-CN.json')).isFile();
    } catch {
      return false;
    }
  });
}

let stale = 0;
for (const dir of catalogDirs()) {
  const source = JSON.parse(readFileSync(path.join(dir, 'zh-CN.json'), 'utf8'));
  const tw = convert(source, toTW);
  const hk = convert(source, (text) => toHK(toTW(text)));
  // Validate the converted copy before the endonyms are restored: `简体中文` is a
  // deliberate proper noun, not a stray simplified character.
  for (const [name, catalog] of [
    ['zh-TW', tw],
    ['zh-HK', hk],
  ]) {
    const leftover = simplifiedLeftovers(JSON.stringify(catalog));
    if (leftover) throw new Error(`${dir}/${name}: simplified characters left: ${leftover}`);
  }
  if (source.locale && typeof source.locale === 'object') {
    for (const catalog of [tw, hk]) Object.assign(catalog.locale, LOCALE_LABELS);
  }
  for (const [name, catalog] of [
    ['zh-TW', tw],
    ['zh-HK', hk],
  ]) {
    const file = path.join(dir, `${name}.json`);
    const next = `${JSON.stringify(catalog, null, 2)}\n`;
    if (check) {
      let current = '';
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        current = '';
      }
      if (current !== next) {
        stale += 1;
        console.error(`stale: ${path.relative(root, file)}`);
      }
      continue;
    }
    writeFileSync(file, next);
    console.log(`wrote ${path.relative(root, file)}`);
  }
}

if (check) {
  if (stale > 0) {
    console.error(`\n${stale} Traditional Chinese catalog(s) are out of date — run \`pnpm i18n:hant\`.`);
    process.exit(1);
  }
  console.log('Traditional Chinese catalogs: up to date');
}
