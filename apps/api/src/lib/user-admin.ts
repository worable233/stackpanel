/**
 * Admin user operations, extracted into one kernel service (P1 slice four).
 *
 * The admin BFF (`routes/admin/users.ts`) and the open `/api/v1/users*`
 * surface both call these methods, so the open API is a transport adapter and
 * never a second implementation (ADR-0001). Behaviour — last-admin protection,
 * session revocation on disable/reset, audit entries, response shapes — is
 * preserved exactly from the previous inline handlers.
 *
 * Failures throw {@link PluginError} with a stable HTTP status; the kernel
 * error handler renders the RFC 7807 problem (ADR-0012).
 */
import type { PrismaClient } from '@stackpanel/db';
import { isCommerceError, PluginError } from '@stackpanel/sdk';
import type {
  CommerceOperations,
  CommerceOrder,
  CommerceService,
  UpstreamServiceItem,
  UpstreamServiceSource,
  WalletService,
} from '@stackpanel/sdk';
import { generatePassword } from './generate.ts';
import { hashPassword } from './password.ts';
import { ADMIN_GROUP_ID, isLastAdmin, toPublicUser } from './user.ts';
import type { AuditInput } from '../plugins/audit.ts';
import { writeAudit } from '../plugins/audit.ts';

/** Request-derived audit fields, forwarded to every write. */
export type UserAdminAudit = Pick<AuditInput, 'actorId' | 'ip' | 'userAgent'>;

/** The coarse permission that defines a platform administrator. */
const PLATFORM_ADMIN = 'platform.admin';

/**
 * The acting principal for a user-admin operation.
 *
 * `permissions` is the caller's *effective* kernel permission set. The refined
 * `user:write` scope can be satisfied by the delegated `platform.manage.users`
 * permission alone, so it must never be enough to grant administrator access or
 * to operate on an existing administrator (privilege escalation, audit H-1).
 * Only a principal that itself holds `platform.admin` may cross that boundary.
 */
export interface UserAdminActor {
  id: string | undefined;
  permissions: ReadonlySet<string>;
}

export interface UserAdminAuth {
  revokeAllSessions(userId: string): Promise<void>;
  issueSession(userId: string): Promise<string>;
}

export interface UserAdminDeps {
  prisma: PrismaClient;
  wallet: WalletService;
  auth: UserAdminAuth;
  /** Commerce domain outlet (store plugin); absent when the plugin is inactive. */
  commerce?: CommerceOperations | null | undefined;
  /** Registered upstream service sources (upstream plugins); empty when none. */
  upstreamServiceSources?: UpstreamServiceSource[] | undefined;
}

export interface ListUsersInput {
  page: number;
  pageSize: number;
  q?: string | undefined;
  /** Filter by account status. */
  status?: 'ACTIVE' | 'DISABLED' | undefined;
  /** Filter to users that belong to this permission group. */
  groupId?: string | undefined;
}

export interface CreateUserInput {
  email: string;
  password?: string | undefined;
  status: 'ACTIVE' | 'DISABLED';
  groupIds?: string[] | undefined;
}

export interface UpdateUserInput {
  status?: 'ACTIVE' | 'DISABLED' | undefined;
  groupIds?: string[] | undefined;
}

export interface GiftServiceInput {
  productId: string;
  quantity: number;
  expiresAt?: string | null | undefined;
}

export interface UpdateServiceInput {
  expiresAt?: string | null | undefined;
  status?: string | undefined;
}

/** Map a ServiceInstance row to the admin/open view (dates as ISO strings). */
export function toAdminService(service: {
  id: string;
  productName: string;
  fulfillmentType: string;
  status: string;
  amount: number;
  currency: string;
  expiresAt: Date | null;
  providerId: string | null;
  providerServiceId: string | null;
  orderId: string | null;
  createdAt: Date;
}) {
  return {
    id: service.id,
    productName: service.productName,
    fulfillmentType: service.fulfillmentType,
    status: service.status,
    amount: service.amount,
    currency: service.currency,
    expiresAt: service.expiresAt ? service.expiresAt.toISOString() : null,
    providerId: service.providerId,
    providerServiceId: service.providerServiceId,
    orderId: service.orderId,
    createdAt: service.createdAt.toISOString(),
  };
}

