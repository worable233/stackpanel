import type { FastifyRequest } from 'fastify';
import type { Prisma } from '@stackpanel/db';
import { getPrisma } from './prisma.ts';

export interface AuditInput {
  actorId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  meta?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
  /**
   * The impersonated account when `actorId` is a real administrator acting
   * through an impersonation session (audit AZ-4). Folded into `meta` so the
   * attribution (admin) and the effective identity (user) are both recorded.
   */
  impersonatedUserId?: string;
}

/** Normalize the User-Agent header value for audit storage. */
export function headerUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 191) : undefined;
}

/**
 * Derive request-derived audit fields (actor/IP/user-agent) with optional
 * properties omitted when absent, so callers stay exactOptionalPropertyTypes-safe.
 *
 * When the request was authenticated by an impersonation session, `actorId` is
 * the *real* administrator (not the impersonated account) and the effective user
 * id is carried in `impersonatedUserId`, so an audit row never masquerades as a
 * normal action by the impersonated user.
 */
export function auditContext(
  request: FastifyRequest,
): Pick<AuditInput, 'actorId' | 'ip' | 'userAgent' | 'impersonatedUserId'> {
  const ua = headerUserAgent(request);
  const user = request.user;
  const impersonatorId = user?.impersonatorId;
  return {
    ip: request.ip,
    ...(impersonatorId
      ? { actorId: impersonatorId, impersonatedUserId: user?.id }
      : user?.id
        ? { actorId: user.id }
        : {}),
    ...(ua ? { userAgent: ua } : {}),
  };
}

/**
 * Append an audit entry. `audit_logs` is append-only: the application only
 * ever inserts, and a DB trigger rejects UPDATE/DELETE as a hard guarantee.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  const prisma = getPrisma();
  const data: Prisma.AuditLogUncheckedCreateInput = {
    action: input.action,
    resource: input.resource,
  };
  if (input.actorId !== undefined) data.actorId = input.actorId;
  if (input.resourceId !== undefined) data.resourceId = input.resourceId;
  const meta = mergeImpersonation(input);
  if (meta !== undefined) data.meta = meta;
  if (input.ip !== undefined) data.ip = input.ip;
  if (input.userAgent !== undefined) data.userAgent = input.userAgent;
  await prisma.auditLog.create({ data });
}

/**
 * Fold `impersonatedUserId` into the audit `meta`, keeping it authoritative over
 * any caller-provided key of the same name (attribution must not be spoofable).
 * Returns the original meta untouched when there is nothing to add, preserving
 * non-object meta values.
 */
function mergeImpersonation(input: AuditInput): Prisma.InputJsonValue | undefined {
  if (!input.impersonatedUserId) return input.meta;
  const base =
    input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta)
      ? (input.meta as Record<string, Prisma.InputJsonValue>)
      : {};
  return { ...base, impersonatedUserId: input.impersonatedUserId };
}
