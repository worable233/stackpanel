import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  brandFileUrl,
  BrandError,
  clearBrandFile,
  readBrandFiles,
  validateBrandFile,
  writeBrandFile,
} from '../lib/platform-brand.ts';
import { getPlatformInfo, setPlatformInfo } from '../lib/platform-info.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { requireAuth, requireRole } from '../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const platformInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(280),
    url: z
      .string()
      .trim()
      .max(2048)
      .nullable()
      .transform((value) => value || null)
      .refine((value) => value === null || isHttpUrl(value), 'Platform URL must use HTTP or HTTPS'),
  })
  .strict();

/** Public platform identity plus the separate admin-only mutation surface. */
export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform/info', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return { platform: await getPlatformInfo() };
  });

  app.get('/admin/platform/info', { preHandler: adminOnly }, async () => ({
    platform: await getPlatformInfo(),
  }));

  app.patch('/admin/platform/info', { preHandler: adminOnly }, async (request, reply) => {
    const body = platformInfoSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '平台信息参数无效' });
    const platform = await setPlatformInfo(body.data, request.user?.id ?? null);
    await writeAudit({
      action: 'platform.info.update',
      resource: 'platform',
      meta: { name: platform.name, url: platform.url },
      ...auditContext(request),
    });
    return { platform };
  });

  // --- Platform brand (logo + favicon) -------------------------------------

  /** Public brand identity: API-relative URLs for the current logo/favicon. */
  app.get('/platform/brand', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return {
      brand: {
        logo: brandFileUrl('logo'),
        favicon: brandFileUrl('favicon'),
      },
    };
  });

  /** Serve the current brand file (uploaded variant or seeded default). */
  app.get('/platform/brand/:kind', async (request, reply) => {
    const kind = (request.params as { kind?: string }).kind;
    if (kind !== 'logo' && kind !== 'favicon') return reply.code(404).send({ error: '资源不存在' });
    const files = await readBrandFiles();
    const data = files[kind];
    if (!data) return reply.code(404).send({ error: '资源不存在' });
    reply.header('Cache-Control', 'public, max-age=3600');
    return sendBrandFile(reply, data);
  });

  /** Upload platform logo/favicon (multipart fields `logo` / `favicon`). */
  app.post('/admin/platform/brand', { preHandler: adminOnly }, async (request, reply) => {
    const changes: string[] = [];
    try {
      for (const kind of ['logo', 'favicon'] as const) {
        const part = await request.file();
        if (!part) continue;
        const field = part.fieldname;
        if (field !== 'logo' && field !== 'favicon') continue;
        const data = await part.toBuffer();
        const ext = validateBrandFile(kind, part.filename, data);
        await writeBrandFile(kind, ext, data);
        changes.push(kind);
      }
    } catch (err) {
      if (err instanceof BrandError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
    if (changes.length === 0) {
      return reply.code(400).send({ error: '请选择要上传的图片文件' });
    }
    await writeAudit({
      action: 'platform.brand.update',
      resource: 'platform',
      meta: { updated: changes },
      ...auditContext(request),
    });
    return {
      brand: {
        logo: brandFileUrl('logo'),
        favicon: brandFileUrl('favicon'),
      },
    };
  });

  /** Clear uploaded platform brand files, restoring the built-in defaults. */
  app.delete('/admin/platform/brand', { preHandler: adminOnly }, async (request) => {
    await clearBrandFile('logo');
    await clearBrandFile('favicon');
    await writeAudit({
      action: 'platform.brand.clear',
      resource: 'platform',
      meta: { cleared: ['logo', 'favicon'] },
      ...auditContext(request),
    });
    return {
      brand: {
        logo: brandFileUrl('logo'),
        favicon: brandFileUrl('favicon'),
      },
    };
  });
}

async function sendBrandFile(reply: FastifyReply, data: Buffer) {
  // All seeded/validated uploads are PNG at minimum; detect from magic bytes.
  const isSvg = data.length > 4 && data.subarray(0, 5).toString('ascii') === '<?xml';
  const isPng = data.length > 8 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (isSvg) return reply.type('image/svg+xml').send(data);
  if (isPng) return reply.type('image/png').send(data);
  return reply.type('image/webp').send(data);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
