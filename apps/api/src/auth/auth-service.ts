import type { PrismaClient } from '@stackpanel/db';
import type {
  AuthService,
  AuthUser,
  AuthAuditInput,
  CreatedPlatformToken,
  CreatePlatformTokenInput,
  PermissionGroup,
  PlatformTokenView,
  PlatformTokenInspection,
  RegisterUserInput,
  ResolvedPlatformToken,
  SessionCookieConfig,
} from '@stackpanel/sdk';
import {
  generateApiToken,
  hashApiToken,
  ipAllowed,
  resolveApiToken as resolveKernelApiToken,
  toStringArray,
} from '../lib/api-tokens.ts';
import { env } from '../config/env.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { toPublicUser } from '../lib/user.ts';
import { permissionsOf } from '../plugins/auth.ts';
import { getSessionStore } from './session-store.ts';
import { writeAudit } from '../plugins/audit.ts';

export interface AuthServiceOptions {
  db: PrismaClient;
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
    const isFirst = (await this.options.db.user.count()) === 0;
    try {
      const user = await this.options.db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            passwordHash: await hashPassword(input.password),
            status: 'ACTIVE',
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
      secure: env.API_COOKIE_SECURE,
    };
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const count = await this.options.db.userGroup.count({
      where: {
        userId,
        group: {
          permissions: { some: { permission: { key: permission } } },
        },
      },
    });
    return count > 0;
  }

  async listUserGroups(userId: string): Promise<PermissionGroup[]> {
    const rows = await this.options.db.userGroup.findMany({
      where: { userId },
      include: { group: true },
    });
    return rows.map((row) => ({
      id: row.group.id,
      name: row.group.name,
      description: row.group.description,
      discount: row.group.discount ?? null,
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
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.meta ? { meta: input.meta as never } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
    });
  }

  private async toAuthUser(user: {
    id: string;
    email: string;
    status: string;
    createdAt?: Date;
    updatedAt?: Date;
    lastLoginAt?: Date | null;
  }): Promise<AuthUser> {
    const isAdmin =
      (await this.options.db.userGroup.count({
        where: { userId: user.id, groupId: 'group_admin' },
      })) > 0;
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      role: isAdmin ? 'ADMIN' : 'USER',
      createdAt: (user.createdAt ?? new Date()).toISOString(),
      updatedAt: (user.updatedAt ?? new Date()).toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    };
  }

  /** Seed platform-owned permissions and grant them to the admin group. */
  async seedPlatformPermissions(): Promise<void> {
    const platformPermissions = [
      'platform.admin',
      'platform.manage.users',
      'platform.manage.groups',
      'platform.manage.permissions',
      'platform.manage.plugins',
      'platform.manage.settings',
    ];
    for (const key of platformPermissions) {
      const permission = await this.options.db.permission.upsert({
        where: { key },
        create: { key, name: key },
        update: {},
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
