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

/**
 * Allowed image extensions.
 *
 * `.ico` is here because a favicon is *usually* an ICO: a 64×64 ICO holding 16/32/48
 * sub-images is the single most common thing an operator uploads, and it was the
 * one format the upload rejected.
 */
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
]);
const MAX_BRAND_FILE_BYTES = 1024 * 1024;

/**
 * Human-readable list of the formats an upload actually accepts.
 *
 * Built from the set above on purpose: the old copy just said 「仅支持图片文件」
 * while rejecting a plain `.ico`, so the message told the operator nothing about
 * what to convert to. A list that is generated cannot drift from the check.
 */
const ALLOWED_IMAGE_SUMMARY = [...ALLOWED_IMAGE_EXTENSIONS]
  .map((ext) => ext.slice(1))
  .join('/');

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
  const label = kind === 'logo' ? 'logo' : 'favicon';
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    // Name the formats instead of saying 「仅支持图片文件」: .ico *is* an image, so the
    // vague version left the operator with nothing actionable.
    throw new BrandError(415, `${label} 仅支持 ${ALLOWED_IMAGE_SUMMARY}，且小于 1MB`);
  }
  if (data.length === 0) throw new BrandError(400, '文件为空');
  if (data.length > MAX_BRAND_FILE_BYTES) {
    throw new BrandError(413, `${label} 必须小于 1MB`);
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
