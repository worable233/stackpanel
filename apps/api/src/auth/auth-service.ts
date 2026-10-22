import type { PrismaClient } from '@stackpanel/db';
import type {
  AuthService,
  AuthUser,
  AuthAuditInput,
  AuthAuditEntry,
  AuthAuditPage,
  AuthAuditQuery,
  CreatedPlatformToken,
  CreatePlatformTokenInput,
  EnsureSystemUserInput,
  GrantUserGroupInput,
  PermissionGroup,
  PlatformTokenView,
  PlatformTokenInspection,
  RegisterUserInput,
  ResolvedPlatformToken,
  SessionCookieConfig,
  UserGroupGrant,
} from '@stackpanel/sdk';
import {
  generateApiToken,
  hashApiToken,
  ipAllowed,
  resolveApiToken as resolveKernelApiToken,
  toStringArray,
} from '../lib/api-tokens.ts';
import { env } from '../config/env.ts';
import { resolveCookieSecure } from '../lib/cookie-security.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { toPublicUser } from '../lib/user.ts';
import { permissionsOf } from '../plugins/auth.ts';
import { getSessionStore } from './session-store.ts';
import { isFirstUser } from './first-user.ts';
import { firstAdminElectionGuarded, SetupRequiredError } from './install-claim.ts';
import { writeAudit } from '../plugins/audit.ts';
import { activeMembershipWhere, isMembershipActive } from './membership.ts';

export interface AuthServiceOptions {
  db: PrismaClient;
}

/**
 * Kernel-internal auth surface: the plugin-facing {@link AuthService} plus
 * operations only the kernel's own routes may perform. Keeping impersonation
 * off `AuthService` means plugin code cannot type-call it (plugins already hold
 * a reference to this object, so this is a contract-level, not a security,
 * boundary — but it keeps the plugin API honest).
 */
export interface KernelAuth extends AuthService {
  /** Mint a session presenting as `targetUserId`, attributed to `impersonatorId`. */
  issueImpersonationSession(targetUserId: string, impersonatorId: string): Promise<string>;
}

/**
 * A fixed, valid scrypt hash of a throwaway string. `verifyPassword` runs it
 * when the account does not exist / has no local password so that the timing
 * profile of a successful vs failed lookup stays constant (no user enumeration
 * via response time).
 */
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$uxer+U1A8ZQG+x4X9DgLOg==$ep5qBatRhuRrtsAR7NiNkpZ/lrUN/dzt1e3GqSR+ZXhWX5PiEZAk8i/OqPwoRTChLvlX+8r6+WQlIeDGiiP1NQ==';

/** Kernel-owned auth service. Owns user data, password hashing, session signing
 * and permission-group resolution. The login plugin calls these capabilities
 * and never holds the signing key.
 */
