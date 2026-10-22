import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Prisma } from '@stackpanel/db';
import { z } from 'zod';
import { frontendSettingsValueSchema } from '@stackpanel/sdk';

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
import {
  parseThemeZip,
  removeThemeFiles,
  seedDefaultTheme,
  themeAssetPath,
  themeCssPath,
  themeManifestPath,
  themePackageDir,
  ThemeError,
  THEME_ID_PATTERN,
  writeThemeFiles,
} from '../lib/themes.ts';
import {
  frontendDescriptor,
  resolvedFrontendSettings,
  serveFrontendFile,
  serveRevisionFile,
  settingsSchemaDescriptor,
} from '../lib/frontend-service.ts';
import { isRevisionName } from '../lib/frontend-revisions.ts';
import { settingsErrorToMessage } from '../lib/frontend-settings.ts';
import { contentDisposition } from '../media/service.ts';
import { isActiveContent } from '../media/disposition.ts';
import { frontendSummary, readFrontendManifest } from '../lib/frontend.ts';
import { notifyLifecycle } from '../notifications/lifecycle-notifications.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { readSigningPublicKey } from '../lib/signing-settings.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { requireAuth, requireRole } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { themeConfigurationRoutes } from './theme-configuration.ts';
import { saveThemeConfiguration } from '../lib/theme-configuration.ts';
import { publishRuntimeChange } from '../runtime/coherence.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const idSchema = z.object({ id: z.string().regex(THEME_ID_PATTERN) });
const patchBodySchema = z.object({ active: z.boolean() });
const previewBodySchema = z.object({ themeId: z.string().regex(THEME_ID_PATTERN) });
const THEME_PREVIEW_KEY = 'theme.preview';
const settingsPatchSchema = z
  .object({
    settings: frontendSettingsValueSchema,
    expectedVersion: z.string().length(64).optional(),
  })
  .strict();

/** Seed the built-in default theme and ensure exactly one theme is active. */
export async function initThemes(): Promise<void> {
  const prisma = getPrisma();
  await seedDefaultTheme();
  const manifest = await readDefaultManifest();
  const name = manifest?.name ?? 'StackPanel Default';
  const version = manifest?.version ?? '0.0.1';
  const existing = await prisma.theme.findUnique({ where: { id: 'default' } });
  if (existing) {
    await prisma.theme.update({ where: { id: 'default' }, data: { name, version } });
  } else {
    try {
      await prisma.theme.create({
        data: { id: 'default', name, version, isDefault: true, active: true },
      });
    } catch {
      // Concurrent boot seeding across processes: another instance created it.
    }
  }
  const activeCount = await prisma.theme.count({ where: { active: true } });
  if (activeCount === 0) {
    await prisma.theme.updateMany({ where: { id: 'default' }, data: { active: true } });
  }
}

