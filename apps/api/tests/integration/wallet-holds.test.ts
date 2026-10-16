import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalletService } from '../../src/wallet/wallet-service.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';

/**
 * Wallet pre-authorization (ADR-0022 P16).
 *
 * The point of a hold is that the admission decision happens **before** the
 * metered work: freezing moves the amount out of `balance`, so a concurrent
 * request sees the reduced balance and is rejected up front. The old
 * "check balance, then debit after use" flow let parallel requests share one
 * snapshot and produce write-offs, so these tests are mostly about races.
 */
const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('wallet holds (real DB)', () => {
  const prisma = getPrisma();
  const wallet = new WalletService({ db: prisma });
  const userId = `hold_test_${randomUUID()}`;
  const ref = (id: string) => ({
    type: 'llm_gateway_usage',
    referenceType: 'test_hold',
    referenceId: id,
  });

  beforeAll(async () => {
    await wallet.credit(userId, 1_000, 'CNY', {
      type: 'topup',
      referenceType: 'test_seed',
      referenceId: randomUUID(),
    });
  });

  afterAll(async () => {
    await prisma.walletHold.deleteMany({ where: { userId } });
    await prisma.walletLedgerEntry.deleteMany({ where: { userId } });
    await prisma.walletAccount.deleteMany({ where: { userId } });
  });

  it('freezes the amount out of the spendable balance', async () => {
    const before = await wallet.getAccount(userId);
    const hold = await wallet.hold(userId, 300, 'CNY', ref(randomUUID()));
    expect(hold.status).toBe('HELD');
    expect(hold.amount).toBe(300);
    const after = await wallet.getAccount(userId);
    expect(after?.balance).toBe((before?.balance ?? 0) - 300);
    expect(after?.held).toBe(300);
    await wallet.releaseHold(hold.id);
  });

  it('refuses to freeze more than the available balance', async () => {
    const account = await wallet.getAccount(userId);
    const tooMuch = (account?.balance ?? 0) + 1;
    await expect(wallet.hold(userId, tooMuch, 'CNY', ref(randomUUID()))).rejects.toThrow(
      '钱包余额不足',
    );
  });

  it('closes the concurrent-billing window: parallel holds cannot overdraw', async () => {
    // Balance is 1000; two requests each want 600. Under the old snapshot flow
    // both would pass a balance check and one would be written off.
    const results = await Promise.allSettled([
      wallet.hold(userId, 600, 'CNY', ref(randomUUID())),
      wallet.hold(userId, 600, 'CNY', ref(randomUUID())),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const account = await wallet.getAccount(userId);
    expect(account?.balance).toBe(400);
    expect(account?.held).toBe(600);
    const settled = ok[0];
    if (settled?.status === 'fulfilled') await wallet.releaseHold(settled.value.id);
  });

  it('is idempotent per reference: a retry never freezes twice', async () => {
    const id = randomUUID();
    const first = await wallet.hold(userId, 100, 'CNY', ref(id));
    const second = await wallet.hold(userId, 100, 'CNY', ref(id));
    expect(second.id).toBe(first.id);
    const account = await wallet.getAccount(userId);
    expect(account?.held).toBe(100);
    await wallet.releaseHold(first.id);
  });

  it('settles for the consumed amount and returns the remainder', async () => {
    const before = await wallet.getAccount(userId);
    const hold = await wallet.hold(userId, 200, 'CNY', ref(randomUUID()));
    const settled = await wallet.settleHold(hold.id, 50);
    expect(settled?.status).toBe('SETTLED');
    expect(settled?.settledAmount).toBe(50);
    const after = await wallet.getAccount(userId);
    // 200 frozen, 50 consumed → 150 comes back.
    expect(after?.balance).toBe((before?.balance ?? 0) - 50);
    expect(after?.held).toBe(0);
    // The ledger carries the charge under the caller's reference.
    const entries = await prisma.walletLedgerEntry.findMany({
      where: { userId, referenceId: hold.referenceId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(-50);
  });

  it('caps the settlement at the frozen amount and is idempotent', async () => {
    const hold = await wallet.hold(userId, 100, 'CNY', ref(randomUUID()));
    const first = await wallet.settleHold(hold.id, 999);
    expect(first?.settledAmount).toBe(100);
    const balanceAfterFirst = (await wallet.getAccount(userId))?.balance;
    const again = await wallet.settleHold(hold.id, 100);
    expect(again?.status).toBe('SETTLED');
    expect((await wallet.getAccount(userId))?.balance).toBe(balanceAfterFirst);
  });

  it('releases the full amount and never refunds twice', async () => {
    const before = await wallet.getAccount(userId);
    const hold = await wallet.hold(userId, 250, 'CNY', ref(randomUUID()));
    await wallet.releaseHold(hold.id);
    const after = await wallet.getAccount(userId);
    expect(after?.balance).toBe(before?.balance);
    expect(after?.held).toBe(0);
    await wallet.releaseHold(hold.id);
    expect((await wallet.getAccount(userId))?.balance).toBe(before?.balance);
  });

  it('returns expired holds to the balance', async () => {
    const before = await wallet.getAccount(userId);
    const hold = await wallet.hold(userId, 120, 'CNY', ref(randomUUID()));
    // Age the hold past its deadline instead of waiting for a real TTL.
    await prisma.walletHold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const released = await wallet.sweepExpiredHolds();
    expect(released).toBeGreaterThanOrEqual(1);
    const after = await wallet.getAccount(userId);
    expect(after?.balance).toBe(before?.balance);
    expect(after?.held).toBe(0);
    expect((await prisma.walletHold.findUnique({ where: { id: hold.id } }))?.status).toBe('EXPIRED');
  });

  it('refuses to settle when the frozen total drifted below the hold (B-2)', async () => {
    const hold = await wallet.hold(userId, 150, 'CNY', ref(randomUUID()));
    // Simulate drift: someone/something zeroed `held` behind the hold's back.
    await prisma.walletAccount.update({
      where: { userId_currency: { userId, currency: 'CNY' } },
      data: { held: 0 },
    });
    // The guard must refuse rather than drive `held` negative, and roll back.
    await expect(wallet.settleHold(hold.id, 150)).rejects.toThrow('钱包冻结额不一致');
    const account = await wallet.getAccount(userId);
    expect(account?.held).toBe(0);
    // The hold was not consumed by the failed settle.
    expect((await prisma.walletHold.findUnique({ where: { id: hold.id } }))?.status).toBe('HELD');
    // Restore consistency for the next test.
    await prisma.walletAccount.update({
      where: { userId_currency: { userId, currency: 'CNY' } },
      data: { held: 150 },
    });
    await wallet.releaseHold(hold.id);
  });
});
