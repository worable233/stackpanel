import type { Prisma } from '@stackpanel/db';

/**
 * "First user becomes admin" bootstrap election (security audit L-4).
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

/**
 * Take the shared first-user advisory lock for the current transaction. Every
 * path that may elect the first administrator must call this before reading the
 * installation state, so all of them serialize on the same critical section.
 * Released automatically at transaction end.
 */
export async function lockFirstUser(tx: Prisma.TransactionClient): Promise<void> {
  // Cast the `void` result so Prisma's driver adapter can deserialize it.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${FIRST_USER_ADVISORY_LOCK}::bigint)::text AS lock`;
}

export async function isFirstUser(tx: Prisma.TransactionClient): Promise<boolean> {
  // `pg_advisory_xact_lock` blocks until the lock is free and is released at
  // transaction end — giving a read-committed-safe "check then insert" window.
  await lockFirstUser(tx);
  const count = await tx.user.count();
  return count === 0;
}

/**
 * Whether the instance already has an administrator. This is the authoritative
 * "has this instance been claimed?" signal for the setup wizard: plugins may
 * create password-less `group_user` system accounts (e.g. `ensureSystemUser`)
 * before an operator ever visits `/setup`, so `user.count() === 0` would wrongly
 * report an unclaimed instance. Must be called under the first-user advisory
 * lock when its result gates a write (see {@link isFirstUser}).
 */
export async function hasAdmin(tx: Prisma.TransactionClient): Promise<boolean> {
  const count = await tx.userGroup.count({ where: { groupId: 'group_admin' } });
  return count > 0;
}
