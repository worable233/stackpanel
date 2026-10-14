/**
 * Kernel-side model supply resolution (PLAN-agent-in-kernel §3.1 / §3.6).
 *
 * The kernel Agent loop only ever sees the `LlmProvider` contract
 * (`packages/sdk/src/llm.ts`). Behind it sit exactly two implementations, both
 * owned by the kernel so plugins never need to know about them:
 *
 * - {@link ExtensionLlmProvider} — wraps the first plugin implementation
 *   registered on `EXTENSION_POINTS.llmProvider` and passes `LlmCallOptions`
 *   straight through.
 * - {@link ConfiguredLlmProvider} — reads the admin-configured fallback
 *   (interface address + key + model name) and speaks the OpenAI-compatible
 *   `/chat/completions` protocol. The key lives AES-256-GCM encrypted in the
 *   `Secret` table (`apps/api/src/lib/crypto.ts`), never in plaintext and never
 *   in logs or error messages. Every request passes the `@stackpanel/net-guard`
 *   public-address check first (SSRF gate) and never follows redirects.
 *
 * Resolution order is fixed: extension point → fallback config → `null`. The
 * caller renders "尚未配置模型" on `null`; this module never fabricates a
 * provider and never throws for the "nothing configured" case.
 */
import { EXTENSION_POINTS, LlmProviderError } from '@stackpanel/sdk';
import type {
  LlmCallOptions,
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmMessage,
  LlmModelInfo,
  LlmPart,
  LlmProvider,
  LlmStreamEvent,
  LlmTool,
} from '@stackpanel/sdk';
import { isPublicHttpUrl, resolvePublicAddresses } from '@stackpanel/net-guard';
import type { PrismaClient } from '@stackpanel/db';
import { getPrisma } from '../plugins/prisma.ts';
import { decryptSecret } from './crypto.ts';

/**
 * Settings key holding `{ baseUrl, model }` for the fallback provider
 * (PLAN-agent-in-kernel §3.1: 接口地址 + 模型名).
 */
export const LLM_CONFIG_SETTING_KEY = 'agent.llm';

/**
 * `Secret` key holding the encrypted API key for the fallback provider. The
 * plaintext never leaves this module (it is only handed to the HTTP header).
 */
export const LLM_CONFIG_SECRET_KEY = 'agent.llm.apiKey';

/** Default per-call timeout when `LlmCallOptions.timeoutMs` is absent. */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/** The admin-configured fallback endpoint, decrypted and ready to use. */
export interface ConfiguredLlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Injectable configuration reader — the seam that keeps tests off the DB. */
export type ConfiguredLlmConfigLoader = () => Promise<ConfiguredLlmConfig | null>;

export interface ConfiguredLlmProviderOptions {
  /** Loads the configured endpoint, or `null` when the admin has not filled it in. */
  loadConfig: ConfiguredLlmConfigLoader;
  /** Transport override (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Default per-call timeout; `LlmCallOptions.timeoutMs` wins when present. */
  timeoutMs?: number;
  id?: string;
  name?: string;
}

/**
 * Parse `Setting.value` + the encrypted `Secret` row into a usable config.
 * Returns `null` for "not configured" (no field, blank field, missing secret).
 * A corrupted ciphertext propagates as an `Error` from `decryptSecret` — that
 * is a real fault, not "unconfigured", and must not be silently masked.
 */
export async function readConfiguredLlmConfig(
  prisma: PrismaClient,
): Promise<ConfiguredLlmConfig | null> {
  const setting = await prisma.setting.findUnique({ where: { key: LLM_CONFIG_SETTING_KEY } });
  const value = setting?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const baseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (baseUrl === '' || model === '') return null;

  const stored = await prisma.secret.findUnique({ where: { key: LLM_CONFIG_SECRET_KEY } });
  const ciphertext = stored?.ciphertext;
  if (typeof ciphertext !== 'string' || ciphertext === '') return null;
  const apiKey = decryptSecret(ciphertext).trim();
  if (apiKey === '') return null;

  return { baseUrl, model, apiKey };
}

/** Default loader: reads `Setting` + `Secret` through the shared Prisma client. */
export function loadConfiguredLlmConfig(): Promise<ConfiguredLlmConfig | null> {
  return readConfiguredLlmConfig(getPrisma());
}

/**
 * Wraps a plugin-registered provider. `id`/`name` stay the plugin's own, so the
 * admin UI keeps showing the plugin's identity, and `LlmCallOptions` are passed
 * through untouched (notably `callId`, which the plugin uses for idempotent
 * billing — the kernel must not rewrite it).
 */
export class ExtensionLlmProvider implements LlmProvider {
  constructor(private readonly provider: LlmProvider) {}

  get id(): string {
    return this.provider.id;
  }

  get name(): string {
    return this.provider.name;
  }

