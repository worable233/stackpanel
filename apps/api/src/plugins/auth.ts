import { validMcpDispatch } from '../agent/dispatch-proof.ts';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PluginError } from '@stackpanel/sdk';
import { env } from '../config/env.ts';
import { resolveCookieSecure } from '../lib/cookie-security.ts';
import { looksLikeApiToken, resolveApiTokenWithOwner } from '../lib/api-tokens.ts';
import { verifySession } from '../lib/jwt.ts';
import { getSessionStore } from '../auth/session-store.ts';
import { scopeSatisfied, type ScopeGovernance } from '../lib/capability-registry.ts';
import type { FastifyInstance } from 'fastify';
import { auditContext, writeAudit } from './audit.ts';
import { getPrisma } from './prisma.ts';

/**
 * Runtime-aggregated refined-scope governance for this request (ADR-0021).
 * Returns `undefined` when the request has no runtime (isolated unit callers),
 * letting `scopeSatisfied` fall back to the kernel baseline — fail-closed.
 */
function requestScopeGovernance(request: FastifyRequest): ScopeGovernance | undefined {
  const server = request.server as FastifyInstance | undefined;
  return server?.pluginRuntime?.scopeGovernance();
}

export interface AuthUser {
  id: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  /** Effective permission keys = union of the user's groups' permissions. */
  permissions: Set<string>;
  /** True when the session was established via a platform API token. */
  viaApiToken?: boolean;
  /** The resolved API token id, when authenticated via token. */
  tokenId?: string;
  /** Scopes declared on the API token (before intersecting with permissions). */
  tokenScopes?: string[];
  /**
   * When set, this session presents as the user but was established by an
   * administrator impersonating them (audit AZ-4). The value is the real
   * administrator's user id; audit entries are attributed to it.
   */
  impersonatorId?: string;
  /**
   * For token callers: the declared scopes the owner still holds, at the
   * refined `资源:read|write` granularity. Used to enforce refinement so a read
   * token cannot perform writes even when both map to one coarse permission.
   */
  effectiveScopes?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    /** Opaque session token presented on this request (set by {@link extractSession}). */
    sessionToken?: string;
  }
}

/** Load a user's effective permission set (union of their groups' permissions). */
export async function permissionsOf(userId: string): Promise<Set<string>> {
  const rows = await getPrisma().userGroup.findMany({
    where: { userId },
    select: { group: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
  });
  const set = new Set<string>();
  for (const row of rows) {
    for (const gp of row.group.permissions) {
      set.add(gp.permission.key);
    }
  }
  return set;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return undefined;
}

/**
 * A small, bounded TTL cache of API tokens that failed to resolve.
 *
 * Positive resolutions are deliberately NOT cached: a token's status, expiry
 * and IP allowlist must be authoritative on every request (audit M-1), and the
 * owner's permission set is already re-read per request below. Caching only
 * "definitely invalid" credentials absorbs repeated bad tokens without growing
 * without bound (audit M-2). The key is a hash so plaintext credentials are
 * never retained in memory.
 */
class RejectedTokenCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  has(key: string): boolean {
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires <= Date.now()) {
      this.entries.delete(key);
      return false;
    }
    // Refresh recency so the entry survives as the most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, expires);
    return true;
  }

  add(key: string): void {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, Date.now() + this.ttlMs);
  }
}

const rejectedTokens = new RejectedTokenCache(1_000, 10_000);

function rejectedKey(token: string, clientIp: string | undefined): string {
  return createHash('sha256')
    .update(`${clientIp ?? ''}\u0000${token}`)
    .digest('hex');
}

/**
 * Resolve a platform API token to its owner with an intersected permission set.
 *
 * Effective permissions = token.scopes ∩ user's current permissions, so a
 * demotion of the owner immediately narrows every token they issued. Distinct
 * from the JWT session path, which grants the owner's full permission set.
 *
 * This runs on the hot path of every token-authenticated request (the LLM
 * gateway relays through here), so it uses `resolveApiTokenWithOwner`, which
 * fetches the token, its owner and the owner's whole permission set in **one**
 * nested query instead of three sequential ones. The M-1 invariant is intact:
 * status/expiry/IP allowlist are still judged per request on freshly read rows.
 */
