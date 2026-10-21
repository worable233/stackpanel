/**
 * Kernel-owned authentication & authorization contract.
 *
 * Security boundary: user data, password hashes and session signing all live
 * on the platform (kernel). The login plugin implements the login/registration
 * pages and flows, and calls `ctx.auth` capabilities to verify credentials and
 * issue sessions. Swapping or uninstalling the login plugin therefore never
 * loses user data or credentials.
 *
 * Authorization is permission-group based: a user's effective permissions are
 * the union of all their groups' permissions.
 */

/** A permission group (role). */
export interface PermissionGroup {
  id: string;
  name: string;
  description: string | null;
  /** 代理折扣（%），0–99；null/缺省表示无折扣。 */
  discount?: number | null;
  /**
   * 该成员关系的到期时间（ISO 8601），`null`/缺省表示永久。
   *
   * 只出现在 {@link AuthService.listUserGroupGrants} 的返回里；`listUserGroups`
   * 已经过滤掉过期成员，不会返回带过去时间的组。
   */
  expiresAt?: string | null;
}

/**
 * 一条权限组成员关系（含到期时间），供会员类插件核对/展示自己授予的权益。
 *
 * 与 {@link PermissionGroup} 的区别：这是「关系」视角，能区分永久（`expiresAt`
 * 为 null）与限时成员，也不会隐藏已过期但尚未被清扫掉的行。
 */
export interface UserGroupGrant {
  userId: string;
  groupId: string;
  groupName: string;
  /** 到期时间（ISO 8601）；null = 永久。 */
  expiresAt: string | null;
  /** 该关系是否已过期（`expiresAt` 非空且不晚于当前时间）。 */
  expired: boolean;
}

/** 授予权限组的选项。 */
export interface GrantUserGroupInput {
  userId: string;
  groupId: string;
  /**
   * 到期时间。`null`/缺省 = 永久授予。已过去的时刻会被拒绝（避免写入即过期、
   * 让调用方误以为授予成功）。
   */
  expiresAt?: Date | string | null;
}

/** Authenticated user surface exposed to plugins and the frontend. */
export interface AuthUser {
  id: string;
  email: string;
  /** 'ACTIVE' | 'DISABLED' */
  status: string;
  /** Legacy role label derived from admin-group membership. */
  role: 'ADMIN' | 'USER';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /**
   * When email ownership was verified, or `null`. `null` does not mean
   * "unverified by policy" — it also covers accounts created before the flag
   * existed and password-less third-party identities.
   */
  emailVerifiedAt?: string | null;
}

/** Result of a login attempt. */
export interface SessionResult {
  token: string;
  user: AuthUser;
}

