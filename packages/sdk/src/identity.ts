/**
 * Identity challenges and human-verification contracts (audit §5).
 *
 * Two capabilities the kernel owns and the login plugin drives:
 *
 * 1. **Identity challenge** — a short-lived, single-use, rate-limited code that
 *    proves control of an email address *before* an account becomes ACTIVE.
 *    The kernel owns the challenge table (digest, TTL, attempt/rate limits,
 *    atomic single consumption); the code is delivered by a channel plugin that
 *    registers an {@link IdentityChallengeSender} to the
 *    `identity.challengeSender` extension point. A verification code is
 *    deliberately **not** routed through the in-app notification service: the
 *    applicant has no reliable `userId` yet, and a code must never leak into the
 *    inbox, SSE stream, generic events, audit log or application logs.
 *
 * 2. **Captcha** — a controlled provider contract (`captcha.provider`). The
 *    frontend obtains a token, the backend verifies it (action, site, expiry)
 *    at the register and send-code entry points. The kernel never depends on a
 *    specific vendor; a provider plugin registers an implementation.
 */

/** Why a challenge was issued. Keeps one code namespace per use case. */
export type IdentityChallengePurpose = 'register' | 'email_change' | 'password_reset';

/** A code handed to a delivery channel. Contains the plaintext exactly once. */
export interface IdentityChallengeMessage {
  purpose: IdentityChallengePurpose;
  /** Normalised (lowercased) recipient address. */
  email: string;
  /** The plaintext verification code. Never persisted in this form. */
  code: string;
  expiresAt: Date;
  /** Optional BCP-47 tag so the sender can pick a template language. */
  locale?: string;
}

/**
 * A delivery channel for verification codes (email/SMS). Registered to the
 * `identity.challengeSender` extension point. Distinct from the in-app
 * notification channel: a code is transactional and must not be mirrored into
 * the user's inbox.
 */
export interface IdentityChallengeSender {
  readonly id: string;
  readonly name: string;
  /** Deliver one code. Throw to signal a delivery failure the kernel surfaces. */
  send(message: IdentityChallengeMessage): Promise<void>;
}

/** Input to {@link IdentityChallengeService.issue}. */
export interface IssueIdentityChallengeInput {
  purpose: IdentityChallengePurpose;
  email: string;
  /** Client IP for send-rate limiting. */
  ip?: string;
  userAgent?: string;
  locale?: string;
}

/** Result of a successful issue; the plaintext code is never returned. */
export interface IssuedIdentityChallenge {
  challengeId: string;
  email: string;
  purpose: IdentityChallengePurpose;
  expiresAt: string;
  /** Seconds until expiry, for a UI countdown. */
  expiresInSeconds: number;
  /** Id of the sender that accepted the message. */
  deliveredBy: string;
}

/** Input to {@link IdentityChallengeService.consume}. */
export interface ConsumeIdentityChallengeInput {
  purpose: IdentityChallengePurpose;
  email: string;
  code: string;
}

/**
 * Kernel-owned identity-challenge service (`ctx.identity`). Issue a code, then
 * consume it atomically; consumption is single-use and bounded by attempts.
 */
export interface IdentityChallengeService {
  /** Whether registration requires a verified email code before the account activates. */
  requiresEmailVerification(): boolean;
  /** Whether at least one sender is registered (SMTP/SMS plugin available). */
  isDeliveryConfigured(): boolean;
  /** Ids of the registered senders (diagnostics / admin surfaces). */
  senderIds(): string[];
  /**
   * Issue and deliver a code. Rate-limited per email and per IP; throws when no
   * delivery channel is configured rather than silently succeeding.
   */
  issue(input: IssueIdentityChallengeInput): Promise<IssuedIdentityChallenge>;
  /**
   * Verify a code and atomically consume its challenge. Throws a
   * `PluginError` with a stable code (`auth.code_missing` / `auth.code_invalid`
   * / `auth.code_expired` / `auth.code_locked`) on any failure, so the caller
   * can map it to a user-facing message.
   */
  consume(input: ConsumeIdentityChallengeInput): Promise<void>;
}

/** One captcha challenge response to verify. */
export interface CaptchaVerification {
  /** Provider token captured by the frontend widget. */
  token: string;
  /** Logical action the token was minted for (e.g. `register`). */
  action?: string;
  /** Client IP, so the provider can scope the verification. */
  remoteIp?: string;
}

/** Outcome of a captcha verification. */
export interface CaptchaVerifyResult {
  success: boolean;
  /** Machine-readable reason when `success` is false. */
  reason?: string;
  /** Id of the provider that evaluated the token. */
  providerId?: string;
}

/**
 * A human-verification provider the kernel invokes via
 * {@link CaptchaService}. Registered to the `captcha.provider` extension point.
 */
export interface CaptchaProvider {
  readonly id: string;
  readonly name: string;
  verify(input: CaptchaVerification): Promise<CaptchaVerifyResult>;
  /**
   * Public configuration the frontend needs to render the widget (site key,
   * script/iframe URL, theme…). Never a secret. Omit when the widget needs none.
   */
  clientConfig?(): Record<string, unknown>;
}

/** Kernel-owned captcha service (`ctx.captcha`). */
export interface CaptchaService {
  /** Configured policy: `off` never asks, `optional` verifies when present, `required` rejects without one. */
  mode(): 'off' | 'optional' | 'required';
  /** Whether any provider is registered. */
  isConfigured(): boolean;
  /** Ids of the registered providers. */
  providerIds(): string[];
  /** Verify a token against the registered provider(s). */
  verify(input: CaptchaVerification): Promise<CaptchaVerifyResult>;
  /**
   * Apply the configured policy to one request and throw a deterministic
   * `PluginError` when it fails. Callers never re-implement `off`/`optional`/
   * `required` semantics — the policy stays kernel-owned.
   */
  enforce(input: CaptchaVerification): Promise<void>;
  /**
   * Provider-supplied client config for the frontend widget (site key, script
   * URL, …), or `null` when no provider supplies one. Never contains a secret.
   */
  clientConfig(): Record<string, unknown> | null;
}
