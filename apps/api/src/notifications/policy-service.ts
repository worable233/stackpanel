import type { Prisma, PrismaClient } from '@stackpanel/db';
import type {
  NotificationChannel,
  NotificationChannelInfo,
  NotificationCategoryInfo,
  NotificationChannelPreference,
  NotificationPolicyPatch,
  NotificationPolicyService,
  NotificationPolicyView,
  NotificationPreferenceItem,
  NotificationPreferencesView,
  NotificationTypeDefinition,
  NotificationTypePreference,
} from '@stackpanel/sdk';
import { INAPP_CHANNEL_ID } from '@stackpanel/sdk';

/**
 * 两级通知偏好引擎（审计 §5 后续项：订阅偏好）。
 *
 * 内核拥有目录、管理员级策略与最终裁决；本服务是唯一判定入口。
 *
 * 判定顺序（`(user, type, channel)`）：
 *   1. **未声明类型**：始终启用（没有目录项 = 无法关闭）。这是「验证码之类不可配置」
 *      的落地方式——它们走 `identity` 服务，根本不进通知表；同时任一插件忘记声明
 *      类型也不会被误关。
 *   2. **管理员策略**：`enabled:false` 全渠道关闭；`defaultChannels` 设定默认渠道；
 *      `locked:true` 冻结用户覆盖。
 *   3. **目录默认**：{@link NotificationTypeDefinition.defaultChannels}，缺省 = 全渠道。
 *   4. **用户覆盖**：仅对仍可配置的渠道生效。
 *
 * 目录条目支持精确类型或 `.*` 前缀通配（如 `system.plugin.*`），解析时「最具体者胜」。
 */

/** 管理员级策略存放于公共 `Setting` 表（非机密）。 */
const POLICY_SETTING_KEY = 'notifications.policy';

/** 未知分类的兜底条目（`noUncheckedIndexedAccess` 下不可用下标断言）。 */
const OTHER_CATEGORY = { label: '其他', order: 90 };

/** 分类显示名与排序（仅用于 UI 分组；内核文档语言为中文）。 */
const CATEGORY_META: Record<string, { label: string; order: number }> = {
  system: { label: '系统', order: 10 },
  security: { label: '安全', order: 20 },
  wallet: { label: '钱包与账单', order: 30 },
  store: { label: '交易与订阅', order: 40 },
  support: { label: '工单', order: 50 },
  agent: { label: 'Agent', order: 60 },
  marketing: { label: '推广与营销', order: 70 },
  other: OTHER_CATEGORY,
};

function categoryMeta(id: string): { label: string; order: number } {
  return CATEGORY_META[id] ?? OTHER_CATEGORY;
}

/**
 * 内核内建目录：覆盖**内核自身**发出的所有类型（系统 / 安全 / 钱包 / 内核侧
 * 服务管理 / Agent），以及内核与插件都可能发出的共享类型。业务插件
 * （store/ticket/login/referral…）通过 `notification.type` 扩展点声明各自的
 * 类型，避免内核反向依赖具体插件。
 *
 * 与 `notification.type` 声明合并时按 `type` 去重（插件同值覆盖内建）。
 * 新增发出点却忘了在此登记，`apps/api/tests/unit/notification-type-coverage.test.ts`
 * 会失败——这是「发出即声明」的守门。
 *
 * `defaultChannels` 缺省 = 全渠道。纯活动进度类（Agent 内部）默认仅站内，
 * 避免把每次进度更新都转成邮件（审计 §5）。
 */
