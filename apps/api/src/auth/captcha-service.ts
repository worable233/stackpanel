import type {
  CaptchaProvider,
  CaptchaService,
  CaptchaVerification,
  CaptchaVerifyResult,
} from '@stackpanel/sdk';
import { PluginError } from '@stackpanel/sdk';
import { env } from '../config/env.ts';

/**
 * Kernel-owned human-verification service (audit §5).
 *
 * The kernel depends on no specific vendor: plugins register a
 * {@link CaptchaProvider} to the `captcha.provider` extension point and the
 * kernel picks the first that accepts a token. The `off` / `optional` /
 * `required` policy is kernel-owned ({@link enforce}) so every call site — the
 * register and the send-code entry points — shares one contract and never
 * silently treats a missing provider as a pass.
 */
export interface CaptchaServiceOptions {
  getProviders: () => CaptchaProvider[];
  logger?: { warn: (message: string) => void };
}

export class KernelCaptchaService implements CaptchaService {
  constructor(private readonly options: CaptchaServiceOptions) {}

  mode(): 'off' | 'optional' | 'required' {
    return env.AUTH_CAPTCHA_MODE;
  }

  isConfigured(): boolean {
    return this.options.getProviders().length > 0;
  }

  providerIds(): string[] {
    return this.options.getProviders().map((provider) => provider.id);
  }

  clientConfig(): Record<string, unknown> | null {
    for (const provider of this.options.getProviders()) {
      const config = provider.clientConfig?.();
      if (config) return config;
    }
    return null;
  }

  async verify(input: CaptchaVerification): Promise<CaptchaVerifyResult> {
    const providers = this.options.getProviders();
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
    const mode = this.mode();
    if (mode === 'off') return;
    const hasToken = typeof input.token === 'string' && input.token.trim().length > 0;
    if (!this.isConfigured()) {
      // `required` with no provider must fail closed; `optional` keeps a
      // non-configured deployment working.
      if (mode === 'required') {
        throw new PluginError('auth.captcha_unavailable', 503, '人机验证服务不可用');
      }
      return;
    }
    if (!hasToken) {
      if (mode === 'required') {
        throw new PluginError('auth.captcha_required', 400, '请完成人机验证');
      }
      return;
    }
    const result = await this.verify(input);
    if (!result.success) {
      throw new PluginError('auth.captcha_failed', 400, '人机验证未通过，请重试');
    }
  }
}
