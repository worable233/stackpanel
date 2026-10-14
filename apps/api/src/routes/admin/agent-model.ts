import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isPublicHttpUrl } from '@stackpanel/net-guard';
import { encryptSecret, isSecretsEnabled } from '../../lib/crypto.ts';
import { buildProblem } from '../../lib/problem.ts';
import { LLM_CONFIG_SECRET_KEY, LLM_CONFIG_SETTING_KEY } from '../../lib/llm-provider.ts';
import { SECRETS_DISABLED_CODE, SECRETS_DISABLED_MESSAGE } from '../../lib/secrets-policy.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

/**
 * T4 — the admin read/write surface for the fallback model config
 * (PLAN-agent-in-kernel §3.1/§3.6).
 *
 * Two rows back one logical configuration:
 *   - `Setting['agent.llm']`       -> `{ baseUrl, model }`  (plaintext JSON)
 *   - `Secret['agent.llm.apiKey']` -> `encryptSecret(apiKey)`
 *
 * The split is deliberate. `GET /admin/settings` echoes every Setting value to
 * administrators verbatim (routes/admin/settings.ts), so the key must never
 * live there; it belongs in `Secret`, which no read endpoint ever echoes. This
 * route is the only writer for both rows, which is why it needs to be atomic
 * rather than reusing the generic settings/secrets endpoints.
 *
 * The runtime read half already exists as `readConfiguredLlmConfig` in
 * lib/llm-provider.ts (T2); this route consumes the same constants so the two
 * halves can never disagree about which rows they mean.
 */

const adminOnly = [requireAuth, requireRole('ADMIN')];

const setModelSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048).url(),
  model: z.string().trim().min(1).max(191),
  /**
   * Optional: omitting it keeps the stored key untouched, so an admin can
   * retune the endpoint or the model name without re-entering the secret.
   */
  apiKey: z.string().min(1).max(4096).optional(),
});

interface ModelConfigView {
  baseUrl: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
}

function problemsDisabled(reply: FastifyReply, request: { url: string; id: string }) {
  return reply
    .code(501)
    .send(
      buildProblem({
        status: 501,
        code: SECRETS_DISABLED_CODE,
        detail: SECRETS_DISABLED_MESSAGE,
        instance: request.url,
        requestId: request.id,
      }),
    );
}

/**
 * The admin-facing view. Read straight from the two rows instead of via
 * `readConfiguredLlmConfig`, because that reader collapses to `null` unless
 * *all three* fields are present — which would hide a saved baseUrl/model from
 * an admin who has not entered a key yet. The two readers share the key
 * constants, so they always name the same rows.
 */
async function readModelConfigView(): Promise<ModelConfigView> {
  const prisma = getPrisma();
  const [setting, secret] = await Promise.all([
    prisma.setting.findUnique({ where: { key: LLM_CONFIG_SETTING_KEY }, select: { value: true } }),
    prisma.secret.findUnique({
      where: { key: LLM_CONFIG_SECRET_KEY },
      select: { ciphertext: true },
    }),
  ]);

  const value = setting?.value;
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    baseUrl: typeof record.baseUrl === 'string' && record.baseUrl.length > 0 ? record.baseUrl : null,
    model: typeof record.model === 'string' && record.model.length > 0 ? record.model : null,
    apiKeyConfigured: typeof secret?.ciphertext === 'string' && secret.ciphertext.length > 0,
  };
}

export async function adminAgentModelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/agent/model', { preHandler: adminOnly }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readModelConfigView();
  });

  app.put('/admin/agent/model', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = setModelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildProblem({
          status: 400,
          detail: '模型配置参数无效',
          instance: request.url,
          requestId: request.id,
        }),
      );
    }
    const body = parsed.data;

    // SSRF gate, first line of defence — deliberately the same standard the
    // runtime applies in ConfiguredLlmProvider (isPublicHttpUrl defaults to
    // https-only, public hosts, no embedded credentials). Storing an address
    // the runtime would later refuse would be a "saves fine, never runs" trap.
    if (!isPublicHttpUrl(body.baseUrl)) {
      return reply.code(422).send(
        buildProblem({
          status: 422,
          code: 'agent.model.base_url_rejected',
          detail: '接口地址必须是公网可访问的 https 地址',
          instance: request.url,
          requestId: request.id,
        }),
      );
    }

    // Both gates run before anything is written, so a rejected request can
    // never leave a half-configured endpoint behind.
    if (body.apiKey !== undefined && !isSecretsEnabled()) {
      return problemsDisabled(reply, request);
    }

    const prisma = getPrisma();
    const updatedBy = request.user?.id ?? null;

    // Setting and Secret are written in one transaction: a config that updates
    // the endpoint but silently drops the key (or vice versa) is worse than no
    // config at all.
    await prisma.$transaction(async (tx) => {
      const value = { baseUrl: body.baseUrl, model: body.model };
      await tx.setting.upsert({
        where: { key: LLM_CONFIG_SETTING_KEY },
        create: { key: LLM_CONFIG_SETTING_KEY, value, updatedBy },
        update: { value, updatedBy },
      });

      if (body.apiKey !== undefined) {
        const ciphertext = encryptSecret(body.apiKey);
        await tx.secret.upsert({
          where: { key: LLM_CONFIG_SECRET_KEY },
          create: { key: LLM_CONFIG_SECRET_KEY, ciphertext },
          update: { ciphertext },
        });
      }
    });

    await writeAudit({
      action: 'agent.model.update',
      resource: 'setting',
      resourceId: LLM_CONFIG_SETTING_KEY,
      // Records *which* fields changed, never their secret values: `apiKeyChanged`
      // is a boolean so the audit trail cannot become a key leak.
      meta: {
        baseUrl: body.baseUrl,
        model: body.model,
        apiKeyChanged: body.apiKey !== undefined,
      },
      ...auditContext(request),
    });

    return readModelConfigView();
  });

  app.delete('/admin/agent/model', { preHandler: adminOnly }, async (request) => {
    const prisma = getPrisma();

    // No encryption needed to clear, so this stays available even when secret
    // storage is disabled — an admin must always be able to undo a config.
    await prisma.$transaction(async (tx) => {
      await tx.setting.deleteMany({ where: { key: LLM_CONFIG_SETTING_KEY } });
      await tx.secret.deleteMany({ where: { key: LLM_CONFIG_SECRET_KEY } });
    });

    await writeAudit({
      action: 'agent.model.clear',
      resource: 'setting',
      resourceId: LLM_CONFIG_SETTING_KEY,
      ...auditContext(request),
    });

    return { baseUrl: null, model: null, apiKeyConfigured: false } satisfies ModelConfigView;
  });
}
