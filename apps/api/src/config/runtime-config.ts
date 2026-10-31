/**
 * 运行期内核配置：数据库优先，环境变量兜底（ADR-0026）。
 *
 * 背景：过去几乎所有内核开关只能通过 `.env` 配置——改一次就要改文件、重启进程，
 * 容器/集群里还得同步改 Compose。`distribution/source-config.ts` 已经验证过
 * 「数据库覆盖环境变量」这条路可行，本模块把它推广成**通用机制**。
 *
 * 三条设计约束：
 *
 * 1. **同步读取**。内核里读这些配置的地方遍布请求路径（签发会话、下发 cookie、
 *    校验验证码、限流、媒体尺寸上限……），把它们全改成 `await` 会把异步性扩散到
 *    几十个签名里，风险远大于收益。因此这里维护**进程内快照**：启动时预热一次，
 *    变更时本地更新并通过 Redis 广播让其它副本重载（见 `runtime/coherence.ts`）。
 * 2. **解析逻辑唯一**。数据库里存的是 JSON 标量，解析时复用 `env.ts` 的字段 schema
 *    （`envFieldSchemas`）——取值域、`default()`、`transform()` 与原来读环境变量
 *    完全一致，不会出现「后台能存进去、运行期行为不同」的分裂。
 * 3. **不是所有配置都能入库**。引导类（`DATABASE_URL`）、密钥类（`JWT_SECRET`、
 *    `SETTINGS_ENCRYPTION_KEY`）、进程自身（`API_PORT`）、基础设施（`REDIS_URL`、
 *    对象存储）必须留在进程外：读库要先连库，钥匙不能锁进它保护的那个柜子。
 *    启动期一次性读取的项（日志级别、CORS、连接池、OTEL）也仍读环境变量，
 *    因为它们在任何请求之前就要生效，此时快照还没建立。这些边界写在
 *    `docs/design/runtime-config.md` 与 ADR-0026 里。
 */
import type { Prisma } from '@stackpanel/db';
import type { z } from 'zod';
import { env, envFieldSchemas, type Env } from './env.ts';
import { getPrisma } from '../plugins/prisma.ts';

/** Setting 表里运行期配置的前缀：`config.AUTH_CAPTCHA_MODE` 等。 */
const SETTING_PREFIX = 'config.';

export type RuntimeConfigGroup =
  'auth' | 'session' | 'media' | 'openapi' | 'plugins' | 'audit' | 'agent';

/**
 * 内核可以**读**的运行期配置键（值一律是 `envSchema` 里同名字段的合法取值）。
 * 注意这是读取口径，不等于"后台可改"：可改的只有 `RUNTIME_CONFIG_SPECS` 里的项。
 */
export type RuntimeConfigName =
  | 'AUTH_CAPTCHA_MODE'
  | 'AUTH_CODE_TTL_SECONDS'
  | 'AUTH_CODE_MAX_ATTEMPTS'
  | 'AUTH_CODE_SEND_PER_HOUR'
  | 'AUTH_CODE_SEND_PER_HOUR_PER_IP'
  | 'AUTH_CODE_SEND_COOLDOWN_SECONDS'
  | 'SESSION_COOKIE_NAME'
  | 'SESSION_TTL_SECONDS'
  | 'MEDIA_MAX_UPLOAD_BYTES'
  | 'MEDIA_VARIANTS_ASYNC'
  | 'OPEN_API_TOKEN_RPM'
  | 'OPEN_API_TOKEN_CONCURRENCY'
  | 'PACKAGE_SIGNATURE_REQUIRED'
  | 'AUDIT_LOG_RETENTION_DAYS'
  | 'STACKPANEL_API_TOKEN_PREFIX'
  | 'AGENT_PUBLIC_ORIGIN'
  | 'AGENT_WEB_ORIGIN';

export interface RuntimeConfigSpec {
  name: RuntimeConfigName;
  group: RuntimeConfigGroup;
}

