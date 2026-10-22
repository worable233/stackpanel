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
import { Prisma, type PrismaClient } from '@stackpanel/db';
import { isCommerceError, isPluginError, PluginError } from '@stackpanel/sdk';
import type {
  CommerceOperations,
  CommerceOrder,
  CommerceService,
  NotificationsService,
  UpstreamServiceItem,
  UpstreamServiceSource,
  WalletService,
} from '@stackpanel/sdk';
import { generatePassword } from './generate.ts';
import { hashPassword } from './password.ts';
import { formatMinorCurrency } from '@stackpanel/sdk';
import { ADMIN_GROUP_ID, isLastAdmin, toPublicUser } from './user.ts';
import type { AuditInput } from '../plugins/audit.ts';
import { writeAudit } from '../plugins/audit.ts';
import { activeMembershipWhere } from '../auth/membership.ts';
import { notifyUserBestEffort, upsertUserBestEffort } from '../notifications/notify.ts';

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
  /**
   * Mint a session presenting as `targetUserId` but attributed to the
   * administrator `impersonatorId` (audit AZ-4).
   */
  issueImpersonationSession(targetUserId: string, impersonatorId: string): Promise<string>;
}

export interface UserAdminDeps {
  prisma: PrismaClient;
  wallet: WalletService;
  auth: UserAdminAuth;
  /** Commerce domain outlet (store plugin); absent when the plugin is inactive. */
  commerce?: CommerceOperations | null | undefined;
  /** Registered upstream service sources (upstream plugins); empty when none. */
  upstreamServiceSources?: UpstreamServiceSource[] | undefined;
  /**
   * 站内通知出口（best-effort）。管理员代用户执行的高影响动作（重置密码、停用
   * 账号、调整余额、赠送/变更服务）必须给当事人留回执，否则用户无从知晓。
   */
  notifications?: NotificationsService | undefined;
  logger?: { warn: (message: string) => void } | undefined;
}

