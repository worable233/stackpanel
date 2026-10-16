/**
 * Kernel-owned LLM provider contract (PLAN-agent-in-kernel §3.6).
 *
 * The kernel Agent loop needs model inference, but model capability currently
 * lives in the `llm-gateway` plugin. The kernel must not call a plugin's raw
 * route (that would pin the kernel to one plugin). Instead this is a **public
 * extension point**: any plugin that can serve model inference implements
 * {@link LlmProvider} and registers it via
 * `ctx.registerExtension(EXTENSION_POINTS.llmProvider, impl)`; the kernel takes
 * it with `runtime.getExtensions<LlmProvider>(...)[0] ?? null` — the same shape
 * as the existing extension points (`apps/api/src/lib/commerce.ts:16`).
 *
 * **Ownership constraint (verbatim from the plan):** the contract is owned by
 * the kernel and must not import llm-gateway's IR types
 * (`data/plugins/llm-gateway/dist/protocol.d.ts` — `IRRequest`/`IRResponse` are
 * that plugin's private protocol; depending on them would nail a plugin
 * implementation into the kernel). This is therefore the kernel's own minimal
 * dialect: text / tool-call / tool-result only, which any gateway can map.
 */
import { brandSdkErrorClass, isSdkErrorClass } from './errors.js';

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/** A model provider the kernel Agent loop can drive. Implemented by plugins. */
export interface LlmProvider {
  readonly id: string; // 'llm-gateway'
  readonly name: string; // 管理端展示名
  /** 配置未就绪时允许内核选择其他提供方或兜底配置。 */
  available?(): Promise<boolean>;

  /** 管理端下拉与 allowedModels 校验用。必须是确定、无副作用、可缓存的纯读取。 */
  listModels(): Promise<LlmModelInfo[]>;

  /** 跑一轮：给定对话 + 工具定义，返回 assistant 产出（含 tool_calls）与用量。 */
  complete(
    request: LlmCompletionRequest,
    options: LlmCallOptions,
  ): Promise<LlmCompletionResult>;

  /** 可选：流式。内核 P0 **不消费**，UI 进度走 AgentStep，不要为它增加实现负担。 */
  stream?(
    request: LlmCompletionRequest,
    options: LlmCallOptions,
  ): AsyncIterable<LlmStreamEvent>;
}

/** One model as advertised by a provider. */
export interface LlmModelInfo {
  id: string; // 对外模型名（写入 AgentRun.model / allowedModels）
  label: string;
  contextWindow?: number;
  supportsTools: boolean; // 不支持工具调用的模型不能用于 Agent 循环
  /** 展示与估算用（minor/百万 token）。缺省表示未知，内核不计价。 */
  inputPriceMinorPerMillion?: number;
  outputPriceMinorPerMillion?: number;
}

// --------------------------------------------------------------------------
// Request
// --------------------------------------------------------------------------

/** One round of inference: conversation + tool definitions. */
export interface LlmCompletionRequest {
  model: string;
  system?: string; // 顶层系统指令，与 messages 分离
  messages: LlmMessage[];
  tools?: LlmTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
}

export type LlmRole = 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  parts: LlmPart[];
  /** role='tool' 时必填，对应 assistant 里的 tool-call id。 */
  toolCallId?: string;
  /** role='tool' 时的工具名。 */
  name?: string;
}

export type LlmPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string } // arguments 为 JSON 字符串
  | { type: 'tool-result'; id: string; content: string; isError?: boolean };

export interface LlmTool {
  name: string; // 直接来自 mcpToolName(capability.id)（packages/sdk/src/mcp.ts:93）
  description?: string; // 直接取 capability.summary + scope 说明
  parameters: unknown; // JSON Schema，即 buildMcpTool 的 inputSchema
}

/**
 * Per-call options. `callId` is the one field the provider may not guess.
 */
export interface LlmCallOptions {
  /**
   * **稳定调用 id，同一步重试必须复用同一个值。** 这是本接口最重要的一条：
   * llm-gateway 的用量流水以「幂等引用」后付费扣钱包（data.d.ts 的 gatewayUsageLogModel），
   * 与 4.2「幂等键先于审批生成」是同一纪律。内核传 `${runId}:${stepIndex}`，
   * **不带 attempt**：同一步因网络失败重试时 callId 不变，提供方据此去重、不重复计费。
   * 缺失时提供方可以拒绝（视为不可计费调用）。
   */
  callId: string;
  /** 取消信号：用户点「停止」、超时、或运行被取消时中断上游请求。 */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 归因用，进审计 meta.agent；提供方可用于日志。 */
  runId: string;
  actorId: string;
}