async function apiTokenUser(
  token: string,
  clientIp?: string,
  governance?: ScopeGovernance,
  request?: FastifyRequest,
): Promise<AuthUser | null> {
  if (!looksLikeApiToken(token)) return null;
  const cacheKey = rejectedKey(token, clientIp);
  if (rejectedTokens.has(cacheKey)) return null;
  const resolved = await resolveApiTokenWithOwner(getPrisma(), token, clientIp).catch(() => null);
  if (!resolved) {
    rejectedTokens.add(cacheKey);
    return null;
  }
  if (resolved.audience === 'mcp' && (!request || (request.url.split('?')[0] !== '/mcp' && !validMcpDispatch(request)))) return null;
  const { owner, scopes } = resolved;
  if (owner.status !== 'ACTIVE') return null;
  const owned = owner.permissions;
  const effective = new Set(scopes.filter((scope) => owned.has(scope)));
  return {
    id: owner.id,
    email: owner.email,
    status: owner.status,
    permissions: effective,
    viaApiToken: true,
    ...(resolved.tokenId ? { tokenId: resolved.tokenId } : {}),
    tokenScopes: scopes,
    // Refined scopes the owner still holds (coarse keys pass through as-is).
    // Delegation for refined scopes must go through canGrantScope at issuance.
    effectiveScopes: scopes.filter((scope) => scopeSatisfied(scope, owned, governance)),
  };
}

/** A JWT from the pre-S3 stateless era (three base64url segments). */
function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/** Deterministic store key used to adopt a legacy JWT as a server session. */
function legacySessionId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Second guard on top of the env default (security audit M-1).
    secure: resolveCookieSecure(env.API_COOKIE_SECURE),
    path: '/',
    maxAge: env.SESSION_TTL_SECONDS,
  });
}

/**
 * Resolve the authenticated user from a platform API token, a server-side
 * session, or a legacy JWT (compatibility window).
 *
 * When `reply` is supplied, a legacy JWT presented via cookie is smoothly
 * migrated: a server-side session is created and the cookie is re-issued with
 * the opaque token. Without a reply the legacy JWT is adopted under a
 * deterministic session id so repeated requests reuse one session.
 */
export async function extractSession(
  request: FastifyRequest,
  reply?: FastifyReply,
): Promise<AuthUser | null> {
  const bearer = bearerToken(request);
  const cookie = request.cookies?.[env.SESSION_COOKIE_NAME];
  const token = bearer ?? cookie;
  if (!token) return null;
  const governance = requestScopeGovernance(request);
  // Platform API tokens (default `sp_` prefix, legacy `sk-sp-`) are checked first.
  const viaToken = await apiTokenUser(token, request.ip, governance, request);
  if (viaToken) return viaToken;

  const prisma = getPrisma();
  const buildUser = async (userId: string, impersonatorId?: string): Promise<AuthUser | null> => {
    // One nested read instead of `user.findUnique` + `permissionsOf`: the
    // session path also sits on every cookie-authenticated request, and the two
    // facts always come from the same user row.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
        groups: {
          select: {
            group: {
              select: { permissions: { select: { permission: { select: { key: true } } } } },
            },
          },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE') return null;
    const permissions = new Set<string>();
    for (const row of user.groups) {
      for (const gp of row.group.permissions) permissions.add(gp.permission.key);
    }
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      permissions,
      ...(impersonatorId ? { impersonatorId } : {}),
    };
  };

  // 1. Server-side session (the normal path).
  const session = await getSessionStore().get(token);
  if (session) {
    const user = await buildUser(session.userId, session.impersonatorId);
    if (!user) {
      // User disappeared or was disabled: drop the dangling session.
      await getSessionStore().revoke(token);
      return null;
    }
    request.sessionToken = token;
    return user;
  }

  // 2. Legacy stateless JWT: migrate it into the session store.
  if (!looksLikeJwt(token)) return null;
  try {
    const claims = await verifySession(token);
    const user = await buildUser(claims.sub);
    if (!user) return null;
    const store = getSessionStore();
    const fromCookie = !bearer && typeof cookie === 'string';
    if (fromCookie && reply) {
      const fresh = await store.create(user.id);
      setSessionCookie(reply, fresh);
      request.sessionToken = fresh;
    } else {
      const id = legacySessionId(token);
      await store.adopt(id, user.id);
      request.sessionToken = id;
    }
    return user;
  } catch {
    return null;
  }
}

