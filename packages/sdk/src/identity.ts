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
  /** Whether this channel is currently ready to deliver messages. Older
   * senders that omit this method are treated as available for compatibility. */
  isConfigured?(): boolean;
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

/**
 * Stable identifiers for the sensitive operations a captcha can guard.
 *
 * The set is closed on purpose: the frontend fetches one widget config per
 * action and operators write policy against these keys, so both need a fixed
 * vocabulary. Adding an action is a kernel addition, not a plugin choice — a new
 * sensitive operation ships with its own kernel (or plugin) route anyway.
 *
 * {@link CaptchaVerification.action} stays a plain `string` so existing providers
 * and the isolated-worker RPC keep working unchanged; this union documents the
 * values the kernel itself sends.
 */
export type CaptchaAction =
  | 'login'
  | 'register'
  | 'register_send_code'
  | 'password_reset'
  | 'change_password'
  | 'change_email'
  | 'api_token_create';

/** One captcha challenge response to verify. */
export interface CaptchaVerification {
  /** Provider token captured by the frontend widget. */
  token: string;
  /**
   * Logical action the token was minted for. The kernel sends one of
   * {@link CaptchaAction}; the type stays `string` for compatibility.
   */
  action?: string;
  /** Client IP, so the provider can scope the verification. */
  remoteIp?: string;
}

/** Policy a provider can declare for one action. */
export interface CaptchaPolicy {
  /** `off` never asks; `optional` verifies a token when present; `required` refuses a token-less request. */
  mode: 'off' | 'optional' | 'required';
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
 * A value a plugin may produce synchronously or over the isolated RPC boundary.
 *
 * The kernel always awaits: an out-of-process plugin answers asynchronously, and
 * a synchronous return type there silently becomes a pending promise — which in
 * JSON is `{}`, i.e. a widget config with no keys and a policy with no value.
 */
export type MaybePromise<T> = T | Promise<T>;

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
   * script/iframe URL, theme…). Never a secret. Omit when the widget needs none,
   * and return `null` when the provider is installed but not yet configured: a
   * registered-but-unconfigured provider must not advertise a widget the browser
   * could not render.
   *
   * May return a promise: a plugin running out-of-process answers over RPC, and a
   * kernel that cannot await would treat the pending promise as a result (it
   * serialises to `{}` and the browser renders nothing). The kernel always
   * awaits, so an in-process provider may stay synchronous.
   */
  clientConfig?(): MaybePromise<Record<string, unknown> | null>;
  /**
   * Policy this provider declares for one action.
   *
   * Returning `null`/omitting means "no opinion": the kernel falls back to the
   * global `AUTH_CAPTCHA_MODE`. Declaring `off` explicitly opts an action out
   * even when another provider wants it.
   *
   * Policy lives with the provider (not in a kernel setting) on purpose: an
   * uninstalled provider takes its policy with it, and the kernel never holds an
   * operator-owned policy table that only kernel privileges could edit.
   *
   * May return a promise, for the same reason as {@link clientConfig}.
   */
  policyFor?(action: string): MaybePromise<CaptchaPolicy | null>;
}

/** Kernel-owned captcha service (`ctx.captcha`). */
export interface CaptchaService {
  /** Configured policy: `off` never asks, `optional` verifies when present, `required` rejects without one. */
  mode(): 'off' | 'optional' | 'required';
  /** Whether any provider is registered. */
  isConfigured(): boolean;
  /** Ids of the registered providers. */
  providerIds(): string[];
  /**
   * Verify a token against the registered provider(s).
   *
   * When `input.action` is present and at least one provider declares a policy
   * for it, only those providers are asked; otherwise every provider is tried in
   * registration order.
   */
  verify(input: CaptchaVerification): Promise<CaptchaVerifyResult>;
  /**
   * Apply the configured policy to one request and throw a deterministic
   * `PluginError` when it fails. Callers never re-implement `off`/`optional`/
   * `required` semantics — the policy stays kernel-owned.
   *
   * The global `AUTH_CAPTCHA_MODE` is a master switch: `off` short-circuits every
   * action, so an operator can always turn verification off without uninstalling
   * the provider.
   */
  enforce(input: CaptchaVerification): Promise<void>;
  /**
   * Provider-supplied client config for the frontend widget (site key, script
   * URL, …), or `null` when no provider supplies one. Never contains a secret.
   */
  clientConfig(): Promise<Record<string, unknown> | null>;
  /**
   * Effective policy for one action: the first provider that declares one wins,
   * otherwise the global `AUTH_CAPTCHA_MODE`.
   */
  policyFor(action: string): Promise<'off' | 'optional' | 'required'>;
  /**
   * Widget config for one action, resolved from the providers that claim it.
   * Falls back to {@link clientConfig} so a provider that ignores actions still
   * renders everywhere it is asked for.
   */
  clientConfigFor(action: string): Promise<Record<string, unknown> | null>;
}
