/**
 * provision 模式的最小 app（审计 R1、R7、R10）。
 *
 * 它**不是** `buildApp()` 的一个分支，而是一个独立的最小 Fastify 实例：
 * 只注册健康检查、统一发现接口与基础设施提交。这样做的原因：
 *
 * 1. **最小启动图**：ESM 的静态 import 在模块求值时就执行副作用。如果复用
 *    `buildApp()`，即使运行时分支跳过，`app.ts` 引入的 Prisma / Redis / 插件宿主
 *    / 主题发现也全部被加载——在"数据库还不存在"时这正是崩溃来源。
 * 2. **攻击面为零而非"拒绝"**：正常模式下这些路由在对象上根本不存在。
 * 3. **依赖清晰**：本文件只依赖 config-file / state / probes 与 spec 契约。
 *
 * 安全边界（逐条对应审计 R8）：
 * - token 是**强制**的，且用常量时间比较；
 * - 限流在进程内（此时没有 Redis），按 IP 固定窗口；
 * - 详细诊断只写日志；响应只给稳定分类；
 * - 提交路径先预检、再落候选、再发布任务，任何一步失败都不推进阶段。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  BOOTSTRAP_CONFIG_KEYS,
  BOOTSTRAP_MAX_VALUE_LENGTH,
  BOOTSTRAP_ERROR_CODES,
  isBootstrapConfigKey,
  projectBootstrapStatus,
  type BootstrapConfig,
  type BootstrapConfigKey,
  type BootstrapStatusResponse,
} from '@stackpanel/spec';
import { assertSafeValue, BootstrapFileError, serializeBootstrapFile } from './config-file.ts';
import {
  BootstrapStateError,
  operationIdFromKey,
  toOperationView,
  type BootstrapStateStore,
} from './state.ts';
import { probeTargetsFromConfig, runProbes } from './probes.ts';
import { redactDiagnosticValue } from './redact.ts';
import {
  bootstrapChannelPaths,
  ensureBootstrapChannel,
  publishBootstrapTask,
  readLatestBootstrapResult,
} from './task.ts';

/** 固定窗口限流：5 次/分钟/IP，与既有 `setup` 预设一致。 */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export interface ProvisionAppOptions {
  /** 启动时读到的认领令牌（必填；缺失则拒绝启动，见 `assertProvisionable`）。 */
  setupToken: string;
  /** 状态存储（磁盘）。 */
  store: BootstrapStateStore;
  /** 目标内核版本，用于任务记录与 runner 互校。 */
  targetVersion: string;
  /** 实例 ID（决定任务通道目录）；默认 `stackpanel`。 */
  instanceId?: string;
  /** 状态根目录（`<stateDir>`）；任务通道放在 `<stateDir>/bootstrap`。 */
  stateDir: string;
  /** 日志输出（默认 console）。 */
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  /** 限流时钟（测试注入）。 */
  now?: () => number;
  /**
   * 预检实现（测试注入）。
   *
   * 生产永远用真实的 `runProbes`；测试需要覆盖「预检通过」这条路径，
   * 否则成功分支只能靠真实数据库，既慢又不可重复。
   */
  probes?: (targets: ReturnType<typeof probeTargetsFromConfig>) => ReturnType<typeof runProbes>;
}

/**
 * 校验进入 provision 模式的前置条件。
 *
 * 令牌缺失时**拒绝启动**而不是"开放"：一个没有令牌的自举页等于公开的
 * 数据库密码写入面（审计 R4/R8）。安装器负责生成令牌，缺失说明安装不完整。
 */
export function assertProvisionable(setupToken: string | undefined): asserts setupToken is string {
  if (!setupToken || setupToken.trim().length < 16) {
    throw new Error(
      'provision 模式需要 STACKPANEL_SETUP_TOKEN（至少 16 字符）。' +
        '请重新运行安装脚本生成引导配置，不要手工起一个无令牌的自举实例。',
    );
  }
}

/** 常量时间比较；长度不同也做一次哈希式比较以隐藏长度差异。 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 校验并规范化提交的配置。
 *
 * 只接受白名单键；值经过 `assertSafeValue`（拒绝 CR/LF、NUL、超长）。
 * 返回按固定顺序排列的键值对，保证同一份配置产生同一摘要。
 */
