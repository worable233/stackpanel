import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PluginError } from '@stackpanel/sdk';
import { env } from '../config/env.ts';
import { resolveCookieSecure } from '../lib/cookie-security.ts';
import { looksLikeApiToken, resolveApiToken } from '../lib/api-tokens.ts';
import { verifySession } from '../lib/jwt.ts';
import { getSessionStore } from '../auth/session-store.ts';
import { scopeSatisfied } from '../lib/capability-registry.ts';
import { auditContext, writeAudit } from './audit.ts';
import { getPrisma } from './prisma.ts';

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
 */
async function apiTokenUser(token: string, clientIp?: string): Promise<AuthUser | null> {
  if (!looksLikeApiToken(token)) return null;
  const cacheKey = rejectedKey(token, clientIp);
  if (rejectedTokens.has(cacheKey)) return null;
  const resolved = await resolveApiToken(getPrisma(), token, clientIp).catch(() => null);
  if (!resolved) {
    rejectedTokens.add(cacheKey);
    return null;
  }
  const userId = resolved.userId;
  const tokenId = resolved.tokenId;
  const scopes = resolved.scopes;
  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') return null;
  const owned = await permissionsOf(user.id);
  const effective = new Set(scopes.filter((scope) => owned.has(scope)));
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    permissions: effective,
    viaApiToken: true,
    ...(tokenId ? { tokenId } : {}),
    tokenScopes: scopes,
    // Refined scopes the owner still holds (coarse keys pass through as-is).
    // Delegation for refined scopes must go through canGrantScope at issuance.
    effectiveScopes: scopes.filter((scope) => scopeSatisfied(scope, owned)),
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
    // Second guard on top of the env default (SECURITY-AUDIT-2026-10-04 M-1).
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
  // Platform API tokens (default `sp_` prefix, legacy `sk-sp-`) are checked first.
  const viaToken = await apiTokenUser(token, request.ip);
  if (viaToken) return viaToken;

  const prisma = getPrisma();
  const buildUser = async (userId: string): Promise<AuthUser | null> => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') return null;
    const permissions = await permissionsOf(user.id);
    return { id: user.id, email: user.email, status: user.status, permissions };
  };

  // 1. Server-side session (the normal path).
  const session = await getSessionStore().get(token);
  if (session) {
    const user = await buildUser(session.userId);
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
    const allowed = user
      ? user.viaApiToken
        ? (user.effectiveScopes ?? []).includes(scope)
        : scopeSatisfied(scope, user.permissions)
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
