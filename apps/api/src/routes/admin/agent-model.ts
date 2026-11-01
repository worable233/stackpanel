import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isPublicHttpUrl } from '@stackpanel/net-guard';
import { encryptSecret, isSecretsEnabled } from '../../lib/crypto.ts';
import { buildProblem } from '../../lib/problem.ts';
import {
  LLM_CONFIG_SECRET_KEY,
  LLM_CONFIG_SETTING_KEY,
  LLM_DEFAULT_MODEL_SETTING_KEY,
  readDefaultModel,
  resolveLlmProvider,
} from '../../lib/llm-provider.ts';
import { SECRETS_DISABLED_CODE, SECRETS_DISABLED_MESSAGE } from '../../lib/secrets-policy.ts';
import { PluginError } from '@stackpanel/sdk';
import type { LlmMessage, LlmPart, LlmTool } from '@stackpanel/sdk';
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

/**
 * What the model picker renders. `provider` is the *resolved* supply (a plugin
 * extension first, the fallback triple second) so the admin sees the same
 * provider the Agent loop will actually call — not a guess from settings rows.
 *
 * `fallbackConfigured` is reported separately: an active plugin provider means
 * the fallback triple is unused, but the admin still needs to know whether a
 * backup endpoint exists for when the plugin is disabled or uninstalled.
 */
interface ModelCatalogView {
  provider: { id: string; name: string } | null;
  /** `true` when the supply is a plugin extension rather than `agent.llm`. */
  fromPlugin: boolean;
  models: Array<{
    id: string;
    label: string;
    supportsTools: boolean;
    inputPriceMinorPerMillion?: number;
    outputPriceMinorPerMillion?: number;
  }>;
  defaultModel: string | null;
  fallbackConfigured: boolean;
}

const setDefaultModelSchema = z
  .object({ model: z.string().trim().min(1).max(191).nullable() })
  .strict();

/** 「测试连接」入参：可选模型名（不传则用当前默认/提供方第一个）。 */
const testConnectionSchema = z
  .object({ model: z.string().trim().min(1).max(191).optional() })
  .strict();

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

/**
 * The provider's advertised models, for the admin dropdown.
 *
 * This is the join that was missing: llm-gateway (and any future provider
 * plugin) already knows which models the site may bill for, but the admin UI
 * only ever offered a free-text model box backed by `agent.llm`. Asking the
 * provider instead of a settings row means the dropdown can never drift from
 * what the Agent loop will accept.
 *
 * A provider that throws (misconfigured plugin, unreachable registry) is
 * reported as "no models" rather than as a failed page load: the admin must
 * still be able to fix the fallback endpoint in that state.
 */