  listModels(): Promise<LlmModelInfo[]> {
    return this.provider.listModels();
  }

  complete(
    request: LlmCompletionRequest,
    options: LlmCallOptions,
  ): Promise<LlmCompletionResult> {
    return this.provider.complete(request, options);
  }

  stream(request: LlmCompletionRequest, options: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
    const delegate = this.provider.stream;
    if (!delegate) {
      throw new LlmProviderError(
        'provider_unavailable',
        `模型提供方 ${this.provider.id} 不支持流式调用`,
        false,
      );
    }
    return delegate.call(this.provider, request, options);
  }
}

/**
 * Fallback provider for installs without an `llmProvider` plugin: talks plain
 * OpenAI-compatible `/chat/completions` to whatever address the admin saved.
 * Billing is the site owner's own account, so `costMinor` is always `0`.
 */
export class ConfiguredLlmProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  private readonly loadConfig: ConfiguredLlmConfigLoader;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;

  constructor(options: ConfiguredLlmProviderOptions) {
    this.id = options.id ?? 'configured';
    this.name = options.name ?? '后台兜底配置';
    this.loadConfig = options.loadConfig;
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  /**
   * Without a configured endpoint there is no model to advertise — return `[]`
   * so the admin dropdown stays empty instead of erroring. The configured model
   * is returned as the single entry once it is set; the kernel validates
   * `allowedModels` against this list.
   */
  async listModels(): Promise<LlmModelInfo[]> {
    const config = await this.loadConfig();
    if (!config) return [];
    return [{ id: config.model, label: config.model, supportsTools: true }];
  }

  async complete(
    request: LlmCompletionRequest,
    options: LlmCallOptions,
  ): Promise<LlmCompletionResult> {
    const config = await this.loadConfig();
    if (!config) {
      throw new LlmProviderError(
        'provider_unavailable',
        '尚未配置模型：请在后台设置中填写接口地址、密钥与模型名',
        false,
      );
    }

    // SSRF gate #1 — validate the literal before any network work, and never
    // follow redirects (a 302 to 169.254.169.254 would defeat the check).
    if (!isPublicHttpUrl(config.baseUrl)) {
      throw new LlmProviderError(
        'provider_unavailable',
        `模型接口地址不是允许出网的公网 https 地址：${redactUrl(config.baseUrl)}`,
        false,
      );
    }

    const url = new URL(config.baseUrl);
    // SSRF gate #2 — for the real transport, also resolve the hostname and
    // require every address to be public (DNS rebinding). Skipped for an
    // injected transport, mirroring packages/plugins/channel/src/webhook.ts.
    const doFetch = this.fetchImpl ?? fetch;
    if (this.fetchImpl === undefined) {
      const addresses = await resolvePublicAddresses(url.hostname);
      if (!addresses || addresses.length === 0) {
        throw new LlmProviderError(
          'provider_unavailable',
          `模型接口地址解析到非公网地址：${url.hostname}`,
          false,
        );
      }
    }

    const endpoint = joinChatCompletions(url);
    const body = buildOpenAiRequestBody(request, config.model);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const signal = combineSignals(options.signal, timeoutMs);

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Message text only — never the key, never the raw request.
      if (isAbortError(error)) {
        throw new LlmProviderError('timeout', '模型接口调用超时或被取消', true);
      }
      throw new LlmProviderError('upstream_error', '模型接口网络请求失败', true);
    }

    if (!response.ok) {
      throw errorForStatus(response.status, response.statusText);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmProviderError('upstream_error', '模型接口返回了无法解析的响应体', true);
    }

    return mapOpenAiResponse(payload, request.model || config.model);
  }
}

export interface LlmProviderRuntime {
  getExtensions<T>(pointId: string): T[];
}