export function normalizeBootstrapConfig(
  raw: unknown,
): { ok: true; config: BootstrapConfig } | { ok: false; code: string; detail: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: BOOTSTRAP_ERROR_CODES.invalidConfig, detail: 'config 必须是对象' };
  }
  const entries = raw as Record<string, unknown>;
  const config: BootstrapConfig = {};

  for (const key of Object.keys(entries)) {
    if (!isBootstrapConfigKey(key)) {
      return {
        ok: false,
        code: BOOTSTRAP_ERROR_CODES.invalidConfig,
        detail: `不支持的配置键：${key}`,
      };
    }
  }

  for (const key of BOOTSTRAP_CONFIG_KEYS) {
    const value = entries[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return { ok: false, code: BOOTSTRAP_ERROR_CODES.invalidConfig, detail: `${key} 必须是字符串` };
    }
    try {
      assertSafeValue(key, value, BOOTSTRAP_MAX_VALUE_LENGTH);
    } catch (error) {
      if (error instanceof BootstrapFileError) {
        return { ok: false, code: BOOTSTRAP_ERROR_CODES.invalidConfig, detail: error.message };
      }
      throw error;
    }
    config[key as BootstrapConfigKey] = value;
  }

  if (!config.DATABASE_URL) {
    return {
      ok: false,
      code: BOOTSTRAP_ERROR_CODES.invalidConfig,
      detail: 'DATABASE_URL 必填',
    };
  }

  return { ok: true, config };
}

