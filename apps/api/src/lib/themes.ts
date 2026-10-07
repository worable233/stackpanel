import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import * as csstree from 'css-tree';
import type { CssNode } from 'css-tree';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { FrontendError, isAllowedFrontendFile, validateFrontendFiles } from './frontend.ts';
import { env } from '../config/env.ts';
import { SignatureError, verifyPackageSignature } from './signatures.ts';

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  supportsDarkMode?: boolean;
  /** Interface locales this theme ships messages for (ADR-0016 §5). */
  locales?: string[];
  /** Brand assets declared by the theme, relative to the theme package. */
  assets?: {
    logo?: string;
    favicon?: string;
  };
}

export const THEME_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

const FORBIDDEN_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);
const MAX_THEME_CSS_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_ARCHIVE_FILES = 128;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

function themesDir(): string {
  return path.join(resolveStackPanelDataDir(), 'themes');
}

export function themePackageDir(id: string): string {
  return path.join(themesDir(), id);
}

export function themeCssPath(id: string): string {
  return path.join(themePackageDir(id), 'theme.css');
}

export function themeManifestPath(id: string): string {
  return path.join(themePackageDir(id), 'theme.json');
}

export function themeAssetPath(id: string, asset: string): string {
  return path.join(themePackageDir(id), 'assets', asset);
}

function safeJoin(base: string, name: string): string | null {
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

/** Reject a ZIP entry name that could escape the theme directory. */
function isSafeEntryName(name: string): boolean {
  if (name.includes('..')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return true;
}

function isForbiddenFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) return true;
  const base = path.basename(name).toLowerCase();
  return base === '.htaccess' || base.startsWith('.git');
}

/**
 * Validate a theme CSS file: only `:root` and `.dark` blocks are allowed, each
 * containing token-only `--*` custom property declarations. Anything else
 * (at-rules, selectors, url()) is rejected — themes are configuration, not code.
 *
 * Parsed with `css-tree` (SECURITY-AUDIT-2026-10-04 I-1) so malformed or
 * obfuscated input cannot slip past a hand-rolled regex: the AST is walked and
 * every node is checked against the allowlist.
 */
export function validateThemeCss(css: string): boolean {
  // Any parse error (unclosed block, stray token, …) fails the whole file rather
  // than being silently patched into a valid-looking AST.
  let parseError = false;
  let ast: CssNode;
  try {
    ast = csstree.parse(css, {
      parseCustomProperty: true,
      onParseError: () => {
        parseError = true;
      },
    });
  } catch {
    return false;
  }
  if (parseError) return false;
  if (ast.type !== 'StyleSheet') return false;

  // The top level may only contain rules; walk the stylesheet's own children so
  // descendant nodes (selectors, values, functions) are not mistaken for
  // top-level constructs.
  return listToArray(ast.children).every((node) => isAllowedThemeRule(node));
}

/** css-tree's `List` is not an Array; materialise it for `every`. */
function listToArray(list: csstree.List<CssNode>): CssNode[] {
  const nodes: CssNode[] = [];
  list.forEach((node) => nodes.push(node));
  return nodes;
}