/**
 * 允许入库的运行期配置。**白名单**而非黑名单：新增环境变量默认不可通过后台修改，
 * 避免某天多加一个密钥类变量就被无意暴露成可编辑项。
 *
 * 不在这里、但仍需运维理解的项见 `docs/design/runtime-config.md`：
 * 引导/密钥/基础设施 16 项 + 启动期读取 15 项，以及已有专属后台界面的
 * `distribution.catalogSource`（分发源）与 `signing.publicKey`（签名公钥）。
 *
 * **跨进程约定项不得入库**：`SESSION_COOKIE_NAME` / `SESSION_TTL_SECONDS` 虽然内核自己
 * 也在读，但 web BFF 是**另一个进程**（另一个容器、另一份环境变量），它用它决定自己写入
 * 的 cookie 名与 maxAge。内核这边改了名，web 那边仍按旧名读 → 全站会话立即全部失效；
 * 内核侧 TTL 缩短、web 侧 cookie 仍按旧 maxAge 存活 → 运维以为"把会话调短了"，浏览器却
 * 一直带着一个已过期的 token（表现为 401 循环）。这类"必须两边同时改"的项属于部署契约，
 * 只能留在 `.env`，不进后台。
 */
export const RUNTIME_CONFIG_SPECS: readonly RuntimeConfigSpec[] = Object.freeze([
  { name: 'AUTH_CAPTCHA_MODE', group: 'auth' },
  { name: 'AUTH_CODE_TTL_SECONDS', group: 'auth' },
  { name: 'AUTH_CODE_MAX_ATTEMPTS', group: 'auth' },
  { name: 'AUTH_CODE_SEND_PER_HOUR', group: 'auth' },
  { name: 'AUTH_CODE_SEND_PER_HOUR_PER_IP', group: 'auth' },
  { name: 'AUTH_CODE_SEND_COOLDOWN_SECONDS', group: 'auth' },
  { name: 'MEDIA_MAX_UPLOAD_BYTES', group: 'media' },
  { name: 'MEDIA_VARIANTS_ASYNC', group: 'media' },
  { name: 'OPEN_API_TOKEN_RPM', group: 'openapi' },
  { name: 'OPEN_API_TOKEN_CONCURRENCY', group: 'openapi' },
  { name: 'PACKAGE_SIGNATURE_REQUIRED', group: 'plugins' },
  { name: 'AUDIT_LOG_RETENTION_DAYS', group: 'audit' },
  { name: 'STACKPANEL_API_TOKEN_PREFIX', group: 'openapi' },
  { name: 'AGENT_PUBLIC_ORIGIN', group: 'agent' },
  { name: 'AGENT_WEB_ORIGIN', group: 'agent' },
]);

const SPEC_BY_NAME = new Map<string, RuntimeConfigSpec>(
  RUNTIME_CONFIG_SPECS.map((spec) => [spec.name, spec]),
);

/** 是否是可通过后台修改的运行期配置项。 */
export function isRuntimeConfigName(value: string): value is RuntimeConfigName {
  return SPEC_BY_NAME.has(value);
}

/** Setting 表里对应这一项的键名。 */
export function runtimeConfigSettingKey(name: RuntimeConfigName): string {
  return `${SETTING_PREFIX}${name}`;
}

/** 配置来源：数据库覆盖 / 环境变量 / 字段默认值。 */
export type RuntimeConfigSource = 'stored' | 'env' | 'default';

/**
 * 进程内快照。`null` 表示尚未预热——此时所有读取回退到环境变量，
 * 与「没有数据库覆盖」等价，因此预热失败不会改变任何现有行为。
 */
let overrides: Partial<Record<RuntimeConfigName, unknown>> = {};
let loaded = false;

/**
 * 前台可见的一行配置（后台界面用）。**只有键名与取值，没有自然语言**：
 * 文案按 ADR-0016 走前端 i18n catalog，服务端不返回待翻译的成句文本。
 */
export interface RuntimeConfigEntry {
  name: RuntimeConfigName;
  group: RuntimeConfigGroup;
  /** 当前生效值（已按 envSchema 字段解析，类型与运行期一致）。 */
  value: unknown;
  source: RuntimeConfigSource;
  /** 环境变量里的值；未设置时为 null（改回环境变量时运维能看到会回落到什么）。 */
  envValue: unknown;
}

