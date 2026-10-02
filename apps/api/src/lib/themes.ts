import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
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

function validateTokenBlock(inner: string): boolean {
  const declarations = inner
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const declaration of declarations) {
    if (!/^--[a-zA-Z0-9_-]+\s*:/.test(declaration)) return false;
    // Reject backslash escapes (e.g. `\75rl(`) that can hide url()/@ injections.
    if (/url\(|@|expression\(|<\//i.test(declaration) || declaration.includes('\\')) return false;
  }
  return true;
}

/**
 * Validate a theme CSS file: only `:root` and `.dark` blocks are allowed, each
 * containing token-only `--*` custom property declarations. Anything else
 * (at-rules, selectors, url()) is rejected — themes are configuration, not code.
 */
export function validateThemeCss(css: string): boolean {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  let result = cleaned
    .replace(/:root\s*\{([\s\S]*?)\}/gi, (_m, inner: string) =>
      validateTokenBlock(inner) ? '' : 'INVALID',
    )
    .replace(/\.dark\s*\{([\s\S]*?)\}/gi, (_m, inner: string) =>
      validateTokenBlock(inner) ? '' : 'INVALID',
    );
  result = result.replace(/\s+/g, '');
  return result.length === 0 && !result.includes('INVALID');
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
    const assetsSource = path.join(sourceRoot, 'assets');
    const assetEntries = await readdir(assetsSource).catch(() => []);
    for (const entry of assetEntries) {
      await mkdir(path.join(dir, 'assets'), { recursive: true });
      await writeAtomic(
        path.join(dir, 'assets', entry),
        await readFile(path.join(assetsSource, entry)),
      );
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
