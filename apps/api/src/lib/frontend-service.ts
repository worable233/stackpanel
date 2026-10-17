import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import type { PrismaClient } from '@stackpanel/db';
import type { FrontendDescriptor, FrontendSettings, SettingsSchemaResponse } from '@stackpanel/sdk';
import {
  IMMUTABLE_CACHE_CONTROL,
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
import { readRevisionObject, type FrontendPackageKind } from './frontend-storage.ts';
import {
  ensureCurrentRevision,
  readCurrentRevision,
  resolveRevisionAsset,
  revisionDir,
} from './frontend-revisions.ts';

/** Build the public frontend descriptor response for a package directory. */
export async function frontendDescriptor(packageDir: string): Promise<FrontendDescriptor> {
  const manifest = await readFrontendManifest(packageDir);
  if (!manifest) return { available: false, manifest: null };
  // Ensure the flat frontend has a revision published (idempotent). Failure is
  // non-fatal: the descriptor still serves the manifest, just unversioned.
  let revision = (await readCurrentRevision(packageDir))?.revision;
  if (!revision) {
    try {
      revision = (await ensureCurrentRevision(packageDir))?.revision;
    } catch {
      revision = undefined;
    }
  }
  return {
    available: true,
    manifest,
    ...(revision ? { revision } : {}),
  };
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

/**
 * Serve a **versioned** frontend asset from an immutable revision directory
 * (contract 04 §1/§2). Returns 404 when the revision is unknown or the asset
 * is absent. The legacy unversioned route remains via {@link serveFrontendFile}.
 */
export async function serveRevisionFile(
  reply: FastifyReply,
  packageDir: string,
  revision: string,
  asset: string,
  origin?: { kind: FrontendPackageKind; id: string },
): Promise<FastifyReply> {
  const full = resolveRevisionAsset(packageDir, revision, asset);
  if (!full) return reply.code(400).send({ error: '非法的前端路径' });
  try {
    const data = await readFile(full);
    // Content-addressed: the bytes for a revision never change.
    reply.header('ETag', frontendAssetEtag(revision, asset));
    reply.header('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    reply.header('Vary', 'Accept-Encoding');
    return reply.type(frontendAssetContentType(asset)).send(data);
  } catch {
    // Contract 04 §9: a replica without a shared volume may not have localized
    // the revision yet. Fall back to the object-storage copy so an already-open
    // tab keeps resolving its chunks while the local materialization catches up.
    if (origin) {
      const stored = await readRevisionObject(origin.kind, origin.id, revision, asset).catch(
        () => null,
      );
      if (stored) {
        reply.header('ETag', frontendAssetEtag(revision, asset));
        reply.header('Cache-Control', IMMUTABLE_CACHE_CONTROL);
        return reply.type(frontendAssetContentType(asset)).send(Buffer.from(stored));
      }
    }
    return reply.code(404).send({ error: '资源不存在' });
  }
}

/**
 * Localize a revision into the local data dir from object storage when it is
 * missing here (contract 04 §9). Idempotent and a no-op with a shared volume.
 */
export async function ensureRevisionLocalized(
  kind: FrontendPackageKind,
  id: string,
  packageDir: string,
  revision: string,
): Promise<boolean> {
  if (revisionExists(packageDir, revision)) return true;
  const { localizeRevisionFromStorage } = await import('./frontend-storage.ts');
  const result = await localizeRevisionFromStorage(kind, id, revision, packageDir).catch(
    () => null,
  );
  return result !== null;
}

/** Whether a materialized revision directory exists for the package. */
export function revisionExists(packageDir: string, revision: string): boolean {
  return existsSync(path.join(revisionDir(packageDir, revision), '.ready'));
}
