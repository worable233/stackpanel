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
