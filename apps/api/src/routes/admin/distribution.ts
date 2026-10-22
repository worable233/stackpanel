/**
 * 分发源配置路由（PLAN-github-distribution-and-updates §2、§10）。
 *
 * 让管理员在后台完成过去只能改 `.env` 的事：目录仓、渠道、分支、GitHub 加速前缀、
 * 目录验签公钥、私有目录只读 token。
 *
 * 安全边界：
 * - token 只写不读：GET 只返回 `tokenConfigured`，永不回显明文。
 * - token 走加密存储（`SETTINGS_ENCRYPTION_KEY`），未配置时写操作返回 501。
 * - 加速地址必须是公网 HTTPS，且**不会**带上 token（见 `github-source.ts`）。
 * - 每次变更都写审计；变更后立即重建刷新协调器，不需要重启。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import {
  currentCatalogSourceConfig,
  loadCatalogSourceConfig,
  saveCatalogPublicKey,
  saveCatalogSourceConfig,
  saveCatalogToken,
  toCatalogSourceView,
} from '../../distribution/source-config.ts';
import { getCatalogRefresh } from '../../distribution/runtime.ts';
import { env } from '../../config/env.ts';
import { isValidSigningPublicKey } from '../../lib/signing-settings.ts';
import { isSecretsEnabled } from '../../lib/crypto.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const sourceSchema = z.object({
  /** `null` = 显式关闭远程目录（完全离线）。 */
  repository: z.string().max(300).nullable(),
  channel: z.enum(['stable', 'beta']).optional(),
  ref: z.string().max(120).optional(),
  /** `null`/空 = 不使用加速。 */
  mirror: z.string().max(300).nullable(),
});

const publicKeySchema = z.object({ publicKey: z.string().max(8192) });
const tokenSchema = z.object({ token: z.string().max(4096) });

/** 变更后重建协调器，使新配置立刻生效（无需重启）。 */
function applyConfig(): void {
  // getCatalogRefresh() 会比对配置指纹并在变化时重建单例。
  getCatalogRefresh();
}

export async function adminDistributionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/distribution/source',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => ({
      source: toCatalogSourceView(currentCatalogSourceConfig()),
      defaults: {
        repository: env.DISTRIBUTION_CATALOG_REPOSITORY ?? null,
        mirror: env.DISTRIBUTION_CATALOG_MIRROR ?? null,
      },
    }),
  );

  app.put(
    '/admin/distribution/source',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const body = sourceSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: '分发源参数无效' });
      try {
        const config = await saveCatalogSourceConfig(
          {
            repository: body.data.repository,
            ...(body.data.channel ? { channel: body.data.channel } : {}),
            ...(body.data.ref ? { ref: body.data.ref } : {}),
            mirror: body.data.mirror,
          },
          request.user?.id ?? null,
        );
        applyConfig();
        await writeAudit({
          action: 'distribution.source.set',
          resource: 'distribution',
          ...auditContext(request),
          meta: {
            repository: config.repository,
            channel: config.channel,
            ref: config.ref,
            mirror: config.mirror,
          },
        });
        return { source: toCatalogSourceView(config) };
      } catch (error) {
        // 用专用 code：`validation.invalid` 会被前端按 code 本地化成泛化文案，
        // 具体原因（HTTPS/仓库格式）就丢了。
        return reply.code(422).send({
          code: 'distribution.source.invalid',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.put(
    '/admin/distribution/catalog-key',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const body = publicKeySchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: '公钥参数无效' });
      const publicKey = body.data.publicKey.trim();
      // 只接受合法的 Ed25519 公钥：写进一把解析不了的 key 会让目录验签永远失败，
      // 不如在保存时就明确拒绝。
      if (publicKey.length > 0 && !isValidSigningPublicKey(publicKey)) {
        return reply.code(422).send({
          code: 'distribution.catalogKey.invalid',
          error: '目录公钥无效：需要 Ed25519 公钥（PEM）',
        });
      }
      const config = await saveCatalogPublicKey(publicKey, request.user?.id ?? null);
      applyConfig();
      await writeAudit({
        action: body.data.publicKey.trim()
          ? 'distribution.catalogKey.set'
          : 'distribution.catalogKey.clear',
        resource: 'distribution',
        ...auditContext(request),
      });
      return { source: toCatalogSourceView(config) };
    },
  );

  app.put(
    '/admin/distribution/token',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const body = tokenSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'token 参数无效' });
      if (!isSecretsEnabled()) {
        return reply.code(501).send({
          code: 'secret.storage.disabled',
          error: '密钥存储未配置：请设置 SETTINGS_ENCRYPTION_KEY',
        });
      }
      const config = await saveCatalogToken(body.data.token, request.user?.id ?? null);
      applyConfig();
      await writeAudit({
        action: body.data.token.trim()
          ? 'distribution.catalogToken.set'
          : 'distribution.catalogToken.clear',
        resource: 'distribution',
        ...auditContext(request),
      });
      return { source: toCatalogSourceView(config) };
    },
  );

  /** 立即触发一次刷新（受退避约束），供运维改完配置后验证是否可用。 */
  app.post(
    '/admin/distribution/refresh',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const service = getCatalogRefresh();
      if (!service) {
        return { configured: false, available: false, failure: null };
      }
      const result = await service.refresh();
      return {
        configured: true,
        available: result.resolved !== null,
        failure: result.failure,
        sequence: result.resolved?.snapshot.sequence ?? null,
        expired: result.resolved?.expired ?? null,
      };
    },
  );

  /** 重新从数据库读取配置（多副本场景下让本副本跟上）。 */
  app.post(
    '/admin/distribution/reload',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const config = await loadCatalogSourceConfig();
      applyConfig();
      return { source: toCatalogSourceView(config) };
    },
  );
}
