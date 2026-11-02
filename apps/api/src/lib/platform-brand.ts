import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BRAND_IMAGE_EXTENSIONS,
  BRAND_IMAGE_SUMMARY,
  rejectBrandFile,
} from '@stackpanel/sdk';
import { getStorage } from '../infra.ts';

/**
 * Platform-level brand identity (logo + favicon).
 *
 * Bytes live in object storage (ADR-0014 §6) under `brand/<kind>`; the built-in
 * default icons are seeded from the API package's `assets/brand/` directory at
 * startup so the platform always has a valid logo. Uploads overwrite the seeded
 * object; clearing a kind restores the built-in default.
 *
 * Serving stays on the API (`/platform/brand/:kind`) so local-disk and S3
 * deployments expose one stable, same-origin URL.
 */

export interface PlatformBrand {
  logo: string | null;
  favicon: string | null;
}

export interface BrandFiles {
  logo: Buffer | null;
  favicon: Buffer | null;
}

/**
 * Allowed image extensions.
 *
 * 这份名单**不在本文件定义**：它来自 `@stackpanel/sdk` 的 `BRAND_IMAGE_EXTENSIONS`，
 * 前端 `<input accept>` 读的是同一份。两边各写一份就会出现「前端剔掉、后端
 * 收不到、接口还回 200」的假成功。
 */
const ALLOWED_IMAGE_EXTENSIONS = new Set<string>(BRAND_IMAGE_EXTENSIONS);

export type BrandKind = 'logo' | 'favicon';

function storageKey(kind: BrandKind): string {
  return `brand/${kind}`;
}

/**
 * Directory where the built-in default icons live in the API package.
 *
 * Exported for tests: this path resolution is the difference between 「首页有图标」
 * and 「首页的 <link rel="icon"> 指向 404」, and it can only be verified by
 * pointing it at each real working directory.
 */
export function defaultAssetsDir(cwd: string = process.cwd()): string {
  for (const candidate of [
    path.join(cwd, 'assets', 'brand'),
    path.join(cwd, '..', 'assets', 'brand'),
    // Bundled layout：`tsup` 把源码打进了 `dist/index.js`，但 `assets/` 是按
    // 目录相对位置读的。容器里的工作目录是 `/app`，脚本在 `/app/apps/api/dist/`，
    // 所以 `assets/brand` 在 `apps/api/assets/brand`——不列这一条，容器启动时
    // **种子永远静默失败**，`brand/favicon` 从头到尾不存在，首页的
    // `<link rel="icon">` 指向 404。
    path.join(cwd, 'apps', 'api', 'assets', 'brand'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(cwd, 'assets', 'brand');
}

export function brandFileUrl(kind: BrandKind): string {
  return `/platform/brand/${kind}`;
}

/** Validate a potential brand upload and return the safe extension. */
export function validateBrandFile(kind: BrandKind, name: string, data: Buffer): string {
  const label = kind === 'logo' ? 'logo' : 'favicon';
  const ext = path.extname(name).toLowerCase();
  // 与前端共用同一份 `rejectBrandFile`：前端能选中的，这里必须放行。
  const rejection = rejectBrandFile(name, data.length);
  if (rejection === 'unsupported_type') {
    // Name the formats instead of saying 「仅支持图片文件」: .ico *is* an image, so the
    // vague version left the operator with nothing actionable.
    throw new BrandError(415, `${label} 仅支持 ${BRAND_IMAGE_SUMMARY}`);
  }
  if (rejection === 'empty') throw new BrandError(400, '文件为空');
  if (rejection === 'too_large') {
    throw new BrandError(413, `${label} 必须小于 1MB`);
  }
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    // 双保险：`rejectBrandFile` 与这里的集合必须始终一致，不一致说明有人的
    // 扩展名规则改了却只改一边。宁可报错也不要静默写入一个非法扩展名。
    throw new BrandError(415, `${label} 仅支持 ${BRAND_IMAGE_SUMMARY}`);
  }
  return ext;
}

/** Persist an uploaded brand file (replaces the seeded default). */
export async function writeBrandFile(kind: BrandKind, _ext: string, data: Buffer): Promise<void> {
  await getStorage().put(storageKey(kind), data, { contentType: detectContentType(data) });
}

/** Remove the uploaded file for a kind so the built-in default is served again. */
export async function clearBrandFile(kind: BrandKind): Promise<void> {
  await getStorage().delete(storageKey(kind));
}

/** Read the current brand files (uploaded variant, falling back to the seeded default). */
export async function readBrandFiles(): Promise<BrandFiles> {
  const storage = getStorage();
  const result: BrandFiles = { logo: null, favicon: null };
  for (const kind of ['logo', 'favicon'] as const) {
    const stored = await storage.get(storageKey(kind)).catch(() => null);
    if (stored) {
      result[kind] = Buffer.from(stored);
      continue;
    }
    result[kind] = await readDefaultBrandFile(kind).catch(() => null);
  }
  return result;
}

/**
 * Seed the built-in default icons into storage so they are always present.
 *
 * 失败必须留下痕迹。这里原来是 `readDefaultBrandFile(...).catch(() => null)` +
 * `continue`：容器里找不到 `assets/brand` 时，种子**一声不喷**地跳过，于是
 * `/platform/brand/favicon` 从第一次启动就是 404、首页的 `<link rel="icon">`
 * 指向一个不存在的文件，而所有日志都是绿的。
 */
export async function seedDefaultBrand(): Promise<void> {
  const storage = getStorage();
  for (const kind of ['logo', 'favicon'] as const) {
    if (await storage.exists(storageKey(kind))) continue;
    const defaults = await readDefaultBrandFile(kind).catch((error: unknown) => {
      console.error(
        `[brand] 内置 ${kind} 读取失败，${storageKey(kind)} 将保持缺失：` +
          `${error instanceof Error ? error.message : String(error)}（查找目录 ${defaultAssetsDir()}）`,
      );
      return null;
    });
    if (!defaults) continue;
    await storage.put(storageKey(kind), defaults, { contentType: detectContentType(defaults) });
  }
}

async function readDefaultBrandFile(kind: BrandKind): Promise<Buffer> {
  const defaultPath = path.join(defaultAssetsDir(), `${kind}.png`);
  return readFile(defaultPath);
}

/**
 * Detect an image content type from leading magic bytes.
 *
 * Exported because the serving route needs the same answer: writing the object
 * with `image/x-icon` but replying `image/webp` would still leave the browser
 * with a favicon it refuses to render.
 */
export function detectContentType(data: Uint8Array): string {
  const head = Buffer.from(data.subarray(0, 8));
  if (head.subarray(0, 5).toString('ascii') === '<?xml') return 'image/svg+xml';
  if (head.toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (head.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (head.subarray(0, 2).toString('hex') === 'ffd8') return 'image/jpeg';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  // ICO header: reserved(2)=0, type(2)=1. Without this the object was stored as
  // `application/octet-stream`, which S3/CDN faithfully echoed and some browsers
  // then refused to render as a favicon.
  if (head.subarray(0, 4).toString('hex') === '00000100') return 'image/x-icon';
  return 'application/octet-stream';
}

export class BrandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
