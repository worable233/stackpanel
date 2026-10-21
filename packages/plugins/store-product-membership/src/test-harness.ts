import type {
  ExtensionInstance,
  ExtensionTransaction,
  GrantUserGroupInput,
  PermissionGroup,
  PluginContext,
  ProvisionContext,
  UserGroupGrant,
} from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { ProductTypeProvider } from '@stackpanel/sdk';
import storeProductMembershipPlugin from './index.js';

/**
 * 内存版的权限组内核（模拟 `ctx.auth` 的成员关系部分）。
 *
 * 关键行为要与真实内核一致：`listUserGroups` / `hasPermission` 必须过滤过期成员
 * （这是「到期即失效」的权威判定），而 `listUserGroupGrants` 不过滤（用于撤销
 * 依据核对）。测试里必须模拟这个差异，否则测不到读路径的过期语义。
 */
export class FakeAuth {
  readonly groups = new Map<string, PermissionGroup>();
  /** key = `${userId}:${groupId}` */
  readonly members = new Map<string, { userId: string; groupId: string; expiresAt: Date | null }>();
  readonly grantCalls: GrantUserGroupInput[] = [];
  readonly revokeCalls: Array<{ userId: string; groupId: string }> = [];

  constructor(groups: PermissionGroup[]) {
    for (const group of groups) this.groups.set(group.id, group);
  }

  async listPermissionGroups(): Promise<PermissionGroup[]> {
    return [...this.groups.values()];
  }

  async listUserGroups(userId: string): Promise<PermissionGroup[]> {
    const now = Date.now();
    return [...this.members.values()]
      .filter((row) => row.userId === userId)
      .filter((row) => row.expiresAt === null || row.expiresAt.getTime() > now)
      .map((row) => this.groups.get(row.groupId))
      .filter((group): group is PermissionGroup => Boolean(group));
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const groups = await this.listUserGroups(userId);
    return groups.some((group) => group.id === permission);
  }

  async grantUserGroup(input: GrantUserGroupInput): Promise<UserGroupGrant> {
    const group = this.groups.get(input.groupId);
    if (!group) throw new Error(`权限组不存在：${input.groupId}`);
    const expiresAt =
      input.expiresAt === null || input.expiresAt === undefined
        ? null
        : input.expiresAt instanceof Date
          ? input.expiresAt
          : new Date(input.expiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new Error('到期时间必须晚于当前时间');
    }
    this.grantCalls.push(input);
    this.members.set(`${input.userId}:${input.groupId}`, {
      userId: input.userId,
      groupId: input.groupId,
      expiresAt,
    });
    return {
      userId: input.userId,
      groupId: input.groupId,
      groupName: group.name,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      expired: false,
    };
  }

  async revokeUserGroup(userId: string, groupId: string): Promise<boolean> {
    this.revokeCalls.push({ userId, groupId });
    return this.members.delete(`${userId}:${groupId}`);
  }

  async listUserGroupGrants(userId: string): Promise<UserGroupGrant[]> {
    const now = Date.now();
    return [...this.members.values()]
      .filter((row) => row.userId === userId)
      .map((row) => ({
        userId: row.userId,
        groupId: row.groupId,
        groupName: this.groups.get(row.groupId)?.name ?? row.groupId,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      }));
  }
}

/** 内存版扩展模型客户端（够用的子集：create/get/list/listAll/update/delete）。 */
export class FakeExtensions {
  private readonly rows = new Map<string, ExtensionInstance<Record<string, unknown>>>();
  private seq = 0;

  async create(
    _model: unknown,
    spec: Record<string, unknown>,
  ): Promise<ExtensionInstance<Record<string, unknown>>> {
    this.seq += 1;
    const name = `row-${this.seq}`;
    const row: ExtensionInstance<Record<string, unknown>> = {
      name,
      spec: { ...spec },
      status: null,
      ownerId: null,
      version: 1,
      labels: {},
      annotations: {},
      finalizers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      deletionTimestamp: null,
    };
    this.rows.set(name, row);
    return row;
  }

  async get(_model: unknown, name: string): Promise<ExtensionInstance<Record<string, unknown>> | null> {
    const row = this.rows.get(name);
    return row ? { ...row, spec: { ...row.spec } } : null;
  }

  async list(_model: unknown, query: { where?: Record<string, unknown>; pageSize?: number }) {
    const items = this.filter(query.where);
    return { items, total: items.length, page: 1, pageSize: query.pageSize ?? 200 };
  }

  async listAll(_model: unknown, query?: { where?: Record<string, unknown> }) {
    return this.filter(query?.where);
  }

