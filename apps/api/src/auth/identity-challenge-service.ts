import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@stackpanel/db';
import {
  PluginError,
  type IdentityChallengeMessage,
  type IdentityChallengePurpose,
  type IdentityChallengeSender,
  type IdentityChallengeService,
  type IssueIdentityChallengeInput,
  type IssuedIdentityChallenge,
  type ConsumeIdentityChallengeInput,
  type StateService,
} from '@stackpanel/sdk';
import { env } from '../config/env.ts';

/**
 * Kernel-owned identity-challenge service (audit §5).
 *
 * A verification code is a transactional credential, not a notification. It is
 * deliberately kept away from the in-app notification table, the SSE stream,
 * generic events, the audit log and application logs: the applicant has no
 * reliable `userId` yet, and a leaked code is an account takeover.
 *
 * Storage holds only a keyed digest + salt. The plaintext code exists only in
 * the {@link IdentityChallengeMessage} handed to the delivery channel and is
 * never persisted or logged.
 */
export interface IdentityChallengeServiceOptions {
  db: PrismaClient;
  /** Shared state for send-rate windows (Redis-ready). */
  state: StateService;
  /** Live senders; the kernel reads the extension point on every issue. */
  getSenders: () => IdentityChallengeSender[];
  /** Secret used to key the code digest. */
  secret: string;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}

const PURPOSES: readonly IdentityChallengePurpose[] = [
  'register',
  'email_change',
  'password_reset',
];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A 6-digit numeric code, generated with a CSPRNG. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export class KernelIdentityChallengeService implements IdentityChallengeService {
  private readonly digestKey: Buffer;

  constructor(private readonly options: IdentityChallengeServiceOptions) {
    // Key the digest off the kernel secret so a database leak alone cannot
    // brute-force a 6-digit code (only 10^6 candidates without the key).
    this.digestKey = createHmac('sha256', 'stackpanel.identity.challenge')
      .update(options.secret)
      .digest();
  }

  isDeliveryConfigured(): boolean {
    return this.options.getSenders().some((sender) => sender.isConfigured?.() ?? true);
  }

  /**
   * @deprecated Registration policy belongs to the login plugin's stored
   * configuration. Kept as a compatibility method and never reads env policy.
   */
  requiresEmailVerification(): boolean {
    return false;
  }

  senderIds(): string[] {
    return this.options.getSenders().map((sender) => sender.id);
  }

  private digest(code: string, salt: string): string {
    return createHmac('sha256', this.digestKey).update(`${salt}:${code}`).digest('hex');
  }

  async issue(input: IssueIdentityChallengeInput): Promise<IssuedIdentityChallenge> {
    const purpose = input.purpose;
    if (!PURPOSES.includes(purpose)) {
      throw new PluginError('auth.code_purpose_invalid', 400, '不支持的验证码用途');
    }
    const email = normalizeEmail(input.email);
    const senders = this.options.getSenders();
    if (senders.length === 0) {
      // Never silently skip: a mandatory flow must fail loudly when no delivery
      // channel is available (audit §5).
      throw new PluginError('auth.code_channel_unavailable', 503, '未配置验证码发送通道');
    }

    // Send-rate limits, per recipient and per source IP.
    const emailLimit = env.AUTH_CODE_SEND_PER_HOUR;
    if (emailLimit > 0) {
      const count = await this.options.state.incr(
        `identity:code:send:email:${email}:${purpose}`,
        3_600_000,
      );
      if (count > emailLimit) {
        throw new PluginError('auth.code_rate_limited', 429, '验证码发送过于频繁，请稍后再试');
      }
    }
    const ipLimit = env.AUTH_CODE_SEND_PER_HOUR_PER_IP;
    if (ipLimit > 0 && input.ip) {
      const count = await this.options.state.incr(
        `identity:code:send:ip:${input.ip}`,
        3_600_000,
      );
      if (count > ipLimit) {
        throw new PluginError('auth.code_rate_limited', 429, '验证码发送过于频繁，请稍后再试');
      }
    }

    const code = generateCode();
    const salt = randomBytes(16).toString('base64');
    const ttlMs = env.AUTH_CODE_TTL_SECONDS * 1000;
    const expiresAt = new Date(Date.now() + ttlMs);

    // Only one active challenge per (email, purpose): retire earlier ones so a
    // resent code is the only one that can succeed.
    await this.options.db.identityChallenge.updateMany({
      where: { email, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const row = await this.options.db.identityChallenge.create({
      data: {
        purpose,
        email,
        codeDigest: this.digest(code, salt),
        codeSalt: salt,
        maxAttempts: env.AUTH_CODE_MAX_ATTEMPTS,
        locale: input.locale ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        expiresAt,
      },
    });

    const message: IdentityChallengeMessage = {
      purpose,
      email,
      code,
      expiresAt,
      ...(input.locale ? { locale: input.locale } : {}),
    };

    // Deliver through the first sender that accepts the message. A delivery
    // failure retires the challenge (it can never be guessed) and surfaces.
    let deliveredBy: string | null = null;
    for (const sender of senders) {
      try {
        await sender.send(message);
        deliveredBy = sender.id;
        break;
      } catch (error) {
        this.options.logger?.warn(
          `identity: sender ${sender.id} failed for ${purpose}: ${(error as Error).message}`,
        );
      }
    }
    if (!deliveredBy) {
      await this.options.db.identityChallenge.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      throw new PluginError('auth.code_delivery_failed', 502, '验证码发送失败，请稍后再试');
    }

    return {
      challengeId: row.id,
      email,
      purpose,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.floor(ttlMs / 1000),
      deliveredBy,
    };
  }

  async consume(input: ConsumeIdentityChallengeInput): Promise<void> {
    const purpose = input.purpose;
    const email = normalizeEmail(input.email);
    const code = typeof input.code === 'string' ? input.code.trim() : '';

    const active = await this.options.db.identityChallenge.findFirst({
      where: { email, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      throw new PluginError('auth.code_missing', 400, '验证码不存在或已失效，请重新获取');
    }
    if (active.expiresAt.getTime() <= Date.now()) {
      // Expired: retire it so a later resend is unambiguous.
      await this.options.db.identityChallenge.updateMany({
        where: { id: active.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      throw new PluginError('auth.code_expired', 400, '验证码已过期，请重新获取');
    }
    if (active.attempts >= active.maxAttempts) {
      throw new PluginError('auth.code_locked', 429, '验证码尝试次数过多，请重新获取');
    }

    const expected = Buffer.from(active.codeDigest, 'hex');
    const actual = Buffer.from(this.digest(code, active.codeSalt), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!matches) {
      const attempts = active.attempts + 1;
      const locked = attempts >= active.maxAttempts;
      await this.options.db.identityChallenge.update({
        where: { id: active.id },
        data: {
          attempts,
          // Burn the challenge once the attempt ceiling is hit.
          ...(locked ? { consumedAt: new Date() } : {}),
        },
      });
      throw new PluginError(
        locked ? 'auth.code_locked' : 'auth.code_invalid',
        locked ? 429 : 400,
        locked ? '验证码尝试次数过多，请重新获取' : '验证码不正确',
      );
    }

    // Atomic single consumption: the first writer to flip `consumedAt` wins; a
    // concurrent consumer sees `count === 0` and is rejected.
    const consumed = await this.options.db.identityChallenge.updateMany({
      where: { id: active.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new PluginError('auth.code_invalid', 400, '验证码不正确或已被使用');
    }
  }
}