export const BUILTIN_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  {
    type: 'system.plugin.*',
    category: 'system',
    label: '插件生命周期',
    audience: 'admin',
    order: 10,
  },
  {
    type: 'system.theme.*',
    category: 'system',
    label: '主题生命周期',
    audience: 'admin',
    order: 20,
  },
  {
    type: 'system.update.*',
    category: 'system',
    label: '系统更新',
    audience: 'admin',
    order: 30,
  },
  {
    type: 'security.password.reset',
    category: 'security',
    label: '密码被重置',
    order: 10,
  },
  {
    type: 'security.account.disabled',
    category: 'security',
    label: '账号被停用',
    order: 20,
  },
  {
    type: 'security.account.enabled',
    category: 'security',
    label: '账号已恢复',
    order: 30,
  },
  {
    type: 'wallet.topup.succeeded',
    category: 'wallet',
    label: '充值到账',
    order: 20,
  },
  {
    type: 'wallet.balance.adjusted',
    category: 'wallet',
    label: '余额被调整',
    order: 30,
  },
  {
    type: 'service.granted',
    category: 'store',
    label: '收到新服务',
    order: 120,
  },
  {
    type: 'service.updated',
    category: 'store',
    label: '服务信息被修改',
    order: 130,
  },
  {
    type: 'service.removed',
    category: 'store',
    label: '服务被移除',
    order: 140,
  },
  {
    type: 'agent.*',
    category: 'agent',
    label: 'Agent 动态',
    defaultChannels: [INAPP_CHANNEL_ID],
    order: 10,
  },
];

/** 存储的管理员策略形态。 */
interface StoredPolicy {
  types: Record<string, { enabled?: boolean; defaultChannels?: string[]; locked?: boolean }>;
}

export interface NotificationPolicyServiceOptions {
  db: PrismaClient;
  /** Live registered external channels (for the catalog/UI). */
  getChannels: () => NotificationChannel[];
  /** Live notification-type declarations (plugin extension point + built-ins). */
  getTypeDefinitions: () => NotificationTypeDefinition[];
  logger?: { warn: (message: string) => void };
}

interface ResolvedType {
  key: string;
  def: NotificationTypeDefinition;
}

/** `system.plugin.*` matches `system.plugin.enable`; exact beats prefix. */
function resolveType(
  type: string,
  definitions: readonly NotificationTypeDefinition[],
): ResolvedType | null {
  let best: ResolvedType | null = null;
  for (const def of definitions) {
    if (def.type === type) return { key: def.type, def };
    if (def.type.endsWith('.*')) {
      const prefix = def.type.slice(0, -1); // keep the trailing dot
      if (type.startsWith(prefix) && (!best || def.type.length > best.key.length)) {
        best = { key: def.type, def };
      }
    }
  }
  return best;
}

function normalizeDefinition(value: NotificationTypeDefinition): NotificationTypeDefinition | null {
  if (!value || typeof value.type !== 'string' || value.type.length === 0) return null;
  return {
    type: value.type,
    category: value.category || 'other',
    label: value.label || value.type,
    audience: value.audience === 'admin' ? 'admin' : 'user',
    ...(value.description ? { description: value.description } : {}),
    ...(value.defaultChannels ? { defaultChannels: value.defaultChannels } : {}),
    userConfigurable: value.userConfigurable !== false,
    ...(typeof value.order === 'number' ? { order: value.order } : {}),
  };
}

export class KernelNotificationPolicyService implements NotificationPolicyService {
  private readonly logger: { warn: (message: string) => void };
  /** Cache of the admin policy setting; invalidated on write and after TTL. */
  private policyCache: { value: StoredPolicy; at: number } | null = null;
  private static readonly POLICY_TTL_MS = 5_000;

  constructor(private readonly options: NotificationPolicyServiceOptions) {
    this.logger = options.logger ?? { warn: () => undefined };
  }

  /* ----------------------------- 目录/渠道 ------------------------------ */

  private catalog(): NotificationTypeDefinition[] {
    const map = new Map<string, NotificationTypeDefinition>();
    for (const def of BUILTIN_NOTIFICATION_TYPES) {
      const normalized = normalizeDefinition(def);
      if (normalized) map.set(normalized.type, normalized);
    }
    // Plugin declarations override or extend the built-ins (same `type` wins).
    for (const raw of this.options.getTypeDefinitions()) {
      const normalized = normalizeDefinition(raw);
      if (normalized) {
        // Redeclaring a built-in must not expose an operator-only type to accounts.
        if (map.get(normalized.type)?.audience === 'admin') normalized.audience = 'admin';
        map.set(normalized.type, normalized);
      }
    }
    const definitions = [...map.values()];
    // An operator-only wildcard also owns its descendants; plugin redeclarations
    // cannot accidentally publish a more specific internal type in account settings.
    const operatorPrefixes = definitions
      .filter((def) => def.audience === 'admin' && def.type.endsWith('.*'))
      .map((def) => def.type.slice(0, -1));
    for (const def of definitions) {
      if (operatorPrefixes.some((prefix) => def.type.startsWith(prefix))) def.audience = 'admin';
    }
    return definitions;
  }