export interface ResolveLlmProviderOptions {
  /** Configuration loader override (tests, or an already-open Prisma client). */
  loadConfig?: ConfiguredLlmConfigLoader;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fixed resolution order: extension point first, fallback config second, `null`
 * last. Only the first registered implementation is taken (the shape used by
 * `apps/api/src/lib/commerce.ts:16`); a `null` return means the caller shows
 * "尚未配置模型" — it is not an error and must not be turned into one.
 */
export async function resolveLlmProvider(
  runtime: LlmProviderRuntime,
  options: ResolveLlmProviderOptions = {},
): Promise<LlmProvider | null> {
  const extension = runtime.getExtensions<LlmProvider>(EXTENSION_POINTS.llmProvider)[0];
  if (extension) return new ExtensionLlmProvider(extension);

  const loadConfig = options.loadConfig ?? loadConfiguredLlmConfig;
  const config = await loadConfig();
  if (!config) return null;

  return new ConfiguredLlmProvider({
    // Pass the loader through, not the snapshot: the admin may change or clear
    // the address between two steps, and `complete()` re-checks each call.
    loadConfig,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/** `https://host/v1` → `https://host/v1/chat/completions`, tolerating a trailing slash. */
function joinChatCompletions(base: URL): string {
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = `${path}/chat/completions`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

/** Strip credentials from a URL before it appears in an error message. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<无法解析的地址>';
  }
}

function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (external) signals.push(external);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** HTTP status → the stable provider error the kernel retries on. */
function errorForStatus(status: number, statusText: string): LlmProviderError {
  const suffix = statusText ? ` ${statusText}` : '';
  if (status === 429) {
    return new LlmProviderError('rate_limited', `模型接口限流（429${suffix}）`, true);
  }
  if (status >= 500) {
    return new LlmProviderError('upstream_error', `模型接口错误（${status}${suffix}）`, true);
  }
  return new LlmProviderError('invalid_request', `模型接口拒绝了请求（${status}${suffix}）`, false);
}

/** Map the kernel request onto an OpenAI-compatible chat completion body. */
function buildOpenAiRequestBody(
  request: LlmCompletionRequest,
  fallbackModel: string,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system !== undefined && request.system !== '') {
    messages.push({ role: 'system', content: request.system });
  }
  for (const message of request.messages) {
    messages.push(toOpenAiMessage(message));
  }

  const body: Record<string, unknown> = {
    model: request.model || fallbackModel,
    messages,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toOpenAiTool);
  }
  if (request.toolChoice !== undefined) {
    body.tool_choice =
      typeof request.toolChoice === 'string'
        ? request.toolChoice
        : { type: 'function', function: { name: request.toolChoice.name } };
  }
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  return body;
}

function toOpenAiTool(tool: LlmTool): Record<string, unknown> {
  const fn: Record<string, unknown> = { name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) fn.description = tool.description;
  return { type: 'function', function: fn };
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    const text = message.parts
      .filter((part): part is Extract<LlmPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    const toolCalls = message.parts
      .filter((part): part is Extract<LlmPart, { type: 'tool-call' }> => part.type === 'tool-call')
      .map((part) => ({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      }));
    const result: Record<string, unknown> = { role: 'assistant', content: text === '' ? null : text };
    if (toolCalls.length > 0) result.tool_calls = toolCalls;
    return result;
  }

  if (message.role === 'tool') {
    const content = collectText(message.parts);
    const result: Record<string, unknown> = { role: 'tool', content };
    if (message.toolCallId !== undefined) result.tool_call_id = message.toolCallId;
    if (message.name !== undefined) result.name = message.name;
    return result;
  }

  return { role: 'user', content: collectText(message.parts) };
}

/** Text parts, plus `tool-result` payloads rendered as plain text for user turns. */
function collectText(parts: readonly LlmPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'tool-result') return part.content;
      return '';
    })
    .join('');
}

interface OpenAiUsageLike {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function mapStopReason(raw: unknown, hasToolCalls: boolean): LlmCompletionResult['stopReason'] {
  switch (raw) {
    case 'stop':
      return hasToolCalls ? 'tool_calls' : 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case undefined:
    case null:
      return hasToolCalls ? 'tool_calls' : 'stop';
    default:
      return 'error';
  }
}

/** Map an OpenAI-compatible chat completion response back to kernel parts. */
function mapOpenAiResponse(payload: unknown, model: string): LlmCompletionResult {
  const root = asRecord(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);

  const parts: LlmPart[] = [];
  const content = message?.content;
  if (typeof content === 'string' && content !== '') {
    parts.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const record = asRecord(item);
        return typeof record?.text === 'string' ? record.text : '';
      })
      .join('');
    if (text !== '') parts.push({ type: 'text', text });
  }

  const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const rawCall of rawToolCalls) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (name === '') continue;
    parts.push({
      type: 'tool-call',
      id: typeof call?.id === 'string' ? call.id : '',
      name,
      // OpenAI already hands back a JSON string; anything else is stringified.
      arguments: typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
    });
  }

  const hasToolCalls = parts.some((part) => part.type === 'tool-call');
  const usage = asRecord(root?.usage) as OpenAiUsageLike | undefined;
  const inputTokens = toCount(usage?.prompt_tokens);
  const outputTokens = toCount(usage?.completion_tokens);
  const totalRaw = toCount(usage?.total_tokens);

  return {
    model: typeof root?.model === 'string' ? root.model : model,
    parts,
    stopReason: mapStopReason(choice?.finish_reason, hasToolCalls),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: totalRaw > 0 ? totalRaw : inputTokens + outputTokens,
    },
    // 兜底配置由站长自己的账号付费，平台内不产生账单。此字段仅供内核累加
    // AgentRun.spendMinor 做预算，**绝不据此二次扣款**（防双计费）。
    costMinor: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
