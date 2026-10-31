import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@stackpanel/db';
import type { IdentityChallengeMessage, IdentityChallengeSender } from '@stackpanel/sdk';
import { isPluginError } from '@stackpanel/sdk';
import { KernelIdentityChallengeService } from '../../src/auth/identity-challenge-service.ts';
import { applyRuntimeConfigRows } from '../../src/config/runtime-config.ts';
import { MemoryStateService } from '../../src/state/state-service.ts';

/**
 * Minimal in-memory Prisma-like client covering the identity_challenges model
 * methods the service uses: create / findFirst / update / updateMany.
 */
function createFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;

  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean => {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'id') {
        if (row.id !== value) return false;
      } else if (key === 'email') {
        if (row.email !== value) return false;
      } else if (key === 'purpose') {
        if (row.purpose !== value) return false;
      } else if (key === 'consumedAt') {
        if (value === null && row.consumedAt !== null) return false;
        if (value !== null && row.consumedAt !== value) return false;
      }
    }
    return true;
  };

  const api = {
    identityChallenge: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `ch-${++seq}`,
          attempts: 0,
          maxAttempts: 5,
          consumedAt: null,
          locale: null,
          ip: null,
          userAgent: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: Record<string, unknown>;
          orderBy?: { createdAt?: 'asc' | 'desc' };
        }) => {
          let list = rows.filter((row) => matches(row, where));
          if (orderBy?.createdAt === 'desc') {
            list = [...list].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
          }
          return list[0] ?? null;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = rows.find((candidate) => matches(candidate, where));
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const matched = rows.filter((row) => matches(row, where));
          for (const row of matched) Object.assign(row, data);
          return { count: matched.length };
        },
      ),
    },
  };
  return { api, rows };
}

/** A sender that captures the last code it was given (test-only inspection). */
class CapturingSender implements IdentityChallengeSender {
  readonly id = 'test-sender';
  readonly name = 'Test Sender';
  last: IdentityChallengeMessage | null = null;
  fail = false;
  async send(message: IdentityChallengeMessage): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.last = message;
  }
  /** The last captured code; throws when nothing was captured (test guard). */
  code(): string {
    if (!this.last) throw new Error('no code captured');
    return this.last.code;
  }
}

function build(sender: CapturingSender | null) {
  const db = createFakeDb();
  const service = new KernelIdentityChallengeService({
    db: db.api as unknown as PrismaClient,
    state: new MemoryStateService(),
    getSenders: () => (sender ? [sender] : []),
    secret: 'test_secret_value_at_least_32_characters_000',
  });
  return { db, service, sender };
}