export class KernelAuthService implements AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  async verifyPassword(email: string, password: string): Promise<AuthUser | null> {
    const user = await this.options.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.status !== 'ACTIVE' || !user.passwordHash) {
      // Equalize timing with the real verification path.
      await verifyPassword(password, DUMMY_PASSWORD_HASH).catch(() => false);
      return null;
    }
    const ok = await verifyPassword(password, user.passwordHash).catch(() => false);
    if (!ok) return null;
    return this.toAuthUser(user);
  }

  async registerUser(input: RegisterUserInput): Promise<AuthUser> {
    const email = input.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('邮箱格式无效');
    }
    if (typeof input.password !== 'string' || input.password.length < 8) {
      throw new Error('密码至少需要 8 位');
    }
    const exists = await this.options.db.user.findUnique({ where: { email } });
    if (exists) throw new Error('邮箱已被使用');
    // Hash outside the transaction: scrypt is deliberately slow and would
    // otherwise be computed while holding the first-user advisory lock.
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await this.options.db.$transaction(async (tx) => {
        // Elect the first admin *inside* the transaction under an advisory lock
        // so concurrent registrations cannot both win (security audit L-4).
        const isFirst = await isFirstUser(tx);
        // Hardened mode: the first admin may only be created via the setup
        // wizard. Refuse rather than silently granting admin, so the claim
        // token cannot be bypassed by self-service signup.
        if (isFirst && firstAdminElectionGuarded()) throw new SetupRequiredError();
        const created = await tx.user.create({
          data: {
            email,
            passwordHash,
            status: 'ACTIVE',
            emailVerifiedAt: input.emailVerified ? new Date() : null,
            groups: {
              create: { groupId: isFirst ? 'group_admin' : 'group_user' },
            },
          },
        });
        return created;
      });
      return this.toAuthUser(user);
    } catch (err) {
      // Unique email races with a concurrent registration resolve to a clean error.
      if ((err as { code?: string }).code === 'P2002') {
        throw new Error('邮箱已被使用', { cause: err });
      }
      throw err;
    }
  }

  async issueSession(userId: string): Promise<string> {
    const user = await this.options.db.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw new Error('账号不可用');
    await this.options.db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return getSessionStore().create(user.id);
  }

  /**
   * Resolve or lazily create a password-less identity anchored by a stable
   * email. Used by plugins that model an external principal (e.g. a channel
   * partner) but must not hold raw DB access. Race-safe: a losing concurrent
   * insert re-reads the winner.
   */
  async ensureSystemUser(input: EnsureSystemUserInput): Promise<AuthUser> {
    const email = input.email.toLowerCase();
    const existing = await this.options.db.user.findUnique({ where: { email } });
    if (existing) return this.toAuthUser(existing);
    try {
      const created = await this.options.db.user.create({
        data: {
          email,
          groups: { create: [{ groupId: input.groupId ?? 'group_user' }] },
        },
      });
      return this.toAuthUser(created);
    } catch (err) {
      // Lost the creation race: re-read the winner instead of failing.
      const again = await this.options.db.user.findUnique({ where: { email } });
      if (again) return this.toAuthUser(again);
      throw err;
    }
  }

  /**
   * Mint a session that presents as `targetUserId` but is attributed to the
   * administrator `impersonatorId` (audit AZ-4). Deliberately *not* exposed on
   * the plugin-facing {@link AuthService} contract: only the kernel's admin
   * surface may create impersonation sessions, so a plugin can never forge one.
   */
  async issueImpersonationSession(targetUserId: string, impersonatorId: string): Promise<string> {
    const target = await this.options.db.user.findUnique({ where: { id: targetUserId } });
    if (!target || target.status !== 'ACTIVE') throw new Error('账号不可用');
    return getSessionStore().create(target.id, { impersonatorId });
  }

  async revokeSession(token: string): Promise<void> {
    await getSessionStore().revoke(token);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await getSessionStore().revokeAll(userId);
  }

  sessionCookieConfig(): SessionCookieConfig {
    return {
      name: env.SESSION_COOKIE_NAME,
      maxAge: env.SESSION_TTL_SECONDS,
      // Second guard on top of the env default (security audit M-1).
      secure: resolveCookieSecure(env.API_COOKIE_SECURE),
    };
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const count = await this.options.db.userGroup.count({
      where: {
        userId,
        // 过期会员不再授予任何权限（读路径判定，不依赖清扫任务）。
        AND: [activeMembershipWhere()],
        group: {
          permissions: { some: { permission: { key: permission } } },
        },
      },
    });
    return count > 0;
  }

  async listUserGroups(userId: string): Promise<PermissionGroup[]> {
    const rows = await this.options.db.userGroup.findMany({
      where: { userId, AND: [activeMembershipWhere()] },
      include: { group: true },
    });
    return rows.map((row) => ({
      id: row.group.id,
      name: row.group.name,
      description: row.group.description,
      discount: row.group.discount ?? null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    }));
  }

  async listPermissionGroups(): Promise<PermissionGroup[]> {
    const rows = await this.options.db.permissionGroup.findMany({
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      discount: row.discount ?? null,
    }));
  }

  async grantUserGroup(input: GrantUserGroupInput): Promise<UserGroupGrant> {
    const group = await this.options.db.permissionGroup.findUnique({
      where: { id: input.groupId },
    });
    if (!group) {
      throw new Error(`权限组不存在：${input.groupId}`);
    }
    const raw = input.expiresAt ?? null;
    const expiresAt = raw === null ? null : raw instanceof Date ? raw : new Date(raw);
    if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
      throw new Error(`到期时间无效：${String(raw)}`);
    }
    if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
      throw new Error(`到期时间必须晚于当前时间：${expiresAt.toISOString()}`);
    }
    const existing = await this.options.db.userGroup.findUnique({
      where: { userId_groupId: { userId: input.userId, groupId: input.groupId } },
    });
    // 永久成员不得被一次限时授予降级：管理员手工给的永久成员是更高的权益，
    // 会员商品开通/续费不该顺手把它改成会到期——那是一次静默降权。
    // 反向（限时 → 续期/永久）允许：续费就是靠这个更新延长 `expiresAt`。
    const row =
      existing && existing.expiresAt === null && expiresAt !== null
        ? existing
        : await this.options.db.userGroup.upsert({
            where: { userId_groupId: { userId: input.userId, groupId: input.groupId } },
            create: { userId: input.userId, groupId: input.groupId, expiresAt },
            update: { expiresAt },
          });
    return {
      userId: row.userId,
      groupId: row.groupId,
      groupName: group.name,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      expired: !isMembershipActive(row.expiresAt),
    };
  }

  async revokeUserGroup(userId: string, groupId: string): Promise<boolean> {
    const result = await this.options.db.userGroup.deleteMany({ where: { userId, groupId } });
    return result.count > 0;
  }

  async listUserGroupGrants(userId: string): Promise<UserGroupGrant[]> {
    const rows = await this.options.db.userGroup.findMany({
      where: { userId },
      include: { group: true },
      orderBy: { groupId: 'asc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      groupId: row.groupId,
      groupName: row.group.name,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      expired: !isMembershipActive(row.expiresAt),
    }));
  }

  async pruneExpiredUserGroups(
    limit = 200,
  ): Promise<Array<{ userId: string; groupId: string; groupName: string }>> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 1000);
    const rows = await this.options.db.userGroup.findMany({
      where: { expiresAt: { lte: new Date() } },
      include: { group: { select: { name: true } } },
      orderBy: { expiresAt: 'asc' },
      take: bounded,
    });
    if (rows.length === 0) return [];
    const removed = await this.options.db.userGroup.deleteMany({
      where: {
        OR: rows.map((row) => ({ userId: row.userId, groupId: row.groupId })),
      },
    });
    // 只回报确实被本次删除的行（并发清扫可能已处理掉一部分）。
    return removed.count === 0
      ? []
      : rows.map((row) => ({
          userId: row.userId,
          groupId: row.groupId,
          groupName: row.group.name,
        }));
  }

  async getUser(userId: string): Promise<AuthUser | null> {
    const user = await this.options.db.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    return this.toAuthUser(user);
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    const user = await this.options.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return null;
    return this.toAuthUser(user);
  }

  async listUsersByIds(userIds: string[]): Promise<AuthUser[]> {
    if (userIds.length === 0) return [];
    const users = await this.options.db.user.findMany({ where: { id: { in: userIds } } });
    return Promise.all(users.map((user) => this.toAuthUser(user)));
  }

  async resolvePlatformToken(
    plaintext: string,
    clientIp?: string,
  ): Promise<ResolvedPlatformToken | null> {
    const resolved = await resolveKernelApiToken(this.options.db, plaintext, clientIp);
    if (!resolved) return null;
    return { tokenId: resolved.tokenId, userId: resolved.userId, scopes: resolved.scopes };
  }

  async inspectPlatformToken(
    plaintext: string,
    clientIp?: string,
  ): Promise<PlatformTokenInspection | null> {
    const token = await this.options.db.apiToken.findUnique({
      where: { keyHash: hashApiToken(plaintext) },
    });
    if (!token) return null;
    const expired = token.expiresAt ? token.expiresAt.getTime() <= Date.now() : false;
    return {
      token: toPlatformTokenView(token),
      active: token.status === 'ACTIVE',
      expired,
      ipAllowed: ipAllowed(token.ipAllowlist, clientIp),
    };
  }

  async listPlatformTokens(userId: string): Promise<PlatformTokenView[]> {
    const rows = await this.options.db.apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPlatformTokenView);
  }

  async listAllPlatformTokens(): Promise<PlatformTokenView[]> {
    const rows = await this.options.db.apiToken.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toPlatformTokenView);
  }

  async listPlatformTokensByScope(scope: string): Promise<PlatformTokenView[]> {
    const rows = await this.options.db.apiToken.findMany({ orderBy: { createdAt: 'desc' } });
    return rows
      .filter((row) => toStringArray(row.scopes).includes(scope))
      .map(toPlatformTokenView);
  }

  async createPlatformToken(input: CreatePlatformTokenInput): Promise<CreatedPlatformToken> {
    const owned = await permissionsOf(input.userId);
    // Grant only what the owner holds — a plugin can never widen a user's scopes.
    const scopes = input.scopes.filter((scope) => owned.has(scope));
    const generated = generateApiToken();
    const row = await this.options.db.apiToken.create({
      data: {
        userId: input.userId,
        name: input.name,
        keyPrefix: generated.keyPrefix,
        keyHash: generated.keyHash,
        scopes,
        ipAllowlist: [],
        expiresAt: input.expiresAt ?? null,
      },
    });
    return { plaintext: generated.plaintext, token: toPlatformTokenView(row) };
  }

  async updatePlatformToken(
    tokenId: string,
    patch: { name?: string; status?: string; expiresAt?: Date | null },
  ): Promise<PlatformTokenView> {
    const row = await this.options.db.apiToken.update({
      where: { id: tokenId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      },
    });
    return toPlatformTokenView(row);
  }

  async ownsPlatformToken(tokenId: string, userId: string): Promise<boolean> {
    const count = await this.options.db.apiToken.count({ where: { id: tokenId, userId } });
    return count > 0;
  }

  async deletePlatformToken(tokenId: string): Promise<void> {
    await this.options.db.apiToken.deleteMany({ where: { id: tokenId } });
  }

  async audit(input: AuthAuditInput): Promise<void> {
    await writeAudit({
      action: input.action,
      resource: input.resource ?? 'auth',
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.meta ? { meta: input.meta as never } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    });
  }

  async listAuditLogs(query: AuthAuditQuery): Promise<AuthAuditPage> {
    const pageSize = Math.max(1, Math.min(query.pageSize, 100));
    const page = Math.max(1, query.page);
    const where = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.since ? { createdAt: { gte: new Date(query.since) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.options.db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.options.db.auditLog.count({ where }),
    ]);
    const logs: AuthAuditEntry[] = rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      ip: row.ip,
      userAgent: row.userAgent,
      meta: row.meta,
      createdAt: row.createdAt.toISOString(),
    }));
    return { logs, total, page, pageSize };
  }

  private async toAuthUser(user: {
    id: string;
    email: string;
    status: string;
    createdAt?: Date;
    updatedAt?: Date;
    lastLoginAt?: Date | null;
    emailVerifiedAt?: Date | null;
  }): Promise<AuthUser> {
    const isAdmin =
      (await this.options.db.userGroup.count({
        where: { userId: user.id, groupId: 'group_admin', AND: [activeMembershipWhere()] },
      })) > 0;
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      role: isAdmin ? 'ADMIN' : 'USER',
      createdAt: (user.createdAt ?? new Date()).toISOString(),
      updatedAt: (user.updatedAt ?? new Date()).toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    };
  }

  /** Seed platform-owned permissions and grant them to the admin group. */
  async seedPlatformPermissions(): Promise<void> {
    // Kernel-owned permissions carry a display name and an optional explanation
    // used by the admin permission picker. Plugins declare theirs in the manifest.
    const platformPermissions: Array<{ key: string; name: string; description?: string }> = [
      {
        key: 'platform.admin',
        name: '平台管理员',
        description: '平台最高权限：可管理用户、权限组、权限、插件与系统设置。',
      },
      {
        key: 'platform.manage.users',
        name: '管理用户',
        description: '查看、创建、禁用用户并重置其密码。',
      },
      {
        key: 'platform.manage.groups',
        name: '管理权限组',
        description: '创建、修改、删除权限组并调整成员归属。',
      },
      {
        key: 'platform.manage.permissions',
        name: '管理权限',
        description: '查看全部权限并把权限授予权限组。',
      },
      {
        key: 'platform.manage.plugins',
        name: '管理插件',
        description: '安装、启用、停用、升级与卸载插件。',
      },
      {
        key: 'platform.manage.settings',
        name: '管理站点设置',
        description: '修改站点名称、对外信息与系统级配置。',
      },
    ];
    for (const { key, name, description } of platformPermissions) {
      const permission = await this.options.db.permission.upsert({
        where: { key },
        create: { key, name, description: description ?? null },
        update: { name, description: description ?? null },
      });
      await this.options.db.groupPermission.upsert({
        where: {
          groupId_permissionId: { groupId: 'group_admin', permissionId: permission.id },
        },
        create: { groupId: 'group_admin', permissionId: permission.id },
        update: {},
      });
    }
  }
}

export { toPublicUser };

/** Map an ApiToken row to its plugin-facing view (never the key hash). */
function toPlatformTokenView(row: {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: unknown;
  status: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
}): PlatformTokenView {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: toStringArray(row.scopes),
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    lastUsedIp: row.lastUsedIp,
    createdAt: row.createdAt.toISOString(),
  };
}
