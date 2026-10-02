import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import type { PrismaClient } from '@stackpanel/db';
import type { FrontendDescriptor, FrontendSettings, SettingsSchemaResponse } from '@stackpanel/sdk';
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

/** Serve a file from a package's compiled frontend directory. */
export async function serveFrontendFile(
  reply: FastifyReply,
  packageDir: string,
  asset: string,
): Promise<FastifyReply> {
  const frontendRoot = path.join(packageDir, 'frontend');
  const full = path.resolve(frontendRoot, asset);
  if (!full.startsWith(frontendRoot + path.sep)) {
    return reply.code(400).send({ error: '非法的前端路径' });
  }
  try {
    const data = await readFile(full);
    const contentType =
      asset.endsWith('.js') || asset.endsWith('.mjs')
        ? 'text/javascript; charset=utf-8'
        : asset.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream';
    return reply.type(contentType).send(data);
  } catch {
    return reply.code(404).send({ error: '资源不存在' });
  }
}
