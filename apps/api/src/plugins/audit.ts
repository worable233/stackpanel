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
}

/** Normalize the User-Agent header value for audit storage. */
export function headerUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 191) : undefined;
}

/**
 * Derive request-derived audit fields (actor/IP/user-agent) with optional
 * properties omitted when absent, so callers stay exactOptionalPropertyTypes-safe.
 */
export function auditContext(
  request: FastifyRequest,
): Pick<AuditInput, 'actorId' | 'ip' | 'userAgent'> {
  const ua = headerUserAgent(request);
  return {
    ip: request.ip,
    ...(request.user?.id ? { actorId: request.user.id } : {}),
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
  if (input.meta !== undefined) data.meta = input.meta;
  if (input.ip !== undefined) data.ip = input.ip;
  if (input.userAgent !== undefined) data.userAgent = input.userAgent;
  await prisma.auditLog.create({ data });
}