/** A top-level rule must be `:root`/`.dark` and only declare `--*` tokens. */
function isAllowedThemeRule(node: CssNode): boolean {
  if (node.type !== 'Rule') return false;
  const selector = csstree.generate(node.prelude).trim();
  if (selector !== ':root' && selector !== '.dark') return false;

  return listToArray(node.block.children).every((child) => {
    if (child.type !== 'Declaration') return false;
    if (!child.property.startsWith('--')) return false;
    const value = csstree.generate(child.value).trim();
    // A token with no value is meaningless (and often the residue of an
    // unclosed block), so reject it rather than storing `--x:`.
    if (value.length === 0) return false;
    // Reject backslash escapes (e.g. `\75rl(`) that can hide url()/@ injections.
    return !(/url\(|@|expression\(|<\//i.test(value) || value.includes('\\'));
  });
}

/** Parse and validate an uploaded theme ZIP; return files to write on success. */
export function parseThemeZip(
  buffer: Buffer,
  signingPublicKey = env.STACKPANEL_SIGNING_PUBLIC_KEY,
): {
  manifest: ThemeManifest;
  files: Map<string, Uint8Array>;
} {
  let all: Record<string, Uint8Array>;
  try {
    let fileCount = 0;
    let totalBytes = 0;
    all = unzipSync(buffer, {
      filter(file) {
        fileCount += 1;
        totalBytes += file.originalSize;
        if (fileCount > MAX_ARCHIVE_FILES) {
          throw new ThemeError(422, '主题包文件数量超出限制');
        }
        if (file.originalSize > MAX_ASSET_BYTES) {
          throw new ThemeError(422, `主题包内文件过大：${file.name}`);
        }
        if (totalBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
          throw new ThemeError(422, '主题包解压后体积超出限制');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ThemeError) throw err;
    throw new ThemeError(400, '无效的 ZIP 压缩包');
  }

  const files = new Map<string, Uint8Array>();
  const frontendFiles = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(all)) {
    if (name.endsWith('/') || data.length === 0) continue;
    if (!isSafeEntryName(name)) throw new ThemeError(422, `非法的文件名：${name}`);
    if (name.startsWith('frontend/')) {
      if (!isAllowedFrontendFile(name)) {
        throw new ThemeError(422, `非法的前端文件：${name}`);
      }
      frontendFiles.set(name, data);
      continue;
    }
    if (isForbiddenFile(name)) throw new ThemeError(422, `不允许包含可执行文件：${name}`);
    files.set(name, data);
  }

  if (frontendFiles.size > 0) {
    try {
      validateFrontendFiles(frontendFiles);
    } catch (err) {
      if (err instanceof FrontendError) {
        throw new ThemeError(err.status, err.message);
      }
      throw err;
    }
    for (const [name, data] of frontendFiles) {
      files.set(name, data);
    }
  }

  const manifestRaw = files.get('theme.json');
  const cssRaw = files.get('theme.css');
  if (!manifestRaw) throw new ThemeError(422, '缺少 theme.json');
  if (!cssRaw) throw new ThemeError(422, '缺少 theme.css');

  let manifest: ThemeManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as ThemeManifest;
  } catch {
    throw new ThemeError(422, 'theme.json 不是有效的 JSON');
  }
  if (
    typeof manifest.id !== 'string' ||
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    !THEME_ID_PATTERN.test(manifest.id)
  ) {
    throw new ThemeError(422, 'theme.json 必须声明合法的 id/name/version');
  }
  if (manifest.id === 'default') throw new ThemeError(422, 'default 主题 ID 已被保留');

  const css = new TextDecoder().decode(cssRaw);
  if (css.length > MAX_THEME_CSS_BYTES) throw new ThemeError(422, 'theme.css 文件过大');
  if (!validateThemeCss(css)) {
    throw new ThemeError(422, 'theme.css 只能包含 :root/.dark 的 token 声明');
  }

  for (const [name, data] of files.entries()) {
    if (!name.startsWith('assets/')) continue;
    if (data.length > MAX_ASSET_BYTES) throw new ThemeError(422, `资源文件过大：${name}`);
  }

  try {
    verifyPackageSignature(files, signingPublicKey);
  } catch (err) {
    if (err instanceof SignatureError) throw new ThemeError(422, err.message);
    throw err;
  }

  return { manifest, files };
}

/** Write the validated theme files to disk. */
export async function writeThemeFiles(id: string, files: Map<string, Uint8Array>): Promise<void> {
  const dir = themePackageDir(id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, data] of files.entries()) {
    const target = safeJoin(dir, name);
    if (!target) throw new ThemeError(422, `非法的文件名：${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

export async function removeThemeFiles(id: string): Promise<void> {
  await rm(themePackageDir(id), { recursive: true, force: true });
}

/** Copy the built-in default theme package into the data dir. */
export async function seedDefaultTheme(): Promise<void> {
  const sourceRoot = resolveDefaultThemeRoot();
  const sourceCss = path.join(sourceRoot, 'theme.css');
  const sourceManifest = path.join(sourceRoot, 'theme.json');
  try {
    const css = await readFile(sourceCss);
    const manifest = await readFile(sourceManifest);
    const dir = themePackageDir('default');
    await mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, 'theme.css'), css);
    await writeAtomic(path.join(dir, 'theme.json'), manifest);
    const frontendSource = path.join(sourceRoot, 'frontend');
    if (existsSync(frontendSource)) {
      const frontendTarget = path.join(dir, 'frontend');
      await mkdir(frontendTarget, { recursive: true });
      const frontendManifest = path.join(frontendSource, 'manifest.json');
      if (existsSync(frontendManifest)) {
        await writeAtomic(
          path.join(frontendTarget, 'manifest.json'),
          await readFile(frontendManifest),
        );
      }
      const frontendDist = path.join(frontendSource, 'dist');
      if (existsSync(frontendDist)) {
        await cp(frontendDist, path.join(frontendTarget, 'dist'), { recursive: true });
      }
    }
    // Copy brand assets recursively so nested asset folders are preserved; the
    // previous non-recursive copy silently broke when any asset subdirectory was
    // present. Remove the target first so assets deleted upstream do not linger
    // in the seeded package.
    const assetsSource = path.join(sourceRoot, 'assets');
    if (existsSync(assetsSource)) {
      const assetsTarget = path.join(dir, 'assets');
      await rm(assetsTarget, { recursive: true, force: true });
      await cp(assetsSource, assetsTarget, { recursive: true });
    }
  } catch {
    // No default theme package available at runtime; callers fall back gracefully.
  }
}

/** Write via a temp file + atomic rename so concurrent readers never see a partial file. */
async function writeAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}

/** Resolve packages/themes/default regardless of the process working directory. */
function resolveDefaultThemeRoot(): string {
  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, 'packages', 'themes', 'default'),
    path.join(cwd, '..', '..', 'packages', 'themes', 'default'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(cwd, 'packages', 'themes', 'default');
}

export class ThemeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