  private channelInfos(): NotificationChannelInfo[] {
    const infos: NotificationChannelInfo[] = [
      { id: INAPP_CHANNEL_ID, name: '站内通知', inApp: true },
    ];
    const seen = new Set([INAPP_CHANNEL_ID]);
    for (const channel of this.options.getChannels()) {
      if (seen.has(channel.id)) continue;
      seen.add(channel.id);
      infos.push({ id: channel.id, name: channel.name, inApp: false });
    }
    return infos;
  }

  private categories(
    definitions: readonly NotificationTypeDefinition[],
  ): NotificationCategoryInfo[] {
    const ids = new Set(definitions.map((def) => def.category));
    return [...ids]
      .sort((a, b) => categoryMeta(a).order - categoryMeta(b).order)
      .map((id) => ({ id, label: categoryMeta(id).label }));
  }

  /* ----------------------------- 管理员策略 ----------------------------- */

  private async loadPolicy(): Promise<StoredPolicy> {
    const fresh =
      this.policyCache &&
      Date.now() - this.policyCache.at < KernelNotificationPolicyService.POLICY_TTL_MS;
    if (fresh && this.policyCache) return this.policyCache.value;
    let value: StoredPolicy = { types: {} };
    try {
      const row = await this.options.db.setting.findUnique({ where: { key: POLICY_SETTING_KEY } });
      if (row && row.value && typeof row.value === 'object') {
        const parsed = row.value as unknown as StoredPolicy;
        if (parsed.types && typeof parsed.types === 'object') value = { types: parsed.types };
      }
    } catch (error) {
      this.logger?.warn(`[notifications.policy] 读取策略失败：${String(error)}`);
    }
    this.policyCache = { value, at: Date.now() };
    return value;
  }

  /* ------------------------------ 单点判定 ------------------------------ */

  /** 解析一次：目录项 + 管理员策略 + 该用户该目录键的全部覆盖。 */
  private async resolve(
    userId: string,
    type: string,
  ): Promise<{
    key: string;
    def: NotificationTypeDefinition;
    policy: { enabled?: boolean; defaultChannels?: string[]; locked?: boolean };
    overrides: Map<string, boolean>;
  } | null> {
    const resolved = resolveType(type, this.catalog());
    if (!resolved) return null;
    const policy = await this.loadPolicy();
    const entry = policy.types[resolved.key] ?? {};
    const rows = await this.options.db.notificationPreference.findMany({
      where: { userId, type: resolved.key },
      select: { channelId: true, enabled: true },
    });
    const overrides = new Map(rows.map((row) => [row.channelId, row.enabled]));
    return { key: resolved.key, def: resolved.def, policy: entry, overrides };
  }

  /** base 默认渠道集合；null 表示「全部渠道」。 */
  private baseChannels(
    def: NotificationTypeDefinition,
    policy: { defaultChannels?: string[] },
  ): string[] | null {
    return policy.defaultChannels ?? def.defaultChannels ?? null;
  }

  private isConfigurable(
    def: NotificationTypeDefinition,
    policy: { locked?: boolean; enabled?: boolean },
  ): boolean {
    return (
      def.audience !== 'admin' &&
      def.userConfigurable !== false &&
      policy.locked !== true &&
      policy.enabled !== false
    );
  }

