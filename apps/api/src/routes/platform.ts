import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  type BrandKind,
  brandFileUrl,
  BrandError,
  clearBrandFile,
  detectContentType,
  readBrandFiles,
  validateBrandFile,
  writeBrandFile,
} from '../lib/platform-brand.ts';
import { getPlatformInfo, setPlatformInfo } from '../lib/platform-info.ts';
import { buildProblem } from '../lib/problem.ts';
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
    brandDisplay: z.enum(['icon', 'name', 'both']).default('both'),
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
      meta: { name: platform.name, url: platform.url, brandDisplay: platform.brandDisplay },
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
      // 与**表单字段名**对齐，而不是拿循环变量当类型。原来的写法把
      // `kind` 当作存储目标，而 `kind` 只是循环下标：只传 favicon 时，第一个
      // part 的 `fieldname` 是 `favicon`，但 `kind` 是 `logo`，于是 favicon
      // 的字节被写进了 `brand/logo`，而 `brand/favicon` 保持默认——
      // 用户上传成功、看到「已保存」，图标却根本没变。
      while (true) {
        const part = await request.file().catch(() => null);
        if (!part) break;
        const field = part.fieldname;
        if (field !== 'logo' && field !== 'favicon') {
          // 排空丢弃，否则 multipart 流会卡在下一个 part。
          await part.toBuffer().catch(() => undefined);
          continue;
        }
        const kind: BrandKind = field;
        const data = await part.toBuffer();
        const ext = validateBrandFile(kind, part.filename, data);
        await writeBrandFile(kind, ext, data);
        changes.push(kind);
      }
    } catch (err) {
      if (err instanceof BrandError) {
        // 走 problem-details 而不是 `{ error }`：只有带稳定 `code` 的那一半能到
        // 用户眼前（ADR-0012），`detail` 里的中文原文只进日志。原来这里回的是
        // 裸 `{ error }`，经 `onSend` 归一化后 code 只剩通用 `request.invalid`，
        // 用户永远看不到「为什么被拒」。
        return reply.code(err.status).send(
          buildProblem({
            status: err.status,
            // 415 → 格式不支持；413/400 各自都有自己的稳定 code（`codeForStatus`
            // 的默认表已经包含它们）。把三种错误都塞进 415 的 code 会让「文件太大」
            // 也提示「格式不支持」。
            ...(err.status === 415 ? { code: 'request.unsupported_media_type' } : {}),
            detail: err.message,
            instance: request.url,
            requestId: request.id,
          }),
        );
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
  // 与写入对象时用的是**同一个**探测函数。这条分支以前写着「非 SVG 非 PNG 就当
  // webp」，于是 GIF/JPEG/ICO 都以 `image/webp` 发出去：浏览器拿到一个它解不了
  // 的 MIME，表现就是图标不显示。
  return reply.type(detectContentType(data)).send(data);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