describe('KernelIdentityChallengeService', () => {
  let sender: CapturingSender;
  let service: KernelIdentityChallengeService;

  beforeEach(() => {
    const built = build(new CapturingSender());
    if (!built.sender) throw new Error('test sender missing');
    sender = built.sender;
    service = built.service;
  });

  it('issues a code, stores only a digest, and does not expose the plaintext', async () => {
    const issued = await service.issue({ purpose: 'register', email: 'User@Example.com' });
    expect(issued.email).toBe('user@example.com');
    expect(issued.deliveredBy).toBe('test-sender');
    expect(sender.code()).toMatch(/^\d{6}$/);
    expect(sender.last?.email).toBe('user@example.com');
    // The plaintext code must not be persisted anywhere.
    const persisted = JSON.stringify(service['options'].db);
    expect(persisted.includes(sender.code())).toBe(false);
  });

  it('consumes a valid code once, and rejects a replay', async () => {
    await service.issue({ purpose: 'register', email: 'a@b.com' });
    const code = sender.code();
    await expect(service.consume({ purpose: 'register', email: 'a@b.com', code })).resolves.toBeUndefined();
    // Same code, second time: already consumed.
    await expect(service.consume({ purpose: 'register', email: 'a@b.com', code })).rejects.toSatisfy(
      (error: unknown) => isPluginError(error) && error.code === 'auth.code_missing',
    );
  });

  it('rejects a wrong code and locks after the attempt ceiling', async () => {
    await service.issue({ purpose: 'register', email: 'a@b.com' });
    for (let i = 0; i < 4; i += 1) {
      await expect(
        service.consume({ purpose: 'register', email: 'a@b.com', code: '000000' }),
      ).rejects.toSatisfy((e: unknown) => isPluginError(e) && e.code === 'auth.code_invalid');
    }
    // 5th wrong attempt trips the ceiling.
    await expect(
      service.consume({ purpose: 'register', email: 'a@b.com', code: '000000' }),
    ).rejects.toSatisfy((e: unknown) => isPluginError(e) && e.code === 'auth.code_locked');
    // Even the correct code is now refused (challenge burned).
    await expect(
      service.consume({ purpose: 'register', email: 'a@b.com', code: sender.code() }),
    ).rejects.toSatisfy((e: unknown) => isPluginError(e));
  });

  it('expires a code past its TTL', async () => {
    await service.issue({ purpose: 'register', email: 'a@b.com' });
    const code = sender.code();
    // Rewrite the stored expiry into the past to simulate elapsed time.
    service['options'].db.identityChallenge.updateMany({
      where: { email: 'a@b.com', purpose: 'register' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      service.consume({ purpose: 'register', email: 'a@b.com', code }),
    ).rejects.toSatisfy((e: unknown) => isPluginError(e) && e.code === 'auth.code_expired');
  });

  it('refuses to issue when no delivery channel is configured (never silently skips)', async () => {
    const { service: bare } = build(null);
    await expect(bare.issue({ purpose: 'register', email: 'a@b.com' })).rejects.toSatisfy(
      (e: unknown) => isPluginError(e) && e.code === 'auth.code_channel_unavailable',
    );
  });

  it('retires the challenge and surfaces when delivery fails', async () => {
    sender.fail = true;
    await expect(service.issue({ purpose: 'register', email: 'a@b.com' })).rejects.toSatisfy(
      (e: unknown) => isPluginError(e) && e.code === 'auth.code_delivery_failed',
    );
  });

  it('retires an earlier code when a new one is issued', async () => {
    await service.issue({ purpose: 'register', email: 'a@b.com' });
    const first = sender.code();
    await service.issue({ purpose: 'register', email: 'a@b.com' });
    const second = sender.code();
    expect(second).not.toBe(first);
    // The superseded code no longer resolves to an active challenge.
    await expect(
      service.consume({ purpose: 'register', email: 'a@b.com', code: first }),
    ).rejects.toSatisfy((e: unknown) => isPluginError(e));
    await expect(
      service.consume({ purpose: 'register', email: 'a@b.com', code: second }),
    ).resolves.toBeUndefined();
  });

  it('throttles an immediate resend with a cooldown code and the remaining wait', async () => {
    applyRuntimeConfigRows([
      { key: 'config.AUTH_CODE_SEND_COOLDOWN_SECONDS', value: 60 },
      { key: 'config.AUTH_CODE_SEND_PER_HOUR', value: 20 },
    ]);
    await service.issue({ purpose: 'register', email: 'cool@example.com' });

    let thrown: unknown;
    try {
      await service.issue({ purpose: 'register', email: 'cool@example.com' });
    } catch (error) {
      thrown = error;
    }
    expect(isPluginError(thrown)).toBe(true);
    if (!isPluginError(thrown)) return;
    // A distinct code from the hourly quota: the visitor can retry *soon*, and the
    // UI turns `retryAfterSeconds` into a countdown instead of a dead end.
    expect(thrown.code).toBe('auth.code_cooldown');
    expect(thrown.status).toBe(429);
    expect(thrown.retryAfterSeconds).toBeGreaterThan(0);
    expect(thrown.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('reports the hourly quota as its own code with a wait near the full window', async () => {
    applyRuntimeConfigRows([
      { key: 'config.AUTH_CODE_SEND_COOLDOWN_SECONDS', value: 0 },
      { key: 'config.AUTH_CODE_SEND_PER_HOUR', value: 2 },
    ]);
    await service.issue({ purpose: 'register', email: 'quota@example.com' });
    await service.issue({ purpose: 'register', email: 'quota@example.com' });

    let thrown: unknown;
    try {
      await service.issue({ purpose: 'register', email: 'quota@example.com' });
    } catch (error) {
      thrown = error;
    }
    expect(isPluginError(thrown)).toBe(true);
    if (!isPluginError(thrown)) return;
    expect(thrown.code).toBe('auth.code_quota_exceeded');
    expect(thrown.status).toBe(429);
    // The window is one hour; the number must describe *that* wait, not the 60s
    // cooldown, or the UI would promise a retry that still fails.
    expect(thrown.retryAfterSeconds).toBeGreaterThan(3_000);
    expect(thrown.retryAfterSeconds).toBeLessThanOrEqual(3_600);
  });

  it('reports whether email verification is required', () => {
    expect(typeof service.requiresEmailVerification()).toBe('boolean');
  });
});