  async isEnabled(userId: string, type: string, channelId: string): Promise<boolean> {
    const resolved = await this.resolve(userId, type);
    // 未声明类型：无可关闭项 → 永远投递。
    if (!resolved) return true;
    if (resolved.policy.enabled === false) return false;
    const base = this.baseChannels(resolved.def, resolved.policy);
    const defaultEnabled = base === null ? true : base.includes(channelId);
    if (!this.isConfigurable(resolved.def, resolved.policy)) return defaultEnabled;
    return resolved.overrides.get(channelId) ?? defaultEnabled;
  }

  async enabledChannels(userId: string, type: string): Promise<Set<string> | null> {
    const resolved = await this.resolve(userId, type);
    if (!resolved) return null; // 未声明 → 不过滤
    if (resolved.policy.enabled === false) return new Set();
    const base = this.baseChannels(resolved.def, resolved.policy);
    const configurable = this.isConfigurable(resolved.def, resolved.policy);
    const channels = this.channelInfos().map((info) => info.id);
    const enabled = new Set<string>();
    for (const channelId of channels) {
      const defaultEnabled = base === null ? true : base.includes(channelId);
      const effective = configurable
        ? (resolved.overrides.get(channelId) ?? defaultEnabled)
        : defaultEnabled;
      if (effective) enabled.add(channelId);
    }
    return enabled;
  }

  async inAppExclusions(userId: string): Promise<{ exact: string[]; prefixes: string[] } | null> {
    const definitions = this.catalog();
    const policy = await this.loadPolicy();
    const overrides = await this.options.db.notificationPreference.findMany({
      where: { userId, channelId: INAPP_CHANNEL_ID },
      select: { type: true, enabled: true },
    });
    const overrideMap = new Map(overrides.map((row) => [row.type, row.enabled] as const));

    const exact: string[] = [];
    const prefixes: string[] = [];
    for (const def of definitions) {
      const entry = policy.types[def.type] ?? {};
      const base = this.baseChannels(def, entry);
      const defaultEnabled =
        entry.enabled === false ? false : base === null ? true : base.includes(INAPP_CHANNEL_ID);
      const configurable = this.isConfigurable(def, entry);
      const effective = configurable
        ? (overrideMap.get(def.type) ?? defaultEnabled)
        : defaultEnabled;
      if (effective) continue;
      if (def.type.endsWith('.*'))
        prefixes.push(def.type.slice(0, -1)); // keep trailing dot
      else exact.push(def.type);
    }
    if (exact.length === 0 && prefixes.length === 0) return null;
    return { exact, prefixes };
  }

  /** 类型是否命中目录（精确或 `.*` 前缀）——供发出点做「未声明」守卫。 */
  declares(type: string): boolean {
    for (const def of this.catalog()) {
      if (def.type === type) return true;
      if (def.type.endsWith('.*') && type.startsWith(def.type.slice(0, -1))) return true;
    }
    return false;
  }

  /* -------------------------------- 用户视图 ----------------------------- */

  async listForUser(userId: string): Promise<NotificationPreferencesView> {
    const definitions = this.catalog().filter((def) => def.audience !== 'admin');
    const policy = await this.loadPolicy();
    const channels = this.channelInfos();
    const overrides = await this.options.db.notificationPreference.findMany({
      where: { userId },
      select: { type: true, channelId: true, enabled: true },
    });
    const overrideMap = new Map(
      overrides.map((row) => [`${row.type}\u0000${row.channelId}`, row.enabled] as const),
    );

    const types: NotificationTypePreference[] = definitions
      .slice()
      .sort(
        (a, b) =>
          categoryMeta(a.category).order - categoryMeta(b.category).order ||
          (a.order ?? 100) - (b.order ?? 100) ||
          a.type.localeCompare(b.type),
      )
      .map((def) => {
        const entry = policy.types[def.type] ?? {};
        const base = this.baseChannels(def, entry);
        const configurable = this.isConfigurable(def, entry);
        const channelPrefs: NotificationChannelPreference[] = channels.map((channel) => {
          const defaultEnabled =
            entry.enabled === false ? false : base === null ? true : base.includes(channel.id);
          const effective = configurable
            ? (overrideMap.get(`${def.type}\u0000${channel.id}`) ?? defaultEnabled)
            : defaultEnabled;
          return {
            channelId: channel.id,
            enabled: effective,
            defaultEnabled,
            configurable,
          };
        });
        return {
          type: def.type,
          category: def.category,
          label: def.label,
          description: def.description ?? null,
          configurable,
          channels: channelPrefs,
        };
      });

    return { channels, categories: this.categories(definitions), types };
  }

