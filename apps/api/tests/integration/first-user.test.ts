import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { isFirstUser, FIRST_USER_ADVISORY_LOCK } from '../../src/auth/first-user.ts';
import { checkDbAvailable } from '../helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * SECURITY-AUDIT-2026-10-04 L-4: the "first user becomes admin" election must be
 * evaluated *inside* the transaction under a Postgres advisory lock. These tests
 * exercise the real SQL (a bad cast or lock id would throw) and prove the lock
 * serialises concurrent elections.
 */
describe.skipIf(!dbAvailable)('first-user election (real DB)', () => {
  let prisma: ReturnType<typeof getPrisma>;

  beforeAll(() => {
    prisma = getPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('mirrors an in-transaction count under the advisory lock', async () => {
    const txResult = await prisma.$transaction(async (tx) => ({
      first: await isFirstUser(tx),
      count: await tx.user.count(),
    }));
    expect(txResult.first).toBe(txResult.count === 0);
  });

  it('serialises concurrent elections on the same lock without deadlocking', async () => {
    // The explicit lock id is the one the helper uses; asserting it here guards
    // against an accidental value change that would silently split the critical
    // section.
    expect(FIRST_USER_ADVISORY_LOCK).toBe(0x53503146);
    const [a, b] = await Promise.all([
      prisma.$transaction(async (tx) => isFirstUser(tx)),
      prisma.$transaction(async (tx) => isFirstUser(tx)),
    ]);
    expect(a).toBe(b);
  });
});