export interface ListUsersInput {
  page: number;
  pageSize: number;
  q?: string | undefined;
  /** Filter by account status. */
  status?: 'ACTIVE' | 'DISABLED' | undefined;
  /** Filter to users that belong to this permission group. */
  groupId?: string | undefined;
  sort?:
    | 'createdAt_desc'
    | 'createdAt_asc'
    | 'balance_desc'
    | 'balance_asc'
    | 'lastLoginAt_desc'
    | 'lastLoginAt_asc'
    | undefined;
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
    if (!commerce) throw new PluginError('commerce.unavailable', 503, '商店能力暂不可用');
    return commerce;
  }

  /** 站内通知出口；未注入时（精简运行时/单测）静默跳过。 */
  private async notify(input: Parameters<typeof notifyUserBestEffort>[1]): Promise<void> {
    if (!this.deps.notifications) return;
    await notifyUserBestEffort(
      {
        notifications: this.deps.notifications,
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      },
      input,
    );
  }

  private async notifyUpsert(input: Parameters<typeof upsertUserBestEffort>[1]): Promise<void> {
    if (!this.deps.notifications) return;
    await upsertUserBestEffort(
      {
        notifications: this.deps.notifications,
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      },
      input,
    );
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
        AND: [activeMembershipWhere()],
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

  /**
   * Money and service fulfilment are platform-owned actions, not ordinary user
   * administration. `platform.manage.users` may administer accounts, but must
   * never be sufficient to create value or grant paid services.
   */
  private requirePlatformAdmin(actor: UserAdminActor): void {
    if (!actor.permissions.has(PLATFORM_ADMIN)) {
      throw new PluginError('user.admin_required', 403, '仅平台管理员可执行此操作');
    }
  }

  async listUsers(input: ListUsersInput) {
    const { page, pageSize, q, status, groupId, sort = 'createdAt_desc' } = input;
    const where = {
      ...(q ? { email: { contains: q.toLowerCase() } } : {}),
      ...(status ? { status } : {}),
      ...(groupId ? { groups: { some: { groupId } } } : {}),
    };
    const select = {
      id: true,
      email: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      lastLoginAt: true,
      groups: { include: { group: true } },
    } as const;
    const total = await this.db.user.count({ where });
    let users;
    if (sort === 'balance_desc' || sort === 'balance_asc') {
      // Sort the complete result before pagination, including users without a wallet.
      const filters = Prisma.sql`
        (${q || null}::text IS NULL OR strpos(u.email, ${q?.toLowerCase() || null}::text) > 0)
        AND (${status || null}::text IS NULL OR u.status::text = ${status || null}::text)
        AND (${groupId || null}::text IS NULL OR EXISTS (
          SELECT 1 FROM user_groups g WHERE g."userId" = u.id AND g."groupId" = ${groupId || null}::text
        ))`;
      const direction = sort === 'balance_asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
      const ids = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT u.id FROM users u
        LEFT JOIN wallet_accounts w ON w."userId" = u.id AND w.currency = 'CNY'
        WHERE ${filters}
        ORDER BY COALESCE(w.balance, 0) ${direction}, u.id ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `);
      const pageIds = ids.map((user) => user.id);
      const rows = await this.db.user.findMany({
        where: { id: { in: pageIds } },
        select,
      });
      const rowById = new Map(rows.map((user) => [user.id, user]));
      users = pageIds
        .map((id) => rowById.get(id))
        .filter((user): user is NonNullable<typeof user> => Boolean(user));
    } else {
      const [field, direction] = sort.split('_') as ['createdAt' | 'lastLoginAt', 'asc' | 'desc'];
      users = await this.db.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [
          field === 'lastLoginAt'
            ? { lastLoginAt: { sort: direction, nulls: 'last' } }
            : { createdAt: direction },
          { id: 'asc' },
        ],
        select,
      });
    }
    const userIds = users.map((user) => user.id);
    const accounts = await this.db.walletAccount.findMany({
      where: { userId: { in: userIds }, currency: 'CNY' },
      select: { userId: true, balance: true, currency: true },
    });
    const accountByUser = new Map(accounts.map((account) => [account.userId, account]));
    let serviceCounts: Record<string, number> = {};
    if (this.commerce?.countServicesByUsers && userIds.length > 0) {
      try {
        serviceCounts = await this.commerce.countServicesByUsers(userIds);
      } catch {
        // Missing or unavailable commerce statistics must not block user administration.
      }
    }
    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
        groups: user.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
        balance: accountByUser.get(user.id)?.balance ?? 0,
        balanceCurrency: accountByUser.get(user.id)?.currency ?? 'CNY',
        serviceCount: serviceCounts[user.id] ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async getUserDetail(id: string, orderPage = 1, orderPageSize = 20) {
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
    // The detail page paginates orders server-side; a fixed first page would
    // silently hide everything older than 20 records from admins.
    const page = Math.max(1, Math.trunc(orderPage));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(orderPageSize)));
    const orderPageResult = this.commerce
      ? await this.commerce.listOrders(id, page, pageSize)
      : { items: [] as CommerceOrder[], total: 0 };
    const orders: CommerceOrder[] = orderPageResult.items;
    return {
      user: {
        ...toPublicUser(user),
        groups: user.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
      },
      wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null,
      services: services.map(toAdminService),
      ordersPagination: { page, pageSize, total: orderPageResult.total },
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
        // 只增删差异，不整组重建：整组重建会把会员商品授予的限时成员
        // （`expiresAt`）悄悄改成永久成员——那是一次静默提权。
        const current = await tx.userGroup.findMany({
          where: { userId: id },
          select: { groupId: true },
        });
        const currentIds = new Set(current.map((row) => row.groupId));
        const nextIds = new Set(groupIds);
        const removed = [...currentIds].filter((groupId) => !nextIds.has(groupId));
        const added = groupIds.filter((groupId) => !currentIds.has(groupId));
        if (removed.length > 0) {
          await tx.userGroup.deleteMany({ where: { userId: id, groupId: { in: removed } } });
        }
        if (added.length > 0) {
          await tx.userGroup.createMany({
            data: added.map((groupId) => ({ userId: id, groupId })),
          });
        }
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
    // 停用会立即踢掉全部会话：必须给当事人一条可追溯的回执，否则「突然被登出」
    // 无从解释。恢复启用同样通知（让用户知道可以重新登录）。
    if (status === 'DISABLED') {
      await this.notifyUpsert({
        userId: id,
        dedupeKey: `security:account:${id}:disabled`,
        type: 'security.account.disabled',
        title: '账号已被停用',
        body: '你的账号已被管理员停用，当前会话已全部失效。如有疑问请联系站点管理员。',
        link: '/account',
        data: { status },
        status: 'error',
      });
    } else if (status === 'ACTIVE') {
      await this.notifyUpsert({
        userId: id,
        dedupeKey: `security:account:${id}:enabled`,
        type: 'security.account.enabled',
        title: '账号已恢复',
        body: '你的账号已恢复使用，可以重新登录。',
        link: '/account',
        data: { status },
        status: 'success',
      });
    }
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
    // 重置密码会撤销全部会话：用户必须知道「不是自己被踢」，并且知道要找管理员。
    await this.notifyUpsert({
      userId: id,
      dedupeKey: `security:password:${id}:reset`,
      type: 'security.password.reset',
      title: '密码已被重置',
      body: '你的登录密码已被管理员重置，所有已登录会话已失效。请使用新密码重新登录，如有疑问请联系站点管理员。',
      link: '/account',
      data: { resetAt: new Date().toISOString() },
      status: 'error',
    });
    return {
      user: toPublicUser(user),
      ...(password ? {} : { generatedPassword }),
    };
  }

  async adjustWallet(
    id: string,
    amount: number,
    note: string,
    actor: UserAdminActor,
  ) {
    this.requirePlatformAdmin(actor);
    await this.deps.wallet.adjust({
      userId: id,
      amount,
      currency: 'CNY',
      note,
      ...(actor.id ? { actorId: actor.id } : {}),
    });
    const account = await this.deps.wallet.getAccount(id);
    // 余额被管理员改动对用户是「钱」的事实，必须留回执。dedupeKey 含时间戳，
    // 因为同一用户可能被多次调整（每次都是独立的账务事实，不应互相覆盖）。
    if (amount !== 0) {
      await this.notify({
        userId: id,
        type: 'wallet.balance.adjusted',
        title: amount > 0 ? '余额已增加' : '余额已扣减',
        body: `管理员${amount > 0 ? '增加' : '扣减'}了你的钱包余额 ${formatMinorCurrency(Math.abs(amount), 'CNY', 'zh-CN')}${note ? `（备注：${note}）` : ''}。当前余额 ${formatMinorCurrency(account?.balance ?? 0, 'CNY', 'zh-CN')}。`,
        link: '/account/balance',
        data: { amount, currency: 'CNY', note, balance: account?.balance ?? 0 },
        status: 'info',
      });
    }
    return { balance: account?.balance ?? 0, currency: account?.currency ?? 'CNY' };
  }

  async impersonate(id: string, audit: UserAdminAudit, actor: UserAdminActor) {
    await this.assertAdminPrivilege(actor, id, undefined);
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user) throw new PluginError('user.not_found', 404, '用户不存在');
    if (user.status !== 'ACTIVE') {
      throw new PluginError('user.disabled', 400, '该账号已停用，无法进入');
    }
    // Only the caller's own, verified id may be recorded as the impersonator; a
    // missing actor id would silently produce an untraceable session, so refuse.
    if (!actor.id) throw new PluginError('auth.unauthenticated', 401, '未登录或会话已过期');
    const token = await this.deps.auth.issueImpersonationSession(id, actor.id);
    await writeAudit({
      action: 'user.impersonate',
      resource: 'user',
      resourceId: id,
      meta: { impersonatedEmail: user.email, impersonatedUserId: id },
      ...audit,
    });
    return { token };
  }

  async listServices(id: string) {
    const services = this.commerce ? await this.commerce.listServices(id) : [];
    return { services: services.map(toAdminService) };
  }

  async giftService(
    id: string,
    input: GiftServiceInput,
    audit: UserAdminAudit,
    actor: UserAdminActor,
  ) {
    this.requirePlatformAdmin(actor);
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
    // 赠送服务是「凭空多了一件商品」的事实，用户需要看到它出现在「我的服务」。
    await this.notify({
      userId: id,
      type: 'service.granted',
      title: '你收到一项新服务',
      body: `管理员已为你开通「${created[0]?.productName ?? '服务'}」${quantity > 1 ? ` ×${quantity}` : ''}。`,
      link: '/account/services',
      data: {
        productId,
        productName: created[0]?.productName ?? null,
        quantity,
        serviceIds: created.map((row) => row.id),
        ...(expiresAt ? { expiresAt } : {}),
      },
      status: 'success',
    });
    return { services: services.map(toAdminService), created: created.map((row) => row.id) };
  }

  async updateService(
    id: string,
    serviceId: string,
    input: UpdateServiceInput,
    audit: UserAdminAudit,
    actor: UserAdminActor,
  ) {
    this.requirePlatformAdmin(actor);
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
    // 管理员手动改状态/到期时间都会改变用户的可用性，必须通知当事人。
    // 状态与到期时间可能同时变，故用一条「服务已变更」通知概括，具体字段进 data。
    const changed: string[] = [];
    if (input.status !== undefined && input.status !== existing.status) {
      changed.push(`状态改为 ${input.status}`);
    }
    if (input.expiresAt !== undefined) {
      changed.push(input.expiresAt === null ? '到期时间已清除' : `到期时间改为 ${input.expiresAt}`);
    }
    if (changed.length > 0) {
      await this.notifyUpsert({
        userId: id,
        dedupeKey: `store:service:${serviceId}:admin-update`,
        type: 'service.updated',
        title: '服务信息已更新',
        body: `你的服务「${updated.productName}」${changed.join('，')}。`,
        link: `/account/services/${serviceId}`,
        data: {
          serviceId,
          productName: updated.productName,
          ...(input.status ? { status: input.status } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        },
        status: 'info',
      });
    }
    return { service: toAdminService(updated) };
  }

  async deleteService(
    id: string,
    serviceId: string,
    audit: UserAdminAudit,
    actor: UserAdminActor,
  ) {
    this.requirePlatformAdmin(actor);
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
    await this.notify({
      userId: id,
      type: 'service.removed',
      title: '服务已被移除',
      body: `管理员已移除你的服务「${existing.productName}」。如有疑问请联系站点管理员。`,
      link: '/account/services',
      data: { serviceId, productName: existing.productName },
      status: 'error',
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
      let items: UpstreamServiceItem[];
      try {
        items = await source.list();
      } catch (error) {
        // Never disguise an upstream failure as an empty list: the admin needs
        // the actionable reason (credentials, network, disabled upstream).
        if (isPluginError(error)) throw error;
        const status =
          typeof error === 'object' && error && 'status' in error
            ? Number((error as { status: unknown }).status)
            : 502;
        const code =
          typeof error === 'object' && error && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'upstream.list_failed';
        const detail = error instanceof Error ? error.message : '上游服务列表获取失败';
        throw new PluginError(
          code,
          Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
          detail,
        );
      }
      const bound = new Map(
        (boundByProvider.get(source.id) ?? [])
          .filter((service) => service.providerServiceId)
          .map((service) => [JSON.stringify([(service.runtime as { upstreamId?: string } | null)?.upstreamId ?? null, service.providerServiceId]), service]),
      );
      for (const item of items) {
        services.push(this.toAdminUpstreamService(source.id, item, bound.get(JSON.stringify([item.sourceRef ?? null, item.id])), id));
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
      sourceRef: item.sourceRef ?? null,
      productId: item.productId ?? null,
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
    input: { sourceId: string; providerServiceId: string; sourceRef?: string | undefined },
    audit: UserAdminAudit,
    actor: UserAdminActor,
  ) {
    this.requirePlatformAdmin(actor);
    const source = this.upstreamSources().find((candidate) => candidate.id === input.sourceId);
    if (!await this.deps.prisma.user.findUnique({ where: { id }, select: { id: true } })) throw new PluginError('user.not_found', 404, '用户不存在');
    if (!source) throw new PluginError('upstream.not_found', 404, '上游不存在或未启用');
    const commerce = this.requireCommerce();
    const items = await source.list();
    const matches = items.filter((candidate) => candidate.id === input.providerServiceId && (!input.sourceRef || candidate.sourceRef === input.sourceRef));
    if (matches.length > 1) throw new PluginError('upstream.ambiguous_service', 409, '多个上游账号存在相同实例编号，请指定上游账号');
    const item = matches[0];
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
        runtime: { upstreamId: item.sourceRef ?? null, upstreamProductId: item.productId ?? null, host: item.host ?? null, origin: 'upstream-import' },
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
  async unbindUpstreamService(
    id: string,
    serviceId: string,
    audit: UserAdminAudit,
    actor: UserAdminActor,
  ) {
    this.requirePlatformAdmin(actor);
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
