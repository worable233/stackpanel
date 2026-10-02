import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Allowed image extensions (kept as a hint for upload validation). */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_BRAND_FILE_BYTES = 1024 * 1024;

export type BrandKind = 'logo' | 'favicon';

function storageKey(kind: BrandKind): string {
  return `brand/${kind}`;
}

/** Directory where the built-in default icons live in the API package. */
function defaultAssetsDir(): string {
  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, 'assets', 'brand'),
    path.join(cwd, '..', 'assets', 'brand'),
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
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    throw new BrandError(415, `${kind === 'logo' ? 'logo' : 'favicon'} 仅支持图片文件`);
  }
  if (data.length === 0) throw new BrandError(400, '文件为空');
  if (data.length > MAX_BRAND_FILE_BYTES) {
    throw new BrandError(413, `${kind === 'logo' ? 'logo' : 'favicon'} 必须小于 1MB`);
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

/** Seed the built-in default icons into storage so they are always present. */
export async function seedDefaultBrand(): Promise<void> {
  const storage = getStorage();
  for (const kind of ['logo', 'favicon'] as const) {
    if (await storage.exists(storageKey(kind))) continue;
    const defaults = await readDefaultBrandFile(kind).catch(() => null);
    if (!defaults) continue;
    await storage.put(storageKey(kind), defaults, { contentType: detectContentType(defaults) });
  }
}

async function readDefaultBrandFile(kind: BrandKind): Promise<Buffer> {
  const defaultPath = path.join(defaultAssetsDir(), `${kind}.png`);
  return readFile(defaultPath);
}

/** Detect an image content type from leading magic bytes. */
function detectContentType(data: Uint8Array): string {
  const head = Buffer.from(data.subarray(0, 8));
  if (head.subarray(0, 5).toString('ascii') === '<?xml') return 'image/svg+xml';
  if (head.toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (head.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (head.subarray(0, 2).toString('hex') === 'ffd8') return 'image/jpeg';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
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
