/**
 * Admin self-service export / import endpoints (ADR-0018).
 *
 * Export produces a portable archive (database dump + media tar) written to
 * object storage; import restores one and puts the instance in maintenance for
 * the duration. Both are queued as kernel jobs so the request returns
 * immediately; the admin UI polls {@link getBackupStatus}.
 *
 * Binary transport: the archive is base64 in JSON rather than multipart, so it
 * shares the standard request/response model (uploads arrive base64-encoded by
 * the operator tooling). Downloads stream the raw gzip with an attachment
 * disposition.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../plugins/auth.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { getStorage } from '../infra.ts';
import { pgToolsStatus } from '../backup/pg-tools.ts';
import {
  BackupBusyError,
  getBackupStatus,
  requestBackup,
} from '../backup/control.ts';
import {
  currentSchemaVersion,
  databaseLocation,
  isMaintenanceMode,
  secretsExportAvailable,
} from '../backup/service.ts';
import { EXPORT_DOMAINS, isExportDomain } from '../backup/domains.ts';
import { inspectArchive } from '../backup/archive.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const exportBody = z
  .object({
    /** Domains to include; omit for whole-instance (ADR-0018 §7). */
    includes: z.array(z.string()).min(1).max(32).optional(),
    /** Include encrypted secrets (requires the instance key, ADR-0018 §6). */
    includeSecrets: z.boolean().optional(),
  })
  .optional();

const importBody = z.object({
  /** Base64 of a `.tar.gz` archive produced by export. */
  archiveBase64: z.string().min(1).max(1024 * 1024 * 1024),
  /** Explicit confirmation that the current instance will be replaced. */
  confirm: z.literal(true),
});

const inspectBody = z.object({ archiveBase64: z.string().min(1).max(1024 * 1024 * 1024) });

export async function adminBackupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/backup', { preHandler: adminOnly }, async () => {
    const tools = pgToolsStatus();
    return {
      status: await getBackupStatus(),
      maintenance: (await isMaintenanceMode()) !== null,
      schemaVersion: await currentSchemaVersion(),
      // Selective-export controls (C4) and secret handling (C6) for the UI.
      domains: EXPORT_DOMAINS,
      secretsAvailable: secretsExportAvailable(),
      database: databaseLocation(),
      tools: {
        available: tools.available,
        pgDump: tools.pgDump !== null,
        pgRestore: tools.pgRestore !== null,
      },
    };
  });

  app.post('/admin/backup/export', { preHandler: adminOnly }, async (request, reply) => {
    if (!pgToolsStatus().available) {
      return reply.code(501).send({ error: '服务器未安装 pg_dump/pg_restore，无法导出' });
    }
    const body = exportBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: '请求参数无效（includes 需为域数组）' });
    }
    const includes = body.data?.includes;
    if (includes && !includes.every(isExportDomain)) {
      return reply.code(400).send({ error: `includes 含未知域（可用：${EXPORT_DOMAINS.join(' / ')}）` });
    }
    const includeSecrets = body.data?.includeSecrets === true;
    if (includeSecrets && !secretsExportAvailable()) {
      return reply
        .code(422)
        .send({ error: '本实例未配置 SETTINGS_ENCRYPTION_KEY，无法导出密钥' });
    }
    try {
      await requestBackup(
        'export',
        { requestedBy: request.user?.id ?? null, reason: 'admin.export' },
        { ...(includes ? { includes } : {}), ...(includeSecrets ? { includeSecrets: true } : {}) },
      );
    } catch (err) {
      if (err instanceof BackupBusyError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    await writeAudit({
      action: 'backup.export.request',
      resource: 'backup',
      meta: { includes: includes ?? EXPORT_DOMAINS, includeSecrets },
      ...auditContext(request),
    });
    return reply.code(202).send({ status: await getBackupStatus() });
  });

  app.post('/admin/backup/import', { preHandler: adminOnly }, async (request, reply) => {
    if (!pgToolsStatus().available) {
      return reply.code(501).send({ error: '服务器未安装 pg_dump/pg_restore，无法导入' });
    }
    const body = importBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: '请求参数无效（需 archiveBase64 且 confirm=true）' });
    }
    // Validate before entering maintenance / queueing: a corrupt archive should
    // fail fast at the edge, not halfway through a destructive restore.
    let warning: string | null = null;
    try {
      const archive = Uint8Array.from(Buffer.from(body.data.archiveBase64, 'base64'));
      const inspected = inspectArchive(archive);
      // ADR-0018 §6: secrets are AES-256-GCM ciphertext keyed by the instance's
      // SETTINGS_ENCRYPTION_KEY. A different key yields undecryptable rows, so
      // warn (do not block) — the operator may be restoring on a matching key.
      if (inspected.manifest.secretsIncluded && !secretsExportAvailable()) {
        warning = '归档包含加密密钥，但本实例未配置 SETTINGS_ENCRYPTION_KEY，相关密文将无法解密';
      } else if ((inspected.manifest.requiresSecrets ?? []).length > 0) {
        warning = `归档含需要密钥的域：${inspected.manifest.requiresSecrets?.join(' / ')}，请确认本实例密钥一致`;
      }
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : '归档校验失败' });
    }
    try {
      await requestBackup(
        'import',
        { requestedBy: request.user?.id ?? null, reason: 'admin.import' },
        { archiveBase64: body.data.archiveBase64 },
      );
    } catch (err) {
      if (err instanceof BackupBusyError) return reply.code(409).send({ error: err.message });
      throw err;
    }
    await writeAudit({
      action: 'backup.import.request',
      resource: 'backup',
      ...auditContext(request),
    });
    return reply
      .code(202)
      .send({ status: await getBackupStatus(), ...(warning ? { warning } : {}) });
  });

  /** Validate an archive without importing it (operator pre-flight). */
  app.post('/admin/backup/inspect', { preHandler: adminOnly }, async (request, reply) => {
    const body = inspectBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '请求参数无效' });
    try {
      const archive = Uint8Array.from(Buffer.from(body.data.archiveBase64, 'base64'));
      const inspected = inspectArchive(archive);
      const warnings: string[] = [];
      if (inspected.manifest.secretsIncluded && !secretsExportAvailable()) {
        warnings.push('归档包含加密密钥，但本实例未配置 SETTINGS_ENCRYPTION_KEY');
      } else if ((inspected.manifest.requiresSecrets ?? []).length > 0) {
        warnings.push('归档含需要密钥的域，请确认本实例密钥一致');
      }
      return {
        manifest: inspected.manifest,
        mediaCount: inspected.mediaCount,
        size: archive.byteLength,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : '归档校验失败' });
    }
  });

  /** Stream a produced archive for download. */
  app.get('/admin/backup/download', { preHandler: adminOnly }, async (request, reply) => {
    const query = z.object({ key: z.string().min(1).max(512) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '缺少归档 key' });
    const bytes = await getStorage().get(query.data.key);
    if (!bytes) return reply.code(404).send({ error: '归档不存在' });
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${safeFilename(query.data.key)}"`)
      .send(Buffer.from(bytes));
  });
}

function safeFilename(key: string): string {
  const base = key.split('/').pop() ?? 'stackpanel-export.tar.gz';
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}
