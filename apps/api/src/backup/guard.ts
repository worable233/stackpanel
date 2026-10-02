/**
 * Maintenance write-guard (ADR-0018 §4).
 *
 * While an import runs the database is being replaced, so every mutating
 * request must be refused. This hook is registered app-wide by the kernel (one
 * line in `app.ts`); it lets the export/import control endpoints and the
 * health/readiness probes through so the operator can watch the import finish.
 *
 * The maintenance flag is read from the shared state, so the guard fires on
 * every API replica, not just the one that ran (or requested) the import.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildProblem } from '../lib/problem.ts';
import { isMaintenanceMode } from './service.ts';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Path prefixes that stay reachable during maintenance. */
const ALLOWED_PREFIXES = ['/admin/backup', '/health', '/ready', '/auth/session'];

export async function maintenanceWriteGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Cheap checks first: only mutating, non-allowlisted requests consult the
  // shared flag, so the hot read path never touches Redis.
  if (!WRITE_METHODS.has(request.method)) return;
  if (ALLOWED_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;
  const maintenance = await isMaintenanceMode();
  if (!maintenance) return;
  await reply
    .code(503)
    .header('retry-after', '60')
    .send(
      buildProblem({
        status: 503,
        code: 'backup.maintenance',
        detail: `实例正在导入数据，暂不接受写入：${maintenance.reason}`,
        instance: request.url,
        requestId: request.id,
      }),
    );
}