  async updateForUser(userId: string, items: NotificationPreferenceItem[]): Promise<void> {
    const definitions = this.catalog();
    const policy = await this.loadPolicy();
    const validChannels = new Set(this.channelInfos().map((info) => info.id));
    for (const item of items) {
      const resolved = resolveType(item.type, definitions);
      if (!resolved) continue; // 未声明类型不可配置
      if (!validChannels.has(item.channelId)) continue;
      const entry = policy.types[resolved.key] ?? {};
      if (entry.enabled === false) continue; // 管理员已全局关闭
      if (!this.isConfigurable(resolved.def, entry)) continue;
      await this.options.db.notificationPreference.upsert({
        where: {
          userId_type_channelId: { userId, type: resolved.key, channelId: item.channelId },
        },
        create: { userId, type: resolved.key, channelId: item.channelId, enabled: item.enabled },
        update: { enabled: item.enabled },
      });
    }
  }

  async resetForUser(userId: string, types?: string[]): Promise<void> {
    const definitions = this.catalog();
    const keys = new Set<string>();
    for (const type of types?.length ? types : definitions.map((def) => def.type)) {
      const resolved = resolveType(type, definitions);
      if (resolved && resolved.def.audience !== 'admin') keys.add(resolved.key);
    }
    if (keys.size === 0) return;
    await this.options.db.notificationPreference.deleteMany({
      where: { userId, type: { in: [...keys] } },
    });
  }

  /* -------------------------------- 管理视图 ----------------------------- */

  async listPolicy(): Promise<NotificationPolicyView> {
    const definitions = this.catalog();
    const policy = await this.loadPolicy();
    const types = definitions
      .slice()
      .sort(
        (a, b) =>
          categoryMeta(a.category).order - categoryMeta(b.category).order ||
          (a.order ?? 100) - (b.order ?? 100) ||
          a.type.localeCompare(b.type),
      )
      .map((def) => {
        const entry = policy.types[def.type] ?? {};
        const base = this.baseChannels(def, entry);
        return {
          type: def.type,
          category: def.category,
          label: def.label,
          enabled: entry.enabled !== false,
          defaultChannels: base ?? this.channelInfos().map((info) => info.id),
          locked: entry.locked === true,
          userConfigurable: def.audience !== 'admin' && def.userConfigurable !== false,
        };
      });
    return {
      channels: this.channelInfos(),
      categories: this.categories(definitions),
      types,
    };
  }

  async updatePolicy(patch: NotificationPolicyPatch): Promise<NotificationPolicyView> {
    const definitions = this.catalog();
    const current = await this.loadPolicy();
    const next: StoredPolicy = { types: { ...current.types } };
    for (const [key, value] of Object.entries(patch.types ?? {})) {
      const resolved = resolveType(key, definitions);
      if (!resolved) continue;
      const entry = { ...(next.types[resolved.key] ?? {}) };
      if (typeof value.enabled === 'boolean') entry.enabled = value.enabled;
      if (Array.isArray(value.defaultChannels)) {
        const valid = new Set(this.channelInfos().map((info) => info.id));
        entry.defaultChannels = value.defaultChannels.filter((id) => valid.has(id));
      }
      if (typeof value.locked === 'boolean') entry.locked = value.locked;
      next.types[resolved.key] = entry;
    }
    await this.options.db.setting.upsert({
      where: { key: POLICY_SETTING_KEY },
      create: { key: POLICY_SETTING_KEY, value: next as unknown as Prisma.InputJsonValue },
      update: { value: next as unknown as Prisma.InputJsonValue },
    });
    this.policyCache = { value: next, at: Date.now() };
    return this.listPolicy();
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    notificationPolicy: KernelNotificationPolicyService;
  }
}
