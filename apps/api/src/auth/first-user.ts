import type { Prisma } from '@stackpanel/db';

/**
 * "First user becomes admin" bootstrap election (SECURITY-AUDIT-2026-10-04 L-4).
 *
 * The old check (`count() === 0`) ran outside the write, so two concurrent
 * registrations on an empty instance could both observe zero users and both be
 * granted `group_admin`. This helper makes the decision atomic by taking a
 * Postgres transaction-scoped advisory lock before re-reading the count, so all
 * callers serialize on the same critical section and exactly one of them wins.
 *
 * The lock is released automatically when the surrounding transaction commits
 * or rolls back. PostgreSQL-only, matching ADR-0019.
 *
 * Must be called with the same transaction client that will create the user.
 */
export const FIRST_USER_ADVISORY_LOCK = 0x53503146; // 'SP1F'

export async function isFirstUser(tx: Prisma.TransactionClient): Promise<boolean> {
  // `pg_advisory_xact_lock` blocks until the lock is free and is released at
  // transaction end — giving a read-committed-safe "check then insert" window.
  // Cast the `void` result so Prisma's driver adapter can deserialize it.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${FIRST_USER_ADVISORY_LOCK}::bigint)::text AS lock`;
  const count = await tx.user.count();
  return count === 0;
}
