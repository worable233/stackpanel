import type {
  CaptchaProvider,
  CaptchaService,
  CaptchaVerification,
  CaptchaVerifyResult,
} from '@stackpanel/sdk';
import { PluginError } from '@stackpanel/sdk';
import { getConfig } from '../config/runtime-config.ts';

export type CaptchaMode = 'off' | 'optional' | 'required';

/**
 * Kernel-owned human-verification service (audit §5).
 *
 * The kernel depends on no specific vendor: plugins register a
 * {@link CaptchaProvider} to the `captcha.provider` extension point and the
 * kernel picks the first that accepts a token. The `off` / `optional` /
 * `required` policy is kernel-owned ({@link enforce}) so every call site — the
 * register and the send-code entry points, the credential routes, and any
 * plugin route — shares one contract and never silently treats a missing
 * provider as a pass.
 *
 * Two layers of policy:
 *
 * - **Global** `AUTH_CAPTCHA_MODE` is the master switch. `off` short-circuits
 *   every action, so an operator can disable verification without uninstalling
 *   the provider, and a deployment that never touched the variable (the default
 *   is `off`) behaves exactly as it did before per-action policy existed.
 * - **Per action**, a provider may declare its own mode via
 *   `policyFor(action)`. An action nobody claims falls back to the global mode.
 *
 * Resolving "who answers for this action" also decides who verifies its token:
 * once any provider claims an action, only claiming providers are asked, so a
 * Turnstile token is never sent to a Cap endpoint in a multi-provider install.
 */
/**
 * Provider methods may be answered by an in-process implementation or proxied to
 * an isolated plugin, which makes every answer a Promise. Awaiting both shapes in
 * one place keeps callers honest: a forgotten await here is a policy that
 * silently degrades to "off".
 */
async function resolve<T>(value: T | Promise<T> | undefined | null): Promise<T | null> {
  return (await value) ?? null;
}

export interface CaptchaServiceOptions {
  getProviders: () => CaptchaProvider[];
  logger?: { warn: (message: string) => void };
}

export class KernelCaptchaService implements CaptchaService {
  constructor(private readonly options: CaptchaServiceOptions) {}

  mode(): CaptchaMode {
    return getConfig('AUTH_CAPTCHA_MODE');
  }

  /**
   * Deliberately synchronous: it only counts registrations, and a boolean that
   * arrives as a pending promise is the kind of "true" nobody can debug.
   */
  isConfigured(): boolean {
    return this.options.getProviders().length > 0;
  }

  providerIds(): string[] {
    return this.options.getProviders().map((provider) => provider.id);
  }

  async clientConfig(): Promise<Record<string, unknown> | null> {
    for (const provider of this.options.getProviders()) {
      const config = await resolve(provider.clientConfig?.());
      if (config) return config;
    }
    return null;
  }

  async clientConfigFor(action: string): Promise<Record<string, unknown> | null> {
    for (const provider of await this.providersForAction(action)) {
      // Action-scoped config first: a provider that binds a challenge to one
      // action must not be handed the generic widget (which would mint tokens
      // for whatever action its default is).
      const config =
        (await resolve(provider.clientConfigFor?.(action))) ??
        (await resolve(provider.clientConfig?.()));
      if (config) return config;
    }
    // A provider that ignores actions entirely still renders wherever it is
    // asked for, so the single-provider install keeps its old behaviour.
    return this.clientConfig();
  }

  /**
   * Effective policy for one action.
   *
   * Returns `off` when the global master switch is off — regardless of what a
   * provider declared — because an operator's env-level `off` is the final veto.
   */
  async policyFor(action: string): Promise<CaptchaMode> {
    if (this.mode() === 'off') return 'off';
    for (const provider of this.options.getProviders()) {
      const policy = await resolve(provider.policyFor?.(action));
      if (policy) return policy.mode;
    }
    return this.mode();
  }

  async verify(input: CaptchaVerification): Promise<CaptchaVerifyResult> {
    const providers = await this.providersForAction(input.action);
    if (providers.length === 0) {
      return { success: false, reason: 'no_provider' };
    }
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!token) {
      return { success: false, reason: 'missing_token' };
    }
    let lastReason = 'rejected';
    for (const provider of providers) {
      try {
        const result = await provider.verify({ ...input, token });
        if (result.success) {
          return { success: true, providerId: result.providerId ?? provider.id };
        }
        lastReason = result.reason ?? 'rejected';
      } catch (error) {
        // A provider outage is not a pass; try the next and remember why.
        lastReason = 'provider_error';
        this.options.logger?.warn(
          `captcha: provider ${provider.id} failed: ${(error as Error).message}`,
        );
      }
    }
    return { success: false, reason: lastReason };
  }

  async enforce(input: CaptchaVerification): Promise<void> {
    // Master switch first: an explicit env-level `off` never verifies anything,
    // so disabling verification is one restart away in an emergency.
    if (this.mode() === 'off') return;

    // Await: a provider backed by an isolated plugin answers with a Promise, and a
    // Promise is neither "off" nor "required" — comparing it directly let a
    // `required` deployment admit token-less requests (fail-open).
    const policy = input.action ? await this.policyFor(input.action) : this.mode();
    if (policy === 'off') return;

    const providers = await this.providersForAction(input.action);
    const hasToken = typeof input.token === 'string' && input.token.trim().length > 0;
    if (providers.length === 0) {
      // `required` with no provider must fail closed; `optional` keeps a
      // non-configured deployment working.
      if (policy === 'required') {
        throw new PluginError('auth.captcha_unavailable', 503, '人机验证服务不可用');
      }
      return;
    }
    if (!hasToken) {
      if (policy === 'required') {
        throw new PluginError('auth.captcha_required', 400, '请完成人机验证');
      }
      return;
    }
    const result = await this.verify(input);
    if (!result.success) {
      throw new PluginError('auth.captcha_failed', 400, '人机验证未通过，请重试');
    }
  }

  /**
   * Providers that answer for `action`.
   *
   * With no action (legacy call sites) every provider is eligible. With an
   * action, providers that declare a policy for it take precedence; when nobody
   * declares one, all providers stay eligible so a single-provider install that
   * never declares actions still works.
   */
  private async providersForAction(action?: string): Promise<CaptchaProvider[]> {
    const providers = this.options.getProviders();
    if (!action) return providers;
    const claiming: CaptchaProvider[] = [];
    for (const provider of providers) {
      if ((await resolve(provider.policyFor?.(action))) != null) claiming.push(provider);
    }
    return claiming.length > 0 ? claiming : providers;
  }
}