export class UserAdminService {
  constructor(private readonly deps: UserAdminDeps) {}

  private get db(): PrismaClient {
    return this.deps.prisma;
  }

  private get commerce(): CommerceOperations | null {
    return this.deps.commerce ?? null;
  }

  private requireCommerce(): CommerceOperations {
    const commerce = this.commerce;
    if (!commerce) throw new PluginError('store.unavailable', 503, '商店能力暂不可用');
    return commerce;
  }

  /** Among `groupIds`, the ids of groups that confer platform administrator. */
  private async adminGroupIds(groupIds: readonly string[]): Promise<string[]> {
    const ids = [...new Set(groupIds)];
    if (ids.length === 0) return [];
    const rows = await this.db.permissionGroup.findMany({
      where: {
        id: { in: ids },
        OR: [
          { id: ADMIN_GROUP_ID },
          { permissions: { some: { permission: { key: PLATFORM_ADMIN } } } },
        ],
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Whether the user currently holds platform administrator via any group. */
  private async isPlatformAdminUser(userId: string): Promise<boolean> {
    const count = await this.db.userGroup.count({
      where: {
        userId,
        OR: [
          { groupId: ADMIN_GROUP_ID },
          { group: { permissions: { some: { permission: { key: PLATFORM_ADMIN } } } } },
        ],
      },
    });
    return count > 0;
  }

  /**
   * Reject privilege escalation attempted with a delegated user-management
   * scope: granting an administrator group, or acting on an administrator
   * account, requires the actor to hold `platform.admin` itself (audit H-1).
   */
  private async assertAdminPrivilege(
    actor: UserAdminActor,
    targetUserId: string | undefined,
    requestedGroupIds: readonly string[] | undefined,
  ): Promise<void> {
    if (actor.permissions.has(PLATFORM_ADMIN)) return;
    if (requestedGroupIds && requestedGroupIds.length > 0) {
      const adminGroups = await this.adminGroupIds(requestedGroupIds);
      if (adminGroups.length > 0) {
        throw new PluginError('user.admin_required', 403, '仅平台管理员可授予管理员权限组');
      }
    }
    if (targetUserId && (await this.isPlatformAdminUser(targetUserId))) {
      throw new PluginError('user.admin_required', 403, '仅平台管理员可操作管理员账号');
    }
  }

  async listUsers(input: ListUsersInput) {
    const { page, pageSize, q, status, groupId } = input;
    const where = {
      ...(q ? { email: { contains: q.toLowerCase() } } : {}),
      ...(status ? { status } : {}),
      ...(groupId ? { groups: { some: { groupId } } } : {}),
    };
    const [users, total] = await Promise.all([
      this.db.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { groups: { include: { group: true } } },
      }),
      this.db.user.count({ where }),
    ]);
    return {
      users: users.map((user) => ({
        ...toPublicUser(user),
        groups: user.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getUserDetail(id: string) {
    const user = await this.db.user.findUnique({
      where: { id },
      include: { groups: { include: { group: true } } },
    });
    if (!user) throw new PluginError('user.not_found', 404, '用户不存在');
    const [wallet, ledger] = await Promise.all([
      this.deps.wallet.getAccount(id),
      this.deps.wallet.listLedger(id, 20),
    ]);
    const services: CommerceService[] = this.commerce ? await this.commerce.listServices(id) : [];
    const orders: CommerceOrder[] = this.commerce
      ? (await this.commerce.listOrders(id, 1, 20)).items
      : [];
    return {
      user: {
        ...toPublicUser(user),
        groups: user.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
      },
      wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null,
      services: services.map(toAdminService),
      orders: orders.map((order) => ({
        id: order.id,
        status: order.status,
        total: order.total,
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
      })),
      ledger: ledger.map((entry) => ({
        id: entry.id,
        amount: entry.amount,
        currency: entry.currency,
        type: entry.type,
        note: entry.note,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  async createUser(input: CreateUserInput, audit: UserAdminAudit, actor: UserAdminActor) {
    const { email, password, status, groupIds } = input;
    await this.assertAdminPrivilege(actor, undefined, groupIds);
    const exists = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (exists) throw new PluginError('user.email_taken', 409, '邮箱已被使用');
    const generatedPassword = password ?? generatePassword();
    const groups = groupIds && groupIds.length > 0 ? groupIds : ['group_user'];
    const groupCount = await this.db.permissionGroup.count({ where: { id: { in: groups } } });
    if (groupCount !== groups.length) {
      throw new PluginError('user.group_not_found', 400, '权限组不存在');
    }
    const user = await this.db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash: await hashPassword(generatedPassword),
          status,
          groups: { create: groups.map((groupId) => ({ groupId })) },
        },
      });
      return created;
    });
    await writeAudit({
      action: 'user.create',
      resource: 'user',
      resourceId: user.id,
      meta: { groups },
      ...audit,
    });
    return {
      user: toPublicUser(user),
      ...(password ? {} : { generatedPassword }),
    };
  }

  async updateUser(
    id: string,
    input: UpdateUserInput,
    actor: UserAdminActor,
    audit: UserAdminAudit,
  ) {
    const { status, groupIds } = input;
    await this.assertAdminPrivilege(actor, id, groupIds);
    if (actor.id === id && groupIds && !groupIds.includes('group_admin')) {
      const inAdminGroup = await this.db.userGroup.findUnique({
        where: { userId_groupId: { userId: id, groupId: 'group_admin' } },
      });
      if (inAdminGroup) {
        throw new PluginError('user.self_demote', 400, '不能移除自己的管理员身份');
      }
    }
    if (groupIds && !groupIds.includes('group_admin') && (await isLastAdmin(id))) {
      throw new PluginError('user.last_admin', 400, '不能移除最后一位管理员');
    }
    if (status !== undefined && (await isLastAdmin(id)) && status !== 'ACTIVE') {
      throw new PluginError('user.last_admin', 400, '不能禁用最后一位管理员');
    }
    if (groupIds) {
      const groupCount = await this.db.permissionGroup.count({ where: { id: { in: groupIds } } });
      if (groupCount !== groupIds.length) {
        throw new PluginError('user.group_not_found', 400, '权限组不存在');
      }
    }
    await this.db.$transaction(async (tx) => {
      if (groupIds) {
        await tx.userGroup.deleteMany({ where: { userId: id } });
        await tx.userGroup.createMany({
          data: groupIds.map((groupId) => ({ userId: id, groupId })),
        });
      }
      if (status !== undefined) {
        await tx.user.update({ where: { id }, data: { status } });
      }
    });
    const user = await this.db.user.findUniqueOrThrow({
      where: { id },
      include: { groups: { include: { group: true } } },
    });
    if (status === 'DISABLED') {
      await this.deps.auth.revokeAllSessions(id);
    }
    await writeAudit({
      action: 'user.update',
      resource: 'user',
      resourceId: id,
      meta: { ...(groupIds ? { groupIds } : {}), ...(status ? { status } : {}) },
      ...audit,
    });
    return {
      user: {
        ...toPublicUser(user),
        groups: user.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
      },
    };
  }

  async resetPassword(
    id: string,
    password: string | undefined,
    audit: UserAdminAudit,
    actor: UserAdminActor,
  ) {
    await this.assertAdminPrivilege(actor, id, undefined);
    const generatedPassword = password ?? generatePassword();
    const user = await this.db.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(generatedPassword) },
    });
    await this.deps.auth.revokeAllSessions(id);
    await writeAudit({
      action: 'user.reset-password',
      resource: 'user',
      resourceId: id,
      ...audit,
    });
    return {
      user: toPublicUser(user),
      ...(password ? {} : { generatedPassword }),
    };
  }

  async adjustWallet(id: string, amount: number, note: string, actorId: string | undefined) {
    await this.deps.wallet.adjust({
      userId: id,
      amount,
      currency: 'CNY',
      note,
      ...(actorId ? { actorId } : {}),
    });
    const account = await this.deps.wallet.getAccount(id);
    return { balance: account?.balance ?? 0, currency: account?.currency ?? 'CNY' };
  }

  async impersonate(id: string, audit: UserAdminAudit, actor: UserAdminActor) {
    await this.assertAdminPrivilege(actor, id, undefined);
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user) throw new PluginError('user.not_found', 404, '用户不存在');
    if (user.status !== 'ACTIVE') {
      throw new PluginError('user.disabled', 400, '该账号已停用，无法进入');
    }
    const token = await this.deps.auth.issueSession(id);
    await writeAudit({
      action: 'user.impersonate',
      resource: 'user',
      resourceId: id,
      meta: { impersonatedEmail: user.email },
      ...audit,
    });
    return { token };
  }

  async listServices(id: string) {
    const services = this.commerce ? await this.commerce.listServices(id) : [];
    return { services: services.map(toAdminService) };
  }

  async giftService(id: string, input: GiftServiceInput, audit: UserAdminAudit) {
    const { productId, quantity, expiresAt } = input;
    const commerce = this.requireCommerce();
    let created: CommerceService[];
    try {
      created = await commerce.createServices({
        userId: id,
        productId,
        quantity,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });
    } catch (error) {
      if (isCommerceError(error)) {
        if (error.failure === 'product_not_found') {
          throw new PluginError('product.not_found', 404, '商品不存在');
        }
        if (error.failure === 'product_unavailable') {
          throw new PluginError('product.inactive', 400, '商品已停售，无法赠送');
        }
      }
      throw error;
    }
    await writeAudit({
      action: 'user.service.gift',
      resource: 'user',
      resourceId: id,
      meta: {
        productId,
        productName: created[0]?.productName ?? null,
        quantity,
        expiresAt: expiresAt ?? null,
      },
      ...audit,
    });
    const services = await commerce.listServices(id);
    return { services: services.map(toAdminService), created: created.map((row) => row.id) };
  }

  async updateService(
    id: string,
    serviceId: string,
    input: UpdateServiceInput,
    audit: UserAdminAudit,
  ) {
    const commerce = this.requireCommerce();
    const existing = await commerce.getService(id, serviceId);
    if (!existing) throw new PluginError('service.not_found', 404, '服务不存在');
    const updated = await commerce.updateService(serviceId, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.expiresAt !== undefined
        ? { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }
        : {}),
    });
    if (!updated) throw new PluginError('service.not_found', 404, '服务不存在');
    await writeAudit({
      action: 'user.service.update',
      resource: 'user',
      resourceId: id,
      meta: {
        serviceId,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      ...audit,
    });
    return { service: toAdminService(updated) };
  }

  async deleteService(id: string, serviceId: string, audit: UserAdminAudit) {
    const commerce = this.requireCommerce();
    const existing = await commerce.getService(id, serviceId);
    if (!existing) throw new PluginError('service.not_found', 404, '服务不存在');
    await commerce.deleteService(serviceId);
    await writeAudit({
      action: 'user.service.delete',
      resource: 'user',
      resourceId: id,
      meta: { serviceId, productName: existing.productName },
      ...audit,
    });
  }

  /** 已注册的上游「已购服务」数据源（未安装上游插件时为空）。 */
  private upstreamSources(): UpstreamServiceSource[] {
    return this.deps.upstreamServiceSources ?? [];
  }

  /**
   * 实时聚合各上游已购服务，并标注每条在本平台的绑定归属。
   *
   * 上游服务若已绑定到**本账号**，`boundServiceId` 有值；若绑定到其它账号，
   * 则 `boundUserId` 有值（前端据此禁用选择）。
   */
  async listUpstreamServices(id: string) {
    const sources = this.upstreamSources();
    if (sources.length === 0) {
      return { sources: [], services: [] };
    }
    const commerce = this.commerce;
    const boundByProvider = new Map<string, CommerceService[]>();
    for (const source of sources) {
      if (commerce) {
        boundByProvider.set(source.id, await commerce.listBoundServices(source.id));
      }
    }
    const services = [];
    for (const source of sources) {
      const items = await source.list({ limit: 100 }).catch(() => []);
      const bound = new Map(
        (boundByProvider.get(source.id) ?? [])
          .filter((service) => service.providerServiceId)
          .map((service) => [service.providerServiceId as string, service]),
      );
      for (const item of items) {
        services.push(this.toAdminUpstreamService(source.id, item, bound.get(item.id), id));
      }
    }
    return {
      sources: sources.map((source) => ({ id: source.id, name: source.name })),
      services,
    };
  }

  private toAdminUpstreamService(
    sourceId: string,
    item: UpstreamServiceItem,
    bound: CommerceService | undefined,
    targetUserId: string,
  ) {
    const mine = bound?.userId === targetUserId;
    return {
      id: item.id,
      name: item.name,
      productName: item.productName ?? null,
      status: item.status ?? null,
      statusLabel: item.statusLabel ?? null,
      host: item.host ?? null,
      expiresAt: item.expiresAt ?? null,
      amount: item.amount ?? null,
      currency: item.currency ?? null,
      sourceId,
      boundServiceId: mine && bound ? bound.id : null,
      boundUserId: bound && !mine ? bound.userId : null,
    };
  }

  /**
   * 把某个上游已购服务绑定为 `id` 账号的交付物。
   *
   * 不调用上游 `provision`（服务已存在），只落一条本地交付物并写入
   * `providerId` / `providerServiceId` / `runtime.upstreamId`，此后详情、
   * 监控与生命周期动作仍从上游实时读取。
   */
  async bindUpstreamService(
    id: string,
    input: { sourceId: string; providerServiceId: string },
    audit: UserAdminAudit,
  ) {
    const source = this.upstreamSources().find((candidate) => candidate.id === input.sourceId);
    if (!source) throw new PluginError('upstream.not_found', 404, '上游不存在或未启用');
    const commerce = this.requireCommerce();
    const items = await source.list({ limit: 200 });
    const item = items.find((candidate) => candidate.id === input.providerServiceId);
    if (!item) throw new PluginError('upstream.service_not_found', 404, '上游服务不存在');

    let created: CommerceService;
    try {
      created = await commerce.bindService({
        userId: id,
        productId: item.id,
        productName: item.productName ?? item.name,
        fulfillmentType: 'upstream_service',
        providerId: source.id,
        providerServiceId: item.id,
        status: item.status ?? 'ACTIVE',
        amount: item.amount ?? 0,
        currency: item.currency ?? 'CNY',
        expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
        runtime: { upstreamId: item.sourceRef ?? null, host: item.host ?? null },
      });
    } catch (error) {
      if (isCommerceError(error) && error.failure === 'service_already_bound') {
        throw new PluginError('service.already_bound', 409, error.message);
      }
      throw error;
    }
    await writeAudit({
      action: 'user.service.bind',
      resource: 'user',
      resourceId: id,
      meta: {
        sourceId: source.id,
        providerServiceId: item.id,
        productName: item.productName ?? item.name,
        serviceId: created.id,
      },
      ...audit,
    });
    const services = await commerce.listServices(id);
    return { services: services.map(toAdminService), created: [created.id] };
  }

  /** 解除绑定：仅删除本地交付物，不影响上游已购服务本身。 */
  async unbindUpstreamService(id: string, serviceId: string, audit: UserAdminAudit) {
    const commerce = this.requireCommerce();
    const existing = await commerce.getService(id, serviceId);
    if (!existing) throw new PluginError('service.not_found', 404, '服务不存在');
    await commerce.deleteService(serviceId);
    await writeAudit({
      action: 'user.service.unbind',
      resource: 'user',
      resourceId: id,
      meta: {
        serviceId,
        providerId: existing.providerId,
        providerServiceId: existing.providerServiceId,
        productName: existing.productName,
      },
      ...audit,
    });
  }
}
