import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import type { PrismaClient } from '@stackpanel/db';
import type { FrontendDescriptor, FrontendSettings, SettingsSchemaResponse } from '@stackpanel/sdk';
import {
  frontendAssetCacheControl,
  frontendAssetContentType,
  frontendAssetEtag,
  isAllowedFrontendAsset,
  resolveFrontendAsset,
} from './frontend-assets.ts';
import {
  frontendSettingKey,
  readStoredFrontendSettings,
  resolveFrontendSettings,
  saveFrontendSettings,
  type FrontendKind,
} from './frontend-settings.ts';
import { readFrontendManifest } from './frontend.ts';

/** Build the public frontend descriptor response for a package directory. */
export async function frontendDescriptor(packageDir: string): Promise<FrontendDescriptor> {
  const manifest = await readFrontendManifest(packageDir);
  return manifest ? { available: true, manifest } : { available: false, manifest: null };
}

/** Build the settings schema response for a package directory. */
export async function settingsSchemaDescriptor(
  packageDir: string,
): Promise<SettingsSchemaResponse> {
  const manifest = await readFrontendManifest(packageDir);
  return { schema: manifest?.settingsSchema ?? null };
}

/** Read merged settings from the settings table plus schema defaults. */
export async function resolvedFrontendSettings(
  prisma: PrismaClient,
  kind: FrontendKind,
  id: string,
  packageDir: string,
): Promise<FrontendSettings> {
  const manifest = await readFrontendManifest(packageDir);
  if (!manifest?.settingsSchema) return {};
  const stored = await readStoredFrontendSettings(prisma, frontendSettingKey(kind, id));
  return resolveFrontendSettings(manifest.settingsSchema, stored);
}

/** Validate, persist and return a frontend settings update. */
export async function updateFrontendSettings(
  prisma: PrismaClient,
  kind: FrontendKind,
  id: string,
  packageDir: string,
  patch: FrontendSettings,
  updatedBy: string | null,
): Promise<FrontendSettings> {
  const manifest = await readFrontendManifest(packageDir);
  if (!manifest?.settingsSchema) throw new Error('该包没有设置 schema');
  const key = frontendSettingKey(kind, id);
  const current = await readStoredFrontendSettings(prisma, key);
  return saveFrontendSettings(prisma, key, manifest.settingsSchema, current, patch, updatedBy);
}

/**
 * Serve a compiled frontend asset under the versioned transport contract (§6.6).
 *
 * `asset` is the `.../frontend/*` wildcard segment. Supports both:
 * - versioned `"<revision>/<file>"` — validated against the manifest revision,
 *   served `immutable` (content-addressed);
 * - legacy `"<file>"` — `no-cache` + ETag, revalidated because the revision may
 *   change across reinstalls.
 *
 * Only files declared in `manifest.files[]` (plus `manifest.json`) are served.
 */
export async function serveFrontendFile(
  reply: FastifyReply,
  packageDir: string,
  asset: string,
): Promise<FastifyReply> {
  const manifest = await readFrontendManifest(packageDir);
  if (!manifest) return reply.code(404).send({ error: '前端资源不存在' });

  const resolution = resolveFrontendAsset(manifest, asset);
  if (!resolution.ok) return reply.code(resolution.status).send({ error: resolution.reason });
  const { asset: relAsset } = resolution.value;

  if (!isAllowedFrontendAsset(manifest, relAsset)) {
    return reply.code(404).send({ error: '前端资源不存在' });
  }

  const frontendRoot = path.join(packageDir, 'frontend');
  const full = path.resolve(frontendRoot, relAsset);
  if (!full.startsWith(frontendRoot + path.sep)) {
    return reply.code(400).send({ error: '非法的前端路径' });
  }
  // `manifest.files[]` are package-root-relative; the whitelist check above
  // normalises them to the frontend-relative form.
  try {
    const data = await readFile(full);
    const etag = frontendAssetEtag(manifest.revision, relAsset);
    reply.header('ETag', etag);
    reply.header('Cache-Control', frontendAssetCacheControl(resolution.value));
    // The versioned form is immutable; the legacy form is revalidated via ETag.
    reply.header('Vary', 'Accept-Encoding');
    return reply.type(frontendAssetContentType(relAsset)).send(data);
  } catch {
    return reply.code(404).send({ error: '资源不存在' });
  }
}
