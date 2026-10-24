import { describe, expect, it, vi } from 'vitest';
import type { CreateNotificationInput, NotificationsService, UpsertNotificationInput } from '@stackpanel/sdk';
import { notifyUserBestEffort, upsertUserBestEffort } from '../../src/notifications/notify.ts';

function fakeService(overrides: Partial<NotificationsService> = {}): {
  service: NotificationsService;
  create: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => ({}) as never);
  const upsert = vi.fn(async () => ({}) as never);
  return {
    service: { create, upsert, ...overrides } as unknown as NotificationsService,
    create,
    upsert,
  };
}

const input: CreateNotificationInput = {
  userId: 'user-1',
  type: 'wallet.topup.succeeded',
  title: '充值到账',
};

describe('best-effort notification helpers', () => {
  it('writes a one-shot notification', async () => {
    const { service, create } = fakeService();
    await expect(notifyUserBestEffort({ notifications: service }, input)).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith(input);
  });

  it('swallows write failures so the business path never rolls back', async () => {
    const warn = vi.fn();
    const { service } = fakeService({
      create: vi.fn(async () => {
        throw new Error('db down');
      }) as never,
    });
    await expect(
      notifyUserBestEffort({ notifications: service, logger: { warn } }, input),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wallet.topup.succeeded'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('upserts live notifications through the dedupe key', async () => {
    const { service, upsert } = fakeService();
    const live: UpsertNotificationInput = { ...input, dedupeKey: 'wallet:topup:1' };
    await expect(upsertUserBestEffort({ notifications: service }, live)).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith(live);
  });

  it('swallows upsert failures too', async () => {
    const { service } = fakeService({
      upsert: vi.fn(async () => {
        throw new Error('conflict');
      }) as never,
    });
    await expect(
      upsertUserBestEffort({ notifications: service }, { ...input, dedupeKey: 'k' }),
    ).resolves.toBe(false);
  });
});