/** Read the default theme manifest defensively; never crash on a partial file. */
async function readDefaultManifest(): Promise<{ name?: string; version?: string } | null> {
  try {
    const raw = await readFile(themeManifestPath('default'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    const result: { name?: string; version?: string } = {};
    if (typeof parsed.name === 'string') result.name = parsed.name;
    if (typeof parsed.version === 'string') result.version = parsed.version;
    return result;
  } catch {
    return null;
  }
}

/** Interface locales a theme declares in its `theme.json` (ADR-0016 §5). */
async function themeLocales(id: string): Promise<string[]> {
  try {
    const raw = await readFile(themeManifestPath(id), 'utf8');
    const parsed = JSON.parse(raw) as { locales?: unknown };
    return Array.isArray(parsed.locales)
      ? parsed.locales.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function publicTheme(row: { id: string; name: string; version: string; active: boolean }) {
  return { id: row.id, name: row.name, version: row.version, active: row.active };
}

/** Relative brand asset URLs declared by a theme manifest (`assets/*` served by the API). */
async function themeBrandAssets(
  id: string,
): Promise<{ logo: string | null; favicon: string | null }> {
  const empty = { logo: null, favicon: null };
  try {
    const raw = await readFile(themeManifestPath(id), 'utf8');
    const manifest = JSON.parse(raw) as { assets?: { logo?: unknown; favicon?: unknown } };
    const assets = manifest.assets;
    if (!assets) return empty;
    const logo = typeof assets.logo === 'string' ? assets.logo : null;
    const favicon = typeof assets.favicon === 'string' ? assets.favicon : null;
    return {
      logo: logo
        ? `/themes/${encodeURIComponent(id)}/assets/${logo.replace(/^assets\//, '')}`
        : null,
      favicon: favicon
        ? `/themes/${encodeURIComponent(id)}/assets/${favicon.replace(/^assets\//, '')}`
        : null,
    };
  } catch {
    return empty;
  }
}

async function publicThemeWithBrand(row: {
  id: string;
  name: string;
  version: string;
  active: boolean;
}): Promise<{
  id: string;
  name: string;
  version: string;
  active: boolean;
  locales: string[];
  assets: Awaited<ReturnType<typeof themeBrandAssets>>;
}> {
  const [assets, locales] = await Promise.all([themeBrandAssets(row.id), themeLocales(row.id)]);
  return { ...publicTheme(row), locales, assets };
}

async function serveFile(
  reply: FastifyReply,
  fullPath: string,
  contentType: string,
  inline = true,
): Promise<FastifyReply> {
  try {
    const data = await readFile(fullPath);
    // Active content (SVG/HTML) is served as a download so a browser never
    // executes an uploaded theme asset same-origin (security audit
    // L-3), matching the attachment policy in `media/routes.ts`.
    if (!inline) {
      reply.header('Content-Disposition', contentDisposition(path.basename(fullPath), false));
    }
    return reply.type(contentType).send(data);
  } catch {
    return reply.code(404).send({ error: '资源不存在' });
  }
}

/**
 * Theme engine: dynamic ZIP theme packages. Files live on disk under
 * data/themes/<id>/; the themes table tracks installation and activation.
 */
export async function themeRoutes(app: FastifyInstance): Promise<void> {
  await themeConfigurationRoutes(app);
  app.get('/themes', async () => {
    const prisma = getPrisma();
    const rows = await prisma.theme.findMany({ orderBy: { installedAt: 'asc' } });
    return { themes: await Promise.all(rows.map(publicThemeWithBrand)) };
  });

  app.get('/themes/active', async () => {
    const prisma = getPrisma();
    const active = await prisma.theme.findFirst({ where: { active: true } });
    if (!active) return { theme: null };
    return { theme: await publicThemeWithBrand(active) };
  });

  app.get('/themes/:id/theme.css', { ...rateLimitConfig('publicRead') }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const prisma = getPrisma();
    const row = await prisma.theme.findUnique({ where: { id: params.data.id } });
    if (!row) return reply.code(404).send({ error: '主题不存在' });
    return serveFile(reply, themeCssPath(params.data.id), 'text/css; charset=utf-8');
  });

  app.get('/themes/:id/manifest.json', async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    return serveFile(reply, themeManifestPath(params.data.id), 'application/json');
  });

  app.get('/themes/:id/frontend', async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const packageDir = themePackageDir(params.data.id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '主题不存在' });
    return frontendDescriptor(packageDir);
  });

  app.get('/themes/:id/frontend/*', async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const asset = (request.params as { '*': string })['*'];
    if (!params.success || !asset) return reply.code(400).send({ error: '请求参数无效' });
    const packageDir = themePackageDir(params.data.id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '主题不存在' });
    // Contract 04 §2: a hex-digest head selects the versioned revision store;
    // `dist/**` (legacy) serves the flat frontend.
    const [head, ...tail] = asset.split('/');
    if (head && isRevisionName(head) && tail.length > 0) {
      return serveRevisionFile(reply, packageDir, head, tail.join('/'), {
        kind: 'themes',
        id: params.data.id,
      });
    }
    if (asset.includes('..') || asset.includes('\\')) {
      return reply.code(400).send({ error: '非法的前端路径' });
    }
    return serveFrontendFile(reply, packageDir, asset);
  });

  app.get('/themes/:id/settings-schema', async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const packageDir = themePackageDir(params.data.id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '主题不存在' });
    return settingsSchemaDescriptor(packageDir);
  });

  app.get('/themes/:id/settings', async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const packageDir = themePackageDir(params.data.id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '主题不存在' });
    const settings = await resolvedFrontendSettings(
      getPrisma(),
      'theme',
      params.data.id,
      packageDir,
    );
    return { settings };
  });

  app.get('/themes/:id/assets/*', { ...rateLimitConfig('publicRead') }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const asset = (request.params as { '*': string })['*'];
    if (!params.success || !asset) return reply.code(400).send({ error: '请求参数无效' });
    if (asset.includes('..') || asset.includes('\\')) {
      return reply.code(400).send({ error: '非法的资源路径' });
    }
    const assetsDir = themeAssetPath(params.data.id, '');
    const full = path.join(assetsDir, asset);
    if (!full.startsWith(assetsDir + path.sep)) {
      return reply.code(400).send({ error: '非法的资源路径' });
    }
    const contentType =
      ASSET_CONTENT_TYPES[path.extname(asset).toLowerCase()] ?? 'application/octet-stream';
    return serveFile(reply, full, contentType, !isActiveContent(contentType));
  });

  app.get('/admin/themes', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const rows = await prisma.theme.findMany({ orderBy: { installedAt: 'asc' } });
    const themes = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        assets: await themeBrandAssets(row.id),
        locales: await themeLocales(row.id),
        frontend: frontendSummary(await readFrontendManifest(themePackageDir(row.id))),
        signed: existsSync(path.join(themePackageDir(row.id), 'signature.json')),
      })),
    );
    return { themes };
  });

  app.post(
    '/admin/themes',
    { preHandler: adminOnly, ...rateLimitConfig('upload') },
    async (request, reply) => {
      let data: Buffer;
      try {
        const part = await request.file();
        if (!part) return reply.code(400).send({ error: '未上传文件' });
        data = await part.toBuffer();
      } catch {
        return reply.code(413).send({ error: '文件过大或不是有效的 multipart 表单' });
      }
      let themeInfo: { id: string; name: string; version: string } | null = null;
      try {
        const { manifest, files } = parseThemeZip(data, await readSigningPublicKey());
        themeInfo = { id: manifest.id, name: manifest.name, version: manifest.version };
        const prisma = getPrisma();
        const existing = await prisma.theme.findUnique({ where: { id: manifest.id } });
        const upgraded = Boolean(existing);
        // 主题与插件共用同一安装事务：先把完整产物暂存，再提交 DB 指针（§7、§13-3）。
        const fileWrite = await writeThemeFiles(manifest.id, files);
        let theme: { id: string; name: string; version: string; active: boolean };
        try {
          theme = existing
            ? await prisma.theme.update({
                where: { id: manifest.id },
                data: { name: manifest.name, version: manifest.version },
              })
            : await prisma.theme.create({
                data: {
                  id: manifest.id,
                  name: manifest.name,
                  version: manifest.version,
                  active: false,
                },
              });
        } catch (err) {
          // 文件已暂存但 DB 指针未提交：恢复旧目录（升级时还原旧版本），避免半切换（§7.6）。
          await fileWrite.rollback();
          throw err;
        }
        await fileWrite.commit();
        const frontend = frontendSummary(await readFrontendManifest(themePackageDir(theme.id)));
        const signed = existsSync(path.join(themePackageDir(theme.id), 'signature.json'));
        await writeAudit({
          action: upgraded ? 'theme.upgrade' : 'theme.install',
          resource: 'theme',
          resourceId: manifest.id,
          meta: { name: manifest.name, version: manifest.version },
          ...auditContext(request),
        });
        // 运行期装载：主题前端产物即时生效，无需构建/重启（contract 01 §7）。
        await notifyLifecycle(request.user?.id, {
          target: 'theme',
          action: upgraded ? 'update' : 'install',
          label: manifest.name,
          id: manifest.id,
          version: manifest.version,
          ok: true,
        });
        return reply
          .code(upgraded ? 200 : 201)
          .send({ theme: { ...theme, frontend, signed }, upgraded });
      } catch (err) {
        if (err instanceof ThemeError) {
          await notifyLifecycle(request.user?.id, {
            target: 'theme',
            action: 'install',
            label: themeInfo?.name ?? '未知主题',
            id: themeInfo?.id ?? 'unknown',
            ...(themeInfo?.version ? { version: themeInfo.version } : {}),
            ok: false,
            error: err.message,
          });
          return reply.code(err.status).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.patch('/admin/themes/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const body = patchBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    const prisma = getPrisma();
    const theme = await prisma.theme.findUnique({ where: { id: params.data.id } });
    if (!theme) return reply.code(404).send({ error: '主题不存在' });
    if (body.data.active) {
      await prisma.$transaction([
        prisma.theme.updateMany({ data: { active: false } }),
        prisma.theme.update({ where: { id: theme.id }, data: { active: true } }),
      ]);
      await writeAudit({
        action: 'theme.activate',
        resource: 'theme',
        resourceId: theme.id,
        ...auditContext(request),
      });
      await publishRuntimeChange({ kind: 'theme', id: theme.id, action: 'reload' });
      // 激活不触发前端构建，补一条一次性生命周期通知。
      await notifyLifecycle(request.user?.id, {
        target: 'theme',
        action: 'activate',
        label: theme.name,
        id: theme.id,
        version: theme.version,
        ok: true,
      });
    }
    const updated = await prisma.theme.findUniqueOrThrow({ where: { id: theme.id } });
    return { theme: publicTheme(updated) };
  });

  app.get('/admin/themes/preview', { preHandler: adminOnly }, async () => {
    const row = await getPrisma().setting.findUnique({ where: { key: THEME_PREVIEW_KEY } });
    const value = row?.value as { themeId?: unknown } | null;
    return { themeId: typeof value?.themeId === 'string' ? value.themeId : null };
  });

  app.post('/admin/themes/preview', { preHandler: adminOnly }, async (request, reply) => {
    const body = previewBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const theme = await getPrisma().theme.findUnique({ where: { id: body.data.themeId } });
    if (!theme) return reply.code(404).send({ error: '主题不存在' });
    await getPrisma().setting.upsert({
      where: { key: THEME_PREVIEW_KEY },
      create: {
        key: THEME_PREVIEW_KEY,
        value: { themeId: body.data.themeId } as Prisma.InputJsonValue,
        updatedBy: request.user?.id ?? null,
      },
      update: {
        value: { themeId: body.data.themeId } as Prisma.InputJsonValue,
        updatedBy: request.user?.id ?? null,
      },
    });
    await writeAudit({
      action: 'theme.preview.set',
      resource: 'theme',
      resourceId: body.data.themeId,
      ...auditContext(request),
    });
    return { themeId: body.data.themeId };
  });

  app.delete('/admin/themes/preview', { preHandler: adminOnly }, async (request, reply) => {
    await getPrisma().setting.deleteMany({ where: { key: THEME_PREVIEW_KEY } });
    await writeAudit({
      action: 'theme.preview.clear',
      resource: 'theme',
      ...auditContext(request),
    });
    return reply.code(204).send();
  });

  app.delete('/admin/themes/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const prisma = getPrisma();
    const theme = await prisma.theme.findUnique({ where: { id: params.data.id } });
    if (!theme) return reply.code(404).send({ error: '主题不存在' });
    if (theme.isDefault) return reply.code(400).send({ error: '默认主题不可删除' });
    if (theme.active) return reply.code(400).send({ error: '不能删除当前激活的主题' });
    await removeThemeFiles(theme.id);
    await prisma.theme.delete({ where: { id: theme.id } });
    await writeAudit({
      action: 'theme.delete',
      resource: 'theme',
      resourceId: theme.id,
      ...auditContext(request),
    });
    // 运行期装载：删除后主题前端即时失效，无需构建/重启。
    await notifyLifecycle(request.user?.id, {
      target: 'theme',
      action: 'remove',
      label: theme.name,
      id: theme.id,
      version: theme.version,
      ok: true,
    });
    return reply.code(204).send();
  });

  app.get('/admin/themes/:id/settings', { preHandler: adminOnly }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
    const packageDir = themePackageDir(params.data.id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '主题不存在' });
    const settings = await resolvedFrontendSettings(
      getPrisma(),
      'theme',
      params.data.id,
      packageDir,
    );
    return { settings };
  });

  app.patch('/admin/themes/:id/settings', { preHandler: adminOnly }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const body = settingsPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    const packageDir = themePackageDir(params.data.id);
    if (!existsSync(packageDir)) return reply.code(404).send({ error: '主题不存在' });
    try {
      const { settings } = await saveThemeConfiguration(
        getPrisma(),
        params.data.id,
        body.data.settings,
        request.user?.id ?? null,
        body.data.expectedVersion,
      );
      await writeAudit({
        action: 'theme.settings.update',
        resource: 'theme',
        resourceId: params.data.id,
        ...auditContext(request),
      });
      return { settings };
    } catch (err) {
      return reply.code(422).send({ error: settingsErrorToMessage(err) });
    }
  });
}
