import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PluginError, frontendSettingsValueSchema } from '@stackpanel/sdk';
import { requireAuth, requirePermission, requireRole } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import {
  readThemeConfiguration,
  readThemeConfigurationDraft,
  saveThemeConfiguration,
  saveThemeConfigurationDraft,
  validateThemeConfiguration,
} from '../lib/theme-configuration.ts';
import { THEME_ID_PATTERN } from '../lib/themes.ts';
import { runIdempotent } from '../lib/idempotency.ts';
import { enforceTokenQuota } from '../lib/open-api-guard.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';

const paramsSchema = z.object({ id: z.string().regex(THEME_ID_PATTERN) });
const settings = frontendSettingsValueSchema;
const patchSchema = z.object({ settings, expectedVersion: z.string().length(64) }).strict();
export async function themeConfigurationRoutes(app: FastifyInstance) {
  for (const base of ['/admin/themes', '/api/v1/themes']) {
    const guards = [
      requireAuth,
      requireRole('ADMIN'),
      requirePermission('platform.admin'),
      enforceTokenQuota,
    ];
    app.get(`${base}/:id/configuration`, { preHandler: guards }, async (request) => {
      const { id } = paramsSchema.parse(request.params);
      return readThemeConfiguration(getPrisma(), id);
    });
    if (base === '/admin/themes')
      app.get(`${base}/:id/configuration/preview`, { preHandler: guards }, async (request) => {
        const { id } = paramsSchema.parse(request.params);
        return { settings: await readThemeConfigurationDraft(getPrisma(), id, request.user!.id) };
      });
    app.post(`${base}/:id/configuration/validate`, { preHandler: guards }, async (request) => {
      const { id } = paramsSchema.parse(request.params);
      const body = z.object({ settings }).strict().parse(request.body);
      const result = await validateThemeConfiguration(getPrisma(), id, body.settings);
      return { settings: result.settings, valid: true };
    });
    if (base === '/admin/themes')
      app.post(`${base}/:id/configuration/preview`, { preHandler: guards }, async (request) => {
        const { id } = paramsSchema.parse(request.params);
        const body = z.object({ settings }).strict().parse(request.body);
        await saveThemeConfigurationDraft(getPrisma(), id, request.user!.id, body.settings);
        return { ok: true };
      });
    app.patch(`${base}/:id/configuration`, { preHandler: guards }, async (request, reply) => {
      const { id } = paramsSchema.parse(request.params);
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success)
        throw new PluginError(
          'validation.invalid',
          422,
          'Provide settings and expectedVersion from the configuration read response',
        );
      const save = async () => {
        const result = await saveThemeConfiguration(
          getPrisma(),
          id,
          parsed.data.settings,
          request.user?.id ?? null,
          parsed.data.expectedVersion,
        );
        await writeAudit({
          action: 'theme.settings.update',
          resource: 'theme',
          resourceId: id,
          ...auditContext(request),
        });
        return result;
      };
      return base.startsWith('/api/v1') ? runIdempotent(request, reply, save) : save();
    });
  }
}