// --------------------------------------------------------------------------
// Result
// --------------------------------------------------------------------------

export interface LlmCompletionResult {
  model: string;
  parts: LlmPart[];
  stopReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** 本次**已实际计入平台账**的金额（minor）。站长自付/兜底配置时为 0。
   *  内核只用它累加 AgentRun.spendMinor 做预算，**绝不据此二次扣款**（防双计费）。 */
  costMinor: number;
}

/** 与 `stream?` 配套。P0 内核**不实现、不消费**；定义它只为让契约闭合、第三方实现时不猜。 */
export type LlmStreamEvent =
  | { type: 'text'; text: string } // 增量文本
  | { type: 'tool-call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | { type: 'done'; stopReason: LlmCompletionResult['stopReason'] };

// --------------------------------------------------------------------------
// Failures
// --------------------------------------------------------------------------

/**
 * Stable failure codes a provider reports instead of throwing bare strings.
 * The kernel uses them to decide retry vs stop: `model_not_found` and
 * `invalid_request` are never retried.
 */
export type LlmProviderErrorCode =
  | 'provider_unavailable'
  | 'model_not_found'
  | 'model_not_allowed'
  | 'rate_limited'
  | 'upstream_error'
  | 'content_filtered'
  | 'timeout'
  | 'invalid_request';

/** Every {@link LlmProviderErrorCode}, for exhaustive checks and validation. */
export const LLM_PROVIDER_ERROR_CODES = [
  'provider_unavailable',
  'model_not_found',
  'model_not_allowed',
  'rate_limited',
  'upstream_error',
  'content_filtered',
  'timeout',
  'invalid_request',
] as const satisfies readonly LlmProviderErrorCode[];

/** Codes the kernel must never retry (the request can never succeed unchanged). */
export const LLM_PROVIDER_TERMINAL_ERROR_CODES = [
  'model_not_found',
  'invalid_request',
] as const satisfies readonly LlmProviderErrorCode[];

/** True when `value` is one of the known {@link LlmProviderErrorCode}s. */
export function isLlmProviderErrorCode(value: unknown): value is LlmProviderErrorCode {
  return (
    typeof value === 'string' &&
    (LLM_PROVIDER_ERROR_CODES as readonly string[]).includes(value)
  );
}

export const LLM_PROVIDER_UNAVAILABLE: LlmProviderErrorCode = 'provider_unavailable';
export const LLM_PROVIDER_MODEL_NOT_FOUND: LlmProviderErrorCode = 'model_not_found';
export const LLM_PROVIDER_MODEL_NOT_ALLOWED: LlmProviderErrorCode = 'model_not_allowed';
export const LLM_PROVIDER_RATE_LIMITED: LlmProviderErrorCode = 'rate_limited';
export const LLM_PROVIDER_UPSTREAM_ERROR: LlmProviderErrorCode = 'upstream_error';
export const LLM_PROVIDER_CONTENT_FILTERED: LlmProviderErrorCode = 'content_filtered';
export const LLM_PROVIDER_TIMEOUT: LlmProviderErrorCode = 'timeout';
export const LLM_PROVIDER_INVALID_REQUEST: LlmProviderErrorCode = 'invalid_request';

/**
 * Failure raised by an {@link LlmProvider}. Carries a machine-readable
 * {@link LlmProviderErrorCode} plus whether the kernel may retry the same call.
 *
 * `LlmProviderError` instances are branded rather than matched with
 * `instanceof`: the kernel loads plugin bundles through a cache-busted URL, so
 * a plugin's `@stackpanel/sdk` can be a distinct module copy and `instanceof`
 * would silently fail (same reason as `PluginError`). Use
 * {@link isLlmProviderError}.
 */
export class LlmProviderError extends Error {
  readonly code: LlmProviderErrorCode;
  readonly retryable: boolean;

  constructor(
    code: LlmProviderErrorCode,
    message: string,
    retryable?: boolean,
  ) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    this.retryable =
      retryable ??
      !(LLM_PROVIDER_TERMINAL_ERROR_CODES as readonly LlmProviderErrorCode[]).includes(code);
  }
}

brandSdkErrorClass(LlmProviderError, 'LlmProviderError');

/** True when `value` was minted as an {@link LlmProviderError}, module-agnostic. */
export function isLlmProviderError(value: unknown): value is LlmProviderError {
  return isSdkErrorClass(value, 'LlmProviderError');
}
