import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginContext } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import type { ChannelRepository, DeliveryRecord, PartnerRecord } from './repository';
import { processDueWebhooks } from './webhook';
import { bodyDigest, canonicalRequest, verifyCanonical } from './signing';

/**
 * Outbound webhook delivery mechanics (ADR-0021 §D4).
 *
 * `processDueWebhooks` takes an injected repository and fetch, so the
 * success/retry/backoff/failure state machine — and the exact bytes we sign —
 * are pinned here without a database or network. The HTTP/SSRF boundary
 * (`pinnedFetch` + `resolvePublicAddresses`) is covered by `webhook-pin.test.ts`;
 * the API integration suite exercises the plugin's real HTTP surface.
 */

const WEBHOOK_URL = 'https://93.184.216.34/sp-hook'; // public IP literal: no DNS needed

function partner(overrides: Partial<PartnerRecord> = {}): PartnerRecord {
  const now = new Date();
  return {
    id: 'res_1',
    name: 'partner-1',
    status: 'ACTIVE',
    keyId: 'sp_test',
    publicKey: 'unused-inbound',
    webhookPrivateKeyRef: null,
    webhookPublicKey: null,
    webhookUrl: WEBHOOK_URL,
    scopes: [],
    rateLimitRpm: 0,
    lastUsedAt: null,
    lastUsedIp: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function delivery(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const now = new Date();
  return {
    id: 'wh_1',
    partnerId: 'res_1',
    event: 'order.paid',
    url: WEBHOOK_URL,
    payload: { id: 'wh_1', event: 'order.paid', data: { orderId: 'o_1' } },
    status: 'PENDING',
    attempts: 0,
    maxAttempts: 3,
    responseCode: null,
    error: null,
    nextAttemptAt: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type Outcome =
  | { kind: 'delivered'; id: string; responseCode: number | null }
  | { kind: 'retry'; id: string; error: string; nextAttemptAt: Date }
  | { kind: 'failed'; id: string; error: string };

/** Minimal in-memory stand-in for the delivery half of {@link ChannelRepository}. */
class FakeRepo {
  readonly outcomes: Outcome[] = [];
  constructor(
    private readonly due: DeliveryRecord[],
    private readonly partners: Map<string, PartnerRecord>,
  ) {}

  async dueDeliveries(): Promise<DeliveryRecord[]> {
    return this.due;
  }

  async claimDelivery(): Promise<boolean> {
    return true;
  }

  async findById(id: string): Promise<PartnerRecord | null> {
    return this.partners.get(id) ?? null;
  }

  async markDelivered(id: string, responseCode: number | null): Promise<void> {
    this.outcomes.push({ kind: 'delivered', id, responseCode });
  }

  async markRetry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    this.outcomes.push({ kind: 'retry', id, error, nextAttemptAt });
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.outcomes.push({ kind: 'failed', id, error });
  }

  asRepository(): ChannelRepository {
    return this as unknown as ChannelRepository;
  }
}

/** Bind a fake secret store so the signing path is exercised end to end. */
function bindSecrets(entries: Map<string, string>): void {
  const secrets = {
    isAvailable: () => true,
    get: async (ref: string) => entries.get(ref) ?? null,
    set: async (ref: string, value: string) => {
      entries.set(ref, value);
    },
    remove: async (ref: string) => void entries.delete(ref),
  };
  bindContext({ secrets } as unknown as PluginContext);
}

afterEach(() => {
  resetContext();
});

describe('webhook delivery (processDueWebhooks)', () => {
  it('marks a delivery SUCCEEDED on a 2xx response', async () => {
    const repo = new FakeRepo([delivery()], new Map([['res_1', partner()]]));
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    const claimed = await processDueWebhooks(repo.asRepository(), fetchImpl);

    expect(claimed).toBe(1);
    expect(repo.outcomes).toEqual([{ kind: 'delivered', id: 'wh_1', responseCode: 200 }]);
  });

  it('retries with backoff on a non-2xx response while attempts remain', async () => {
    const repo = new FakeRepo(
      [delivery({ attempts: 1, maxAttempts: 3 })],
      new Map([['res_1', partner()]]),
    );
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const before = Date.now();

    await processDueWebhooks(repo.asRepository(), fetchImpl);

    const outcome = repo.outcomes[0];
    expect(outcome?.kind).toBe('retry');
    if (outcome?.kind === 'retry') {
      expect(outcome.error).toBe('HTTP 500');
      // attempt 2 -> 2 * 30s backoff, schedule in the future.
      expect(outcome.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    }
  });

  it('marks FAILED once the attempt cap is reached', async () => {
    const repo = new FakeRepo(
      [delivery({ attempts: 2, maxAttempts: 3 })],
      new Map([['res_1', partner()]]),
    );
    const fetchImpl = (async () => new Response('boom', { status: 503 })) as typeof fetch;

    await processDueWebhooks(repo.asRepository(), fetchImpl);

    expect(repo.outcomes).toEqual([{ kind: 'failed', id: 'wh_1', error: 'HTTP 503' }]);
  });

  it('retries on a transport error and caps the stored message', async () => {
    const repo = new FakeRepo(
      [delivery({ attempts: 0, maxAttempts: 3 })],
      new Map([['res_1', partner()]]),
    );
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await processDueWebhooks(repo.asRepository(), fetchImpl);

    const outcome = repo.outcomes[0];
    expect(outcome?.kind).toBe('retry');
    if (outcome?.kind === 'retry') expect(outcome.error).toBe('ECONNREFUSED');
  });

  it('fails the delivery when the partner no longer exists', async () => {
    const repo = new FakeRepo([delivery()], new Map());
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    await processDueWebhooks(repo.asRepository(), fetchImpl);

    expect(repo.outcomes).toEqual([{ kind: 'failed', id: 'wh_1', error: '渠道不存在' }]);
  });

  it('signs the callback over the exact bytes, with the delivery id as the nonce', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const entries = new Map([['webhook-key:res_1', privateKeyPem]]);
    bindSecrets(entries);

    const repo = new FakeRepo(
      [delivery({ id: 'wh_sign' })],
      new Map([
        ['res_1', partner({ webhookPrivateKeyRef: 'webhook-key:res_1', webhookPublicKey: publicKeyPem })],
      ]),
    );

    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await processDueWebhooks(repo.asRepository(), fetchImpl);

    expect(captured).not.toBeNull();
    const headers = (captured as unknown as { init: RequestInit }).init.headers as Record<string, string>;
    expect(headers['x-sp-key-id']).toBe('sp_test');
    expect(headers['x-sp-event']).toBe('order.paid');
    expect(headers['x-sp-delivery']).toBe('wh_sign');

    const body = String((captured as unknown as { init: RequestInit }).init.body);
    const canonical = canonicalRequest({
      method: 'POST',
      path: '/sp-hook',
      timestamp: headers['x-sp-timestamp'] as string,
      nonce: 'wh_sign',
      bodyDigest: bodyDigest(body),
    });
    // A partner verifies the callback with the public key and the same algorithm.
    expect(verifyCanonical(canonical, headers['x-sp-signature'] as string, publicKeyPem)).toBe(true);
    expect(repo.outcomes[0]?.kind).toBe('delivered');
  });

  it('fails a signed delivery when the stored private key cannot be revealed', async () => {
    bindSecrets(new Map()); // ref present but unreadable
    const repo = new FakeRepo(
      [delivery()],
      new Map([['res_1', partner({ webhookPrivateKeyRef: 'webhook-key:res_1' })]]),
    );
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as typeof fetch;

    await processDueWebhooks(repo.asRepository(), fetchImpl);

    expect(repo.outcomes).toEqual([
      { kind: 'failed', id: 'wh_1', error: '回调签名私钥无法解密' },
    ]);
  });
});