/**
 * The authenticated user for a guarded route. `requireAuth` guarantees presence;
 * this throws instead of using a non-null assertion so the invariant is explicit.
 * Uses `PluginError` so the failure maps to the standard RFC 7807 response.
 */
export function currentUser(request: FastifyRequest): AuthUser {
  const user = request.user;
  if (!user) throw new PluginError('auth.unauthenticated', 401, '未登录或会话已过期');
  return user;
}

/** PreHandler: reject unauthenticated requests with 401. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await extractSession(request, reply);
  if (!user) {
    await reply.code(401).send({ error: '未登录或会话已过期' });
    return;
  }
  request.user = user;
}

/** PreHandler factory: reject requests lacking a permission with 403. */
export function requirePermission(permission: string) {
  return async function permissionGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.user || !request.user.permissions.has(permission)) {
      await writeAudit({
        action: 'auth.forbidden',
        resource: 'permission',
        meta: { method: request.method, path: request.url, requiredPermission: permission },
        ...auditContext(request),
      });
      await reply.code(403).send({ error: '没有权限执行此操作' });
    }
  };
}

/**
 * PreHandler factory for refined `资源:read|write` open-API scopes (P1 slice
 * four).
 *
 * The refined scope is the admission gate. A *token* caller must carry this
 * exact scope (its {@link AuthUser.effectiveScopes} already encode that the
 * owner still holds the coarse permission governing the resource, so a demoted
 * owner loses access). A *session* caller is a human acting with their full
 * permission set and is admitted when their permissions satisfy the scope's
 * coarse resource gate. A coarse-only token therefore cannot perform a refined
 * operation — that is the point of the refinement.
 */
export function requireOpenScope(scope: string) {
  return async function openScopeGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.user;
    const governance = requestScopeGovernance(request);
    const allowed = user
      ? user.viaApiToken
        ? (user.effectiveScopes ?? []).includes(scope)
        : scopeSatisfied(scope, user.permissions, governance)
      : false;
    if (allowed) return;
    await writeAudit({
      action: 'auth.forbidden',
      resource: 'permission',
      meta: {
        method: request.method,
        path: request.url,
        requiredScope: scope,
        ...(user?.viaApiToken ? { via: 'api_token' } : {}),
      },
      ...auditContext(request),
    });
    await reply.code(403).send({ error: '没有权限执行此操作' });
  };
}

/**
 * Backward-compatible role guard. The platform has no hardcoded role enum;
 * `ADMIN` maps to the `platform.admin` permission (granted to the `admin`
 * group), `USER` maps to no additional permission (any authenticated user).
 * Kept so existing admin route call sites stay unchanged.
 */
export function requireRole(...roles: readonly string[]) {
  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: '未登录或会话已过期' });
      return;
    }
    const required = roles
      .filter((role) => role !== 'USER')
      .map((role) => (role === 'ADMIN' ? 'platform.admin' : role));
    const ok = required.every((permission) => user.permissions.has(permission));
    if (!ok) {
      await writeAudit({
        action: 'auth.forbidden',
        resource: 'permission',
        meta: { method: request.method, path: request.url, requiredRoles: [...roles] },
        ...auditContext(request),
      });
      await reply.code(403).send({ error: '没有权限执行此操作' });
    }
  };
}