/** Audit entry metadata the login plugin can emit via the kernel. */
export interface AuthAuditInput {
  action: string;
  resource?: string;
  resourceId?: string;
  /** Acting user id (attribution). Omit for system/background actions. */
  actorId?: string;
  /** JSON-serializable metadata (Prisma InputJsonValue-compatible). */
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/** One append-only audit row as read back through {@link AuthService.listAuditLogs}. */
export interface AuthAuditEntry {
  id: string;
  /** The acting user id, or null for system/kernel actions. */
  actorId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Caller-provided metadata (JSON), or null. */
  meta: unknown;
  createdAt: string;
}

/** Paged audit query. `action`, `resourceId` and `since` narrow the append-only log. */
export interface AuthAuditQuery {
  action?: string;
  resourceId?: string;
  /** Only entries created at/after this ISO-8601 timestamp. */
  since?: string;
  page: number;
  /** 1–100. */
  pageSize: number;
}

/** One page of audit rows (newest first) plus the total matching count. */
export interface AuthAuditPage {
  logs: AuthAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Find-or-create an id-less platform identity anchored by email. */
export interface EnsureSystemUserInput {
  /** Stable, unique email that identifies the account (case-insensitive). */
  email: string;
  /** Group to attach on creation (defaults to the platform's standard user group). */
  groupId?: string;
}

/** Input to register a new local user. */
export interface RegisterUserInput {
  email: string;
  password: string;
  /**
   * Mark the email as verified at creation. Set only after the caller has
   * proven ownership out-of-band (e.g. consumed a register verification code);
   * defaults to unverified.
   */
  emailVerified?: boolean;
}

/** Session cookie parameters the login plugin needs to set the cookie. */
export interface SessionCookieConfig {
  name: string;
  maxAge: number;
  secure: boolean;
}

/**
 * A platform API token as seen through `ctx.auth` (never the key hash).
 *
 * Platform tokens are a kernel identity capability (`ApiToken`): the kernel
 * owns issuance, storage and lookup. A gateway plugin that wants its own
 * per-token policy keeps it in its Extension models, keyed by `id`.
 */
export interface PlatformTokenView {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

/** Ownership + raw scopes of a resolved platform token. */
export interface ResolvedPlatformToken {
  tokenId: string;
  userId: string;
  scopes: string[];
}

/**
 * Raw inspection of a platform token by plaintext, without collapsing the
 * denial reason. Gateway-style plugins need to tell `invalid` / `expired` /
 * `ip_not_allowed` apart for their own error contract; they still must not see
 * the key hash. `active` is false when the token is not `ACTIVE`.
 */
export interface PlatformTokenInspection {
  token: PlatformTokenView;
  active: boolean;
  expired: boolean;
  ipAllowed: boolean;
}

/** Result of minting a platform token; `plaintext` is returned exactly once. */
export interface CreatedPlatformToken {
  plaintext: string;
  token: PlatformTokenView;
}

/** Input to mint a platform token. Scopes must be a subset of the owner's. */
export interface CreatePlatformTokenInput {
  userId: string;
  name: string;
  scopes: string[];
  expiresAt?: Date | null;
}

/**
 * Kernel authentication capabilities exposed to plugins via `ctx.auth`.
 * The login plugin uses these; it never holds the signing key.
 */
export interface AuthService {
  /** Verify a password for a user by email; returns the user id or null. */
  verifyPassword(email: string, password: string): Promise<AuthUser | null>;
  /** Register a new local user. First user becomes an `admin` (see bootstrap). */
  registerUser(input: RegisterUserInput): Promise<AuthUser>;
  /**
   * Resolve or lazily create a password-less platform identity anchored by a
   * stable email. Lets a plugin that models an external principal (e.g. a
   * channel partner) obtain the `ownerId` it needs for orders/services without
   * holding raw DB access. Idempotent and race-safe (re-reads on conflict).
   */
  ensureSystemUser(input: EnsureSystemUserInput): Promise<AuthUser>;
  /** Create a server-side session for `userId` and return its opaque token. */
  issueSession(userId: string): Promise<string>;
  /** Revoke one session immediately (logout). No-op for unknown tokens. */
  revokeSession(token: string): Promise<void>;
  /** Revoke every session of a user (password change / ban). */
  revokeAllSessions(userId: string): Promise<void>;
  /** Session cookie parameters (name/ttl/secure) for the login plugin. */
  sessionCookieConfig(): SessionCookieConfig;
  /** Whether a user has a permission (union of their groups' permissions). */
  hasPermission(userId: string, permission: string): Promise<boolean>;
  /** List a user's permission groups. */
  listUserGroups(userId: string): Promise<PermissionGroup[]>;
  /** 列出全部权限组（不限用户），供商品类型配置选择「授予哪个组」。 */
  listPermissionGroups(): Promise<PermissionGroup[]>;
  /**
   * 授予权限组成员关系。幂等：已存在时按新 `expiresAt` 覆盖（续费延长即走这里）。
   * 到期时间在过去时拒绝（抛错），避免写入即过期。
   */
  grantUserGroup(input: GrantUserGroupInput): Promise<UserGroupGrant>;
  /**
   * 撤销权限组成员关系。幂等：不存在时静默返回 `false`。
   *
   * 只应按「自己授予的」关系调用；永久成员（`expiresAt` 为 null）通常是管理员
   * 手工配置或默认组，调用方必须先读 {@link listUserGroupGrants} 确认。
   */
  revokeUserGroup(userId: string, groupId: string): Promise<boolean>;
  /** 读取某用户的全部成员关系（含到期与过期状态，不做过滤）。 */
  listUserGroupGrants(userId: string): Promise<UserGroupGrant[]>;
  /**
   * 清扫已过期的成员关系：删除 `expiresAt <= now` 的行并返回被删除的关系。
   *
   * 过期判定本身已在读路径生效，因此本方法只做数据清理与通知触发点，不承担
   * 授权正确性。`limit` 有上限，便于集群任务分批处理。
   */
  pruneExpiredUserGroups(
    limit?: number,
  ): Promise<Array<{ userId: string; groupId: string; groupName: string }>>;
  /** Read a full user record by id (used by the login plugin's /auth/me). */
  getUser(userId: string): Promise<AuthUser | null>;
  /** Read a full user record by email (case-insensitive), or null. */
  getUserByEmail(email: string): Promise<AuthUser | null>;
  /** Read several users by id in one call; missing ids are omitted. */
  listUsersByIds(userIds: string[]): Promise<AuthUser[]>;
  /**
   * Resolve a platform API token (plaintext) to its owner and declared scopes.
   * Returns null for unknown/disabled/expired/IP-blocked tokens. Used by gateway
   * plugins that authenticate their own raw endpoints with a platform token.
   */
  resolvePlatformToken(
    plaintext: string,
    clientIp?: string,
  ): Promise<ResolvedPlatformToken | null>;
  /**
   * Inspect a platform token by plaintext without collapsing the denial reason
   * (used by gateway plugins to emit precise `invalid`/`expired`/`ip` codes).
   * Returns null only when no token matches. Never exposes the key hash.
   */
  inspectPlatformToken(
    plaintext: string,
    clientIp?: string,
  ): Promise<PlatformTokenInspection | null>;
  /** List a user's platform API tokens (newest first), never the key hash. */
  listPlatformTokens(userId: string): Promise<PlatformTokenView[]>;
  /** List every platform API token (admin oversight), newest first. */
  listAllPlatformTokens(): Promise<PlatformTokenView[]>;
  /** List all platform tokens whose `scopes` include `scope`. */
  listPlatformTokensByScope(scope: string): Promise<PlatformTokenView[]>;
  /**
   * Mint a platform token for `userId`. Scopes are intersected with the owner's
   * current permissions (illegal scopes are dropped), matching the kernel's
   * self-service surface. `plaintext` is returned exactly once.
   */
  createPlatformToken(input: CreatePlatformTokenInput): Promise<CreatedPlatformToken>;
  /** Update a platform token's user-editable fields (`name`/`status`/`expiresAt`). */
  updatePlatformToken(
    tokenId: string,
    patch: { name?: string; status?: string; expiresAt?: Date | null },
  ): Promise<PlatformTokenView>;
  /** Whether `userId` owns `tokenId`. */
  ownsPlatformToken(tokenId: string, userId: string): Promise<boolean>;
  /** Revoke a platform token by id (no-op when absent). */
  deletePlatformToken(tokenId: string): Promise<void>;
  /** Emit a kernel-owned audit entry (login success/failure etc.). */
  audit(input: AuthAuditInput): Promise<void>;
  /**
   * Read the append-only audit log (newest first, paged). Lets a plugin project
   * the provenance of its own authenticated calls without raw DB access; the
   * log stays kernel-owned.
   */
  listAuditLogs(query: AuthAuditQuery): Promise<AuthAuditPage>;
}
