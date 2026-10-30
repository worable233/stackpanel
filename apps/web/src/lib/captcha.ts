import type { CaptchaAction, CaptchaClientConfig, CaptchaPolicyResponse } from '@stackpanel/sdk';
import { getApiClient } from './api';

/**
 * Server-side resolution of captcha widget config per guarded action.
 *
 * Reads the kernel's `GET /captcha/policy` rather than the login plugin's
 * `/auth/config`, because sensitive operations live outside the sign-in flow
 * (password change, email change, API-token creation). Keeping the read on the
 * kernel capability means a page keeps working when the login plugin — or the
 * whole captcha plugin — is not installed.
 *
 * Everything here degrades to `null`, which {@link CaptchaField} renders as
 * nothing. Human verification is additive: no configuration, no unreachable API,
 * and no missing plugin can make a form stop working.
 */

/** One action's resolved widget, ready to hand to a client component. */
export interface CaptchaActionConfig {
  action: CaptchaAction;
  policy: 'off' | 'optional' | 'required';
  clientConfig: CaptchaClientConfig | null;
}

function asClientConfig(value: unknown): CaptchaClientConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Record<string, unknown>;
  // Only the protocols this host can actually render are accepted; a provider
  // newer than the host means render nothing rather than guess at its shape.
  if (config['kind'] === 'script' && typeof config['script'] === 'string') {
    return config as unknown as CaptchaClientConfig;
  }
  if (config['kind'] === 'element' && typeof config['tag'] === 'string') {
    return config as unknown as CaptchaClientConfig;
  }
  if (
    config['kind'] === 'container' &&
    typeof config['script'] === 'string' &&
    typeof config['containerClass'] === 'string' &&
    typeof config['hiddenField'] === 'string'
  ) {
    return config as unknown as CaptchaClientConfig;
  }
  return null;
}

/**
 * Read the widget config for one guarded action.
 *
 * Returns `null` when the action's policy is `off`, when no provider claims it,
 * or when the read fails — all of which mean "render no widget".
 */
export async function getCaptchaForAction(
  action: CaptchaAction,
): Promise<CaptchaActionConfig | null> {
  const policy: CaptchaPolicyResponse | null = await getApiClient()
    .getCaptchaPolicy(action)
    .catch(() => null);
  if (!policy || policy.policy === 'off' || !policy.configured) return null;
  const clientConfig = asClientConfig(policy.clientConfig);
  if (!clientConfig) return null;
  return { action, policy: policy.policy, clientConfig };
}

/**
 * Read every guarded action the deployment enables, in one request.
 *
 * Used by pages that render more than one guarded form (account settings hosts
 * the password dialog, the email dialog and the token dialog). Missing actions
 * simply absent from the map, so callers read `map[action] ?? null`.
 */
export async function getCaptchaActions(
  actions: readonly CaptchaAction[],
): Promise<Partial<Record<CaptchaAction, CaptchaActionConfig>>> {
  const policy: CaptchaPolicyResponse | null = await getApiClient()
    .getCaptchaPolicy()
    .catch(() => null);
  const result: Partial<Record<CaptchaAction, CaptchaActionConfig>> = {};
  if (!policy || !policy.configured) return result;
  for (const action of actions) {
    const entry = policy.actions?.[action];
    if (!entry || entry.policy === 'off') continue;
    const clientConfig = asClientConfig(entry.clientConfig);
    if (!clientConfig) continue;
    result[action] = { action, policy: entry.policy, clientConfig };
  }
  return result;
}