async function readModelCatalog(runtime: {
  getExtensions<T>(pointId: string): T[];
}): Promise<ModelCatalogView> {
  const provider = await resolveLlmProvider(runtime);
  const [defaultModel, fallback] = await Promise.all([
    readDefaultModel(getPrisma()),
    readModelConfigView(),
  ]);
  let models: ModelCatalogView['models'] = [];
  if (provider) {
    try {
      models = (await provider.listModels()).map((item) => ({
        id: item.id,
        label: item.label || item.id,
        supportsTools: item.supportsTools,
        ...(item.inputPriceMinorPerMillion === undefined
          ? {}
          : { inputPriceMinorPerMillion: item.inputPriceMinorPerMillion }),
        ...(item.outputPriceMinorPerMillion === undefined
          ? {}
          : { outputPriceMinorPerMillion: item.outputPriceMinorPerMillion }),
      }));
    } catch {
      models = [];
    }
  }
  return {
    provider: provider ? { id: provider.id, name: provider.name } : null,
    fromPlugin: provider !== null && provider.id !== 'configured',
    models,
    defaultModel,
    fallbackConfigured: fallback.baseUrl !== null && fallback.apiKeyConfigured,
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

  /**
   * 「测试连接」（B-3）。
   *
   * 为什么不能只测 `chat/completions` 返回 200：Agent 的每一步都强依赖
   * tool calling。第三方中转站很常见「转发普通 chat、不转发 tools」——只测 chat
   * 会得到一个绿色的「已连通」，然后每一次运行都在第一步静默退化/400。
   *
   * 所以这里发一次**带 dummy tool 的请求**，并把结论分成四类：
   * - `ok`：模型返回了 tool_call，工具面真的可用；
   * - `tools_unsupported`：通了但没按工具返回（中转降级/模型不支持）；
   * - `auth_failed` / `not_found`：401/403 与 404（地址或模型名不对）；
   * - `unreachable`：网络/超时/DNS。
   *
   * 只读：不写库、不扣费（`callId` 固定为 probe，插件侧按幂等处理）。
   */
  app.post('/admin/agent/model/test', { preHandler: adminOnly }, async (request) => {
    const body = testConnectionSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new PluginError('validation.invalid', 422, '测试参数无效');
    }
    const provider = await resolveLlmProvider(request.server.pluginRuntime);
    if (!provider) {
      return {
        ok: false,
        result: 'unconfigured' as const,
        toolsSupported: false,
        model: null,
        latencyMs: 0,
        message: '尚未配置模型提供方',
      };
    }
    const model = body.data.model ?? (await readDefaultModel(getPrisma())) ?? '';
    const startedAt = Date.now();
    const tool: LlmTool = {
      name: 'stackpanel_probe_echo',
      description:
        'Diagnostic tool. Call it once with {"probe": "<any string>"} to prove tool calling works.',
      parameters: {
        type: 'object',
        properties: { probe: { type: 'string' } },
        required: ['probe'],
        additionalProperties: false,
      },
    };
    /**
     * 两步探测：先让模型调一次工具，再把工具结果**回灌**给它。
     *
     * 只做第一步是不够的——实测 codex666 的 Responses 通道：第一步返回了
     * 合法的 tool_call（`toolsSupported` 看起来是 true），第二步回灌
     * `function_call_output` 时上游 400。而 Agent 的每一步都走这两步，所以
     * 「只测第一步」等于给了一个假的绿灯，正是报告里点名的无效测试。
     */
    const callOptions = (suffix: string) => ({
      // 每次探测都是一个**新的**调用（管理员点一次就是想测一次）。早先这里用
      // 固定 callId，结果第一次探测的失败记录进了插件侧推理幂等台账，之后每次
      // 「测试连接」都命中那条 `STARTED` 记录并回「此前调用结果不明」。
      callId: `agent-model-probe:${suffix}:${randomUUID()}`,
      runId: 'agent-model-probe',
      actorId: request.user?.id ?? 'system',
      timeoutMs: 20_000,
    });
    const prompt: LlmMessage[] = [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Call the stackpanel_probe_echo tool with probe="ping". Do not answer in prose.',
          },
        ],
      },
    ];
    try {
      const first = await provider.complete(
        { model, messages: prompt, tools: [tool], toolChoice: 'auto', maxTokens: 64 },
        callOptions('1'),
      );
      const calls = first.parts.filter(
        (part): part is Extract<LlmPart, { type: 'tool-call' }> => part.type === 'tool-call',
      );
      if (calls.length === 0) {
        return {
          ok: false,
          result: 'tools_unsupported' as const,
          toolsSupported: false,
          model: first.model || model,
          latencyMs: Date.now() - startedAt,
          message:
            '接口可达，但模型没有按工具调用返回：该中转/模型可能不转发 tools，Agent 无法可靠运行',
        };
      }
      // 第二步：把工具结果回灌，证明「工具结果 → 模型继续」这一段也通。
      await provider.complete(
        {
          model,
          messages: [
            ...prompt,
            { role: 'assistant', parts: first.parts },
            ...calls.map((call): LlmMessage => ({
              role: 'tool',
              toolCallId: call.id,
              parts: [
                { type: 'tool-result', id: call.id, content: '{"probe":"pong"}', isError: false },
              ],
            })),
          ],
          tools: [tool],
          toolChoice: 'auto',
          maxTokens: 64,
        },
        callOptions('2'),
      );
      return {
        ok: true,
        result: 'ok' as const,
        toolsSupported: true,
        model: first.model || model,
        latencyMs: Date.now() - startedAt,
        message: null,
      };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : '测试失败';
      /**
       * 比四分类更细、但同样明确的一类：`tools_rejected`。
       *
       * 中转站「能收 tools 却不肯在工具协议上配合」的典型表现就是第二步被拒
       * （`function_call_output requires item_reference ids …`）。把它混进
       * `unreachable` 会让运维去查网络，而真正要改的是 provider/协议选择。
       * 只按**内容**判定：`status` 是内核看到的那个（插件把上游 400 转成了
       * 502），拿它当依据会把「上游 5xx」也误判成工具协议问题。
       */
      const toolProtocolFault =
        /function_call_output|item_reference|previous_response_id|tool_call|tool_result|tools?\b.*(unsupported|not support|invalid)|工具/i.test(
          message,
        );
      const result =
        status === 401 || status === 403
          ? ('auth_failed' as const)
          : status === 404
            ? ('not_found' as const)
            : toolProtocolFault
              ? ('tools_rejected' as const)
              : ('unreachable' as const);
      return {
        ok: false,
        result,
        toolsSupported: false,
        model: model || null,
        latencyMs: Date.now() - startedAt,
        message,
      };
    }
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

  /**
   * The model picker's data source: whatever the *active* provider advertises.
   * Read-only and side-effect free, so it is safe for the settings page to call
   * on every load.
   */
  app.get('/admin/agent/model/catalog', { preHandler: adminOnly }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readModelCatalog(request.server.pluginRuntime);
  });

  /**
   * Persist the administrator's default model.
   *
   * `null` clears the choice (the Agent loop then falls back to the first model
   * the provider advertises). The value is not validated against the current
   * list on purpose: a provider may be temporarily unreachable while the admin
   * fixes it, and rejecting the write would make the setting un-editable. The
   * runtime re-checks the id against the live list before every run.
   */
  app.put('/admin/agent/model/default', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = setDefaultModelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        buildProblem({
          status: 400,
          detail: '默认模型参数无效',
          instance: request.url,
          requestId: request.id,
        }),
      );
    }
    const model = parsed.data.model;
    const prisma = getPrisma();
    await prisma.setting.upsert({
      where: { key: LLM_DEFAULT_MODEL_SETTING_KEY },
      create: {
        key: LLM_DEFAULT_MODEL_SETTING_KEY,
        value: { model },
        updatedBy: request.user?.id ?? null,
      },
      update: { value: { model }, updatedBy: request.user?.id ?? null },
    });
    await writeAudit({
      action: 'agent.model.default.update',
      resource: 'setting',
      resourceId: LLM_DEFAULT_MODEL_SETTING_KEY,
      meta: { model },
      ...auditContext(request),
    });
    return readModelCatalog(request.server.pluginRuntime);
  });
}