  async update(
    _model: unknown,
    name: string,
    spec: Record<string, unknown>,
    opts?: { expectedVersion?: number },
  ): Promise<ExtensionInstance<Record<string, unknown>>> {
    const row = this.rows.get(name);
    if (!row) throw new Error('extension.not_found');
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
      throw new Error('extension.version_conflict');
    }
    const next: ExtensionInstance<Record<string, unknown>> = {
      ...row,
      spec: { ...spec },
      version: row.version + 1,
      updatedAt: new Date(),
    };
    this.rows.set(name, next);
    return next;
  }

  async delete(_model: unknown, name: string): Promise<void> {
    this.rows.delete(name);
  }

  /** 测试用：直接读全部行。 */
  all(): Array<ExtensionInstance<Record<string, unknown>>> {
    return [...this.rows.values()];
  }

  private filter(where: Record<string, unknown> | undefined) {
    const entries = Object.entries(where ?? {});
    return [...this.rows.values()]
      .filter((row) =>
        entries.every(([field, condition]) => {
          const value = row.spec[field];
          const cond = condition as { eq?: unknown; lte?: number; gt?: number };
          if (cond.eq !== undefined) return value === cond.eq;
          if (cond.lte !== undefined) return typeof value === 'number' && value <= cond.lte;
          if (cond.gt !== undefined) return typeof value === 'number' && value > cond.gt;
          return true;
        }),
      )
      .map((row) => ({ ...row, spec: { ...row.spec } }));
  }
}

/** 组装一个可激活的假插件上下文。 */
export function fakePluginContext(options?: {
  groups?: PermissionGroup[];
}): {
  ctx: PluginContext;
  auth: FakeAuth;
  extensions: FakeExtensions;
  notifications: Array<Record<string, unknown>>;
  jobs: Map<string, () => Promise<void> | void>;
  productType: () => ProductTypeProvider;
  fulfillmentProvider: () => unknown;
} {
  const auth = new FakeAuth(
    options?.groups ?? [
      { id: 'group_vip', name: 'VIP 会员', description: null, discount: 10 },
      { id: 'group_admin', name: '管理员', description: null, discount: null },
    ],
  );
  const extensions = new FakeExtensions();
  const notifications: Array<Record<string, unknown>> = [];
  const jobs = new Map<string, () => Promise<void> | void>();
  let productType: ProductTypeProvider | null = null;
  let fulfillmentProvider: unknown = null;
  const ctx = {
    manifest: { id: 'store-product-membership', name: '会员', version: '0.1.0' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    extensions,
    tx: async <T>(fn: (tx: ExtensionTransaction) => Promise<T>): Promise<T> =>
      fn({ extensions } as unknown as ExtensionTransaction),
    auth,
    notifications: {
      create: async (input: Record<string, unknown>) => {
        notifications.push(input);
        return input;
      },
    },
    registerExtension: (point: string, implementation: unknown) => {
      if (point === EXTENSION_POINTS.productType) productType = implementation as ProductTypeProvider;
      if (point === EXTENSION_POINTS.fulfillmentProvider) fulfillmentProvider = implementation;
      return () => {};
    },
    effect: (fn: (collect: (d: () => void) => void) => void | (() => void)) => {
      const disposers: Array<() => void> = [];
      const produced = fn((d) => disposers.push(d));
      if (typeof produced === 'function') disposers.push(produced);
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    },
    jobs: {
      handle: (name: string, handler: () => Promise<void> | void) => {
        jobs.set(name, handler);
        return () => jobs.delete(name);
      },
      schedule: async () => {},
      enqueue: async () => '',
    },
  } as unknown as PluginContext;
  return {
    ctx,
    auth,
    extensions,
    notifications,
    jobs,
    productType: () => {
      if (!productType) throw new Error('productType not registered');
      return productType;
    },
    fulfillmentProvider: () => {
      if (!fulfillmentProvider) throw new Error('fulfillmentProvider not registered');
      return fulfillmentProvider;
    },
  };
}

/** 激活插件并返回捕获到的注册项。 */
export function activate(options?: { groups?: PermissionGroup[] }) {
  const harness = fakePluginContext(options);
  storeProductMembershipPlugin.onActivate?.(harness.ctx);
  return harness;
}

/** 构造一次 provision 调用上下文。 */
export function provisionContext(overrides?: {
  orderId?: string;
  userId?: string;
  productId?: string;
  groupId?: string | null;
  expiresAt?: string | null;
  allowPermanent?: boolean;
  price?: number;
}): ProvisionContext {
  const groupId = overrides?.groupId === undefined ? 'group_vip' : overrides.groupId;
  return {
    orderId: overrides?.orderId ?? 'order-1',
    userId: overrides?.userId ?? 'user-1',
    productId: overrides?.productId ?? 'product-1',
    product: {
      id: overrides?.productId ?? 'product-1',
      name: 'VIP 年费会员',
      price: overrides?.price ?? 9900,
      currency: 'CNY',
      metadata: {
        ...(groupId ? { groupId } : {}),
        ...(overrides?.allowPermanent ? { allowPermanent: true } : {}),
      },
      providerId: null,
      providerProductId: null,
    },
    quantity: 1,
    ...(overrides?.expiresAt === undefined
      ? { expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() }
      : { expiresAt: overrides.expiresAt }),
    secrets: {
      isAvailable: () => true,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
  } as ProvisionContext;
}