/** 构建 provision 模式的最小 app。 */
export function buildProvisionApp(options: ProvisionAppOptions): FastifyInstance {
  assertProvisionable(options.setupToken);
  const log = options.log ?? console;
  const now = options.now ?? (() => Date.now());

  const app = Fastify({
    exposeHeadRoutes: false,
    // 与主 app 一致：未显式信任代理时，`req.ip` 就是 socket 地址，
    // 避免伪造 X-Forwarded-For 绕过限流（审计 M-4）。
    trustProxy: parseTrustProxy(process.env['API_TRUST_PROXY']),
    logger: { level: process.env['API_LOG_LEVEL'] ?? 'info' },
  });

  // —— 进程内固定窗口限流（没有 Redis 可用）——
  const buckets = new Map<string, { count: number; resetAt: number }>();
  function allow(ip: string): boolean {
    const current = now();
    const bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= current) {
      buckets.set(ip, { count: 1, resetAt: current + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (bucket.count >= RATE_LIMIT_MAX) return false;
    bucket.count += 1;
    return true;
  }

  /** 统一发现接口：两个 app 共用同一路径与形状。 */
  app.get('/setup/status', async (_request, reply): Promise<BootstrapStatusResponse> => {
    const state = await options.store.read();
    // 状态文件缺失 = 安装器尚未写配置；语义上仍是 needs_infra。
    const phase = state?.phase ?? 'needs_infra';
    const projection = projectBootstrapStatus(phase, true);
    reply.header('Cache-Control', 'no-store');
    return {
      phase,
      ...projection,
      ...(state
        ? { operation: toOperationView(state, state.idempotencyKey) }
        : {}),
    };
  });

  app.get('/health', async () => ({ status: 'ok', mode: 'provision' }));

  /**
   * 详细诊断（审计 R8）：**公开状态只给阶段与通用结果**，详细内容必须持令牌。
   *
   * 为什么不做成 `/setup/status` 的可选字段：那个接口是未认证的，浏览器、
   * 反向代理与监控都会读它；把 runner 的原始失败文本放进去等于把可能含
   * DSN 的日志公开。这里用同一个令牌做二次门禁，并对所有文本做脱敏。
   *
   * 令牌放在 header（`X-Setup-Token`）而不是 query：query 会进入访问日志。
   */
  app.get('/setup/diagnostics', async (request, reply) => {
    if (!allow(request.ip)) {
      return reply
        .code(429)
        .header('Retry-After', '60')
        .send({ error: '请求过于频繁，请稍后再试', code: 'rate_limited' });
    }
    const header = request.headers['x-setup-token'];
    const provided = typeof header === 'string' ? header : '';
    if (!provided || !tokensMatch(provided, options.setupToken)) {
      return reply
        .code(401)
        .send({ error: '初始化令牌无效', code: BOOTSTRAP_ERROR_CODES.tokenInvalid });
    }

    let state;
    try {
      state = await options.store.read();
    } catch (error) {
      if (error instanceof BootstrapStateError) {
        return reply.code(500).send({
          error: '自举状态异常，请联系运维',
          code: BOOTSTRAP_ERROR_CODES.invalidConfig,
        });
      }
      throw error;
    }

    const instanceId = options.instanceId ?? process.env['STACKPANEL_UPDATE_INSTANCE_ID'] ?? 'stackpanel';
    const channel = bootstrapChannelPaths(options.stateDir, instanceId);
    const result = await readLatestBootstrapResult(channel);

    reply.header('Cache-Control', 'no-store');
    return {
      phase: state?.phase ?? 'needs_infra',
      configGeneration: state?.configGeneration ?? 0,
      targetVersion: state?.targetVersion ?? options.targetVersion,
      ...(state?.failure ? { failure: state.failure } : {}),
      diagnosticsRequired: state?.diagnosticsRequired === true,
      // 三个结果分开呈现，避免把「迁移成功」误读成「已完成」（审计 R2）。
      migrationSucceeded: state?.migrationSucceeded === true,
      runtimeReady: state?.runtimeReady === true,
      adminClaimed: state?.adminClaimed === true,
      updatedAt: state?.updatedAt,
      // runner 写回的最后一条结果（已脱敏、已截断）。
      lastResult: result ? redactDiagnosticValue(result) : null,
    };
  });

  /**
   * 提交基础设施配置。
   *
   * 顺序是刻意的，每一步都可解释：
   * 1. 限流 → 2. 令牌 → 3. 载荷 → 4. 阶段可写 → 5. 预检 → 6. 落候选 → 7. 发布任务
   *
   * 预检在落盘**之前**：写坏了就会在下次启动时连不上，且没有任何界面能救
   * （审计 R2/R3）。
   */
  app.post('/setup/provision', async (request, reply) => {
    if (!allow(request.ip)) {
      return reply
        .code(429)
        .header('Retry-After', '60')
        .send({ error: '请求过于频繁，请稍后再试', code: 'rate_limited' });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;

    const token = typeof body['setupToken'] === 'string' ? body['setupToken'] : '';
    if (!token || !tokensMatch(token, options.setupToken)) {
      return reply
        .code(401)
        .send({ error: '初始化令牌无效', code: BOOTSTRAP_ERROR_CODES.tokenInvalid });
    }

    const idempotencyKey =
      typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'].trim() : '';
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return reply.code(422).send({
        error: 'idempotencyKey 必须是 8–128 个字符',
        code: BOOTSTRAP_ERROR_CODES.invalidConfig,
      });
    }

    const normalized = normalizeBootstrapConfig(body['config']);
    if (!normalized.ok) {
      return reply.code(422).send({ error: normalized.detail, code: normalized.code });
    }
    const config = normalized.config;

    // 阶段可写性：已配置/执行中/已完成一律拒绝，避免匿名换库。
    let state;
    try {
      state = await options.store.read();
    } catch (error) {
      if (error instanceof BootstrapStateError) {
        log.error(`[bootstrap] 状态文件异常：${error.message}`);
        return reply
          .code(500)
          .send({ error: '自举状态异常，请联系运维', code: BOOTSTRAP_ERROR_CODES.invalidConfig });
      }
      throw error;
    }

    // 序列化与摘要要在阶段判断**之前**算出来：幂等重放（同一 key + 同一配置）
    // 必须返回原来的任务，即使实例已经推进到 queued/migrating。
    // 只写白名单键；不把令牌或路径写进配置文件。
    const serialized = serializeBootstrapFile(
      BOOTSTRAP_CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => [
        key,
        config[key] as string,
      ]),
    );
    const digest = digestOf(serialized);

    if (state?.idempotencyKey === idempotencyKey) {
      if (state.configDigest === digest) {
        // 幂等重放：不再预检、不再写候选，返回同一任务。
        reply.header('Cache-Control', 'no-store');
        return reply.code(202).send({
          operation: toOperationView(state, state.idempotencyKey),
        });
      }
      return reply.code(409).send({
        error: '同一幂等键对应不同配置',
        code: BOOTSTRAP_ERROR_CODES.idempotencyConflict,
      });
    }

    const phase = state?.phase ?? 'needs_infra';
    if (phase !== 'needs_infra' && phase !== 'migration_failed') {
      return reply.code(409).send({
        error: `当前阶段 ${phase} 不接受基础设施配置`,
        code: BOOTSTRAP_ERROR_CODES.notWritable,
      });
    }

    // —— 认领：先落 `validating`，再访问外部系统 ——
    // 预检可能持续数十秒。先把「有人正在验证」写进磁盘，并发提交才会被
    // 真正挡住；只在内存里判断阶段等于没有并发协议（审计 R3）。
    try {
      await options.store.beginValidation({ idempotencyKey });
    } catch (error) {
      if (error instanceof BootstrapStateError) {
        return reply.code(409).send({
          error: error.message,
          code:
            error.code === 'not_writable'
              ? BOOTSTRAP_ERROR_CODES.notWritable
              : BOOTSTRAP_ERROR_CODES.generationMismatch,
        });
      }
      throw error;
    }

    // —— 有界预检 ——
    const targets = probeTargetsFromConfig(config as Record<string, string | undefined>);
    const probe = await (options.probes ?? runProbes)(targets);
    if (!probe.ok) {
      // 详细错误只写日志；响应只给稳定分类。
      if (probe.detail) log.warn(`[bootstrap] 预检失败 detail=${probe.detail}`);
      // 精确退回进入 validating 之前的阶段：修正失败安装仍是
      // `migration_failed`，而不是冒充成全新安装。
      await options.store
        .abortValidation({
          idempotencyKey,
          failure: probe.failure ?? 'invalid_config',
        })
        .catch((error: unknown) => {
          log.error(
            `[bootstrap] 无法回退 validating 状态：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return reply.code(422).send({
        error: '基础设施预检未通过',
        code: BOOTSTRAP_ERROR_CODES.probeFailed,
        failure: probe.failure,
      });
    }

    // —— 落候选 + 发布任务 ——
    try {
      const published = await options.store.publishCandidate({
        configContent: serialized,
        configDigest: digest,
        idempotencyKey,
        nextPhase: 'queued',
      });
      // 发布触发文件（审计 R3）：path unit 只监听文件存在，因此任务文件必须
      // 是单独的、可被移出 inbox 的对象，而不是状态文件里的字段。
      // 即使这一步失败，runner 仍能从 `phase=queued` 直接恢复，不会卡死。
      const instanceId = options.instanceId ?? process.env['STACKPANEL_UPDATE_INSTANCE_ID'] ?? 'stackpanel';
      const channel = bootstrapChannelPaths(options.stateDir, instanceId);
      await ensureBootstrapChannel(channel);
      await publishBootstrapTask(channel, {
        id: operationIdFromKey(idempotencyKey),
        configGeneration: published.configGeneration,
        targetVersion: options.targetVersion,
      });

      log.info(`[bootstrap] 已提交候选配置 generation=${published.configGeneration}`);
      return reply.code(202).send({
        operation: toOperationView(published, published.idempotencyKey),
      });
    } catch (error) {
      if (error instanceof BootstrapStateError && error.code === 'generation_mismatch') {
        return reply.code(409).send({
          error: '同一幂等键对应不同配置',
          code: BOOTSTRAP_ERROR_CODES.idempotencyConflict,
        });
      }
      if (error instanceof BootstrapStateError) {
        return reply.code(409).send({
          error: error.message,
          code: BOOTSTRAP_ERROR_CODES.notWritable,
        });
      }
      throw error;
    }
  });

  return app;
}

/** 与主 app 相同的 trustProxy 解析语义。 */
function parseTrustProxy(raw: string | undefined): boolean | string[] {
  if (!raw || raw.trim().length === 0) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** 内容摘要（与配置存储层的 diff 判定同源）。 */
function digestOf(content: string): string {
  // 序列化顺序由白名单固定，因此对整份内容求摘要即可稳定识别"同一份配置"。
  return createHash('sha256').update(content).digest('hex');
}