/** 把数据库里存的值按同名字段的 schema 解析成运行期类型。 */
function parseStoredValue(
  name: RuntimeConfigName,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const field = envFieldSchemas[name] as z.ZodTypeAny | undefined;
  if (!field) return { ok: false, error: `未知配置项：${name}` };
  // 环境变量本质都是字符串；数据库里存 JSON 标量更自然。两者统一成字符串后
  // 走同一个 schema，`coerce`/`enum`/`transform` 的行为与读 env 完全一致。
  let candidate: string;
  if (typeof raw === 'string') candidate = raw;
  else if (typeof raw === 'number' || typeof raw === 'boolean') candidate = String(raw);
  else return { ok: false, error: '配置值只能是字符串、数字或布尔值' };
  const parsed = field.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? '配置值无效' };
  }
  return { ok: true, value: parsed.data };
}

/** 用数据库行重建快照（也供测试直接注入）。非法值按「未配置」处理并保留告警。 */
export function applyRuntimeConfigRows(rows: ReadonlyArray<{ key: string; value: unknown }>): void {
  const next: Partial<Record<RuntimeConfigName, unknown>> = {};
  for (const row of rows) {
    if (!row.key.startsWith(SETTING_PREFIX)) continue;
    const name = row.key.slice(SETTING_PREFIX.length);
    if (!isRuntimeConfigName(name)) continue;
    const parsed = parseStoredValue(name, row.value);
    if (parsed.ok) next[name] = parsed.value;
  }
  overrides = next;
  loaded = true;
}

/**
 * 从 Setting 表预热快照。数据库不可用时（首次迁移前、单测无库）保持未预热状态，
 * 读取继续走环境变量——配置读取不能成为启动的单点故障。
 */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    const rows = await getPrisma().setting.findMany({
      where: { key: { startsWith: SETTING_PREFIX } },
      select: { key: true, value: true },
    });
    applyRuntimeConfigRows(rows);
  } catch {
    // 保持当前快照（可能是上一次成功加载的结果），最坏情况退回环境变量。
  }
}

/** 是否已成功预热（仅测试与诊断用）。 */
export function runtimeConfigLoaded(): boolean {
  return loaded;
}

/** 供测试重置快照。 */
export function resetRuntimeConfigForTest(): void {
  overrides = {};
  loaded = false;
}

/** 环境变量里是否有显式取值（空串视为未设置，与 `emptyToUndefined` 一致）。 */
function envHasValue(name: RuntimeConfigName): boolean {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** 同步读取当前生效值。**这是内核里所有运行期配置读取的唯一入口。** */
export function getConfig<K extends RuntimeConfigName>(name: K): Env[K] {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name] as Env[K];
  }
  return env[name as keyof Env] as Env[K];
}

/** 该项当前取值来自哪里。 */
export function getConfigSource(name: RuntimeConfigName): RuntimeConfigSource {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return 'stored';
  return envHasValue(name) ? 'env' : 'default';
}

/** 后台界面用的配置清单。 */
export function runtimeConfigEntries(): RuntimeConfigEntry[] {
  return RUNTIME_CONFIG_SPECS.map((spec) => ({
    name: spec.name,
    group: spec.group,
    value: getConfig(spec.name),
    source: getConfigSource(spec.name),
    envValue: envHasValue(spec.name) ? env[spec.name as keyof Env] : null,
  }));
}

/**
 * 写入（或清除）一项运行期配置。
 *
 * `rawValue === null` 表示删除数据库覆盖、回退到环境变量。写入前用同一份字段
 * schema 校验——后台不可能存进一个运行期无法解析的值。
 */
export async function saveRuntimeConfig(
  name: string,
  rawValue: unknown,
  updatedBy: string | null,
): Promise<void> {
  if (!isRuntimeConfigName(name)) throw new Error(`未知配置项：${name}`);
  const prisma = getPrisma();
  const key = runtimeConfigSettingKey(name);
  if (rawValue === null) {
    await prisma.setting.deleteMany({ where: { key } });
    delete overrides[name];
    return;
  }
  const parsed = parseStoredValue(name, rawValue);
  if (!parsed.ok) throw new Error(parsed.error);
  // 存**解析后**的值（900 而不是 "900"），这样数据库里看到的就是运行期实际用的
  // 类型；可选配置被清空（解析成 undefined）等价于「没有覆盖」，直接删行。
  if (parsed.value === undefined) {
    await prisma.setting.deleteMany({ where: { key } });
    delete overrides[name];
    return;
  }
  const value = parsed.value as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { key },
    create: { key, value, updatedBy },
    update: { value, updatedBy },
  });
  overrides[name] = parsed.value;
}
