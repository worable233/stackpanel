import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';

/**
 * Public projection of the kernel captcha capability.
 *
 * Deliberately **not** part of the login plugin: human verification guards
 * sensitive operations, not sign-up. A third-party plugin route (a store refund,
 * a support escalation) needs the same widget config, and it must keep working
 * when the login plugin is uninstalled. Mounting this on the kernel's own
 * captcha service makes the projection vendor-neutral and plugin-neutral — it
 * returns exactly what the registered provider chose to publish, and nothing at
 * all when no provider is installed.
 *
 * Nothing here is a secret: `clientConfig` is the widget's public site key and
 * script URL, the same values the browser needs to render it. The provider's
 * secret never leaves the plugin's encrypted storage.
 */

const actionSchema = z.object({
  action: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});

/** CSP-relevant external origins a widget needs, extracted from its config. */
export interface CaptchaCspSources {
  script?: string[];
  /** Stylesheets the widget injects (a theme CSS usually lives on its own origin). */
  style?: string[];
  frame?: string[];
  connect?: string[];
  /** Origins a `Blob`/URL worker is created from (proof-of-work widgets). */
  worker?: string[];
}

/**
 * Narrow one declared source to an https origin.
 *
 * Providers declare their own external origins (a Turnstile widget loads
 * `challenges.cloudflare.com`), which is what keeps the kernel vendor-neutral.
 * That also makes the value attacker-adjacent: a malicious or buggy provider
 * could try to inject `javascript:` or a `data:` URI into a CSP directive. Only
 * absolute https origins survive, normalized through `URL` so a path or query
 * cannot smuggle a directive separator.
 */
export function sanitizeCspOrigins(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const origins = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // `blob:` is a scheme source, not an origin: a proof-of-work widget runs its
    // solver in `new Worker(URL.createObjectURL(blob))`. It is relayed verbatim
    // because `new URL('blob:')` throws and it can never widen to a host.
    // `data:` is deliberately not relayed — it turns any HTML injection into
    // script execution, and no widget needs it.
    if (trimmed === 'blob:') {
      origins.add(trimmed);
      continue;
    }
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:') continue;
      origins.add(url.origin);
    } catch {
      // Not an absolute URL: nothing to allow.
    }
  }
  return [...origins];
}

/** Extract and sanitize the `sources` block of a provider's client config. */
export function captchaCspSources(config: Record<string, unknown> | null): CaptchaCspSources {
  const sources = config?.['sources'];
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return {};
  const raw = sources as Record<string, unknown>;
  const script = sanitizeCspOrigins(raw['script']);
  const style = sanitizeCspOrigins(raw['style']);
  const frame = sanitizeCspOrigins(raw['frame']);
  const connect = sanitizeCspOrigins(raw['connect']);
  const worker = sanitizeCspOrigins(raw['worker']);
  return {
    ...(script.length > 0 ? { script } : {}),
    ...(style.length > 0 ? { style } : {}),
    ...(frame.length > 0 ? { frame } : {}),
    ...(connect.length > 0 ? { connect } : {}),
    ...(worker.length > 0 ? { worker } : {}),
  };
}

/**
 * Actions the kernel itself guards. Kept here so the public policy endpoint can
 * report them without importing every route module, and so a future sensitive
 * operation has one obvious place to register its identifier.
 */
export const KERNEL_CAPTCHA_ACTIONS = [
  'login',
  'register',
  'register_send_code',
  'password_reset',
  'change_password',
  'change_email',
  'api_token_create',
] as const;

export async function captchaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * `GET /captcha/policy?action=<action>` — public, unauthenticated.
   *
   * Without `action` it reports the global mode and the default widget config
   * (what the register page has always consumed). With an action it reports that
   * action's effective policy and the widget config of the provider that claims
   * it.
   *
   * `actions` only lists the non-`off` ones: an anonymous visitor gets the widget
   * configs they will actually need to render, never a full policy map of the
   * deployment.
   */
  app.get('/captcha/policy', { ...rateLimitConfig('publicRead') }, async (request, reply) => {
    const query = actionSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '请求参数无效' });
    const captcha = app.captcha;
    const action = query.data.action;

    if (action) {
      const config = await captcha.clientConfigFor(action);
      return {
        action,
        policy: await captcha.policyFor(action),
        configured: captcha.isConfigured(),
        clientConfig: config,
        sources: captchaCspSources(config),
      };
    }

    const config = await captcha.clientConfig();
    const actions: Record<string, unknown> = {};
    for (const id of KERNEL_CAPTCHA_ACTIONS) {
      const policy = await captcha.policyFor(id);
      if (policy === 'off') continue;
      const actionConfig = await captcha.clientConfigFor(id);
      actions[id] = {
        policy,
        clientConfig: actionConfig,
        sources: captchaCspSources(actionConfig),
      };
    }
    return {
      action: null,
      policy: captcha.mode(),
      configured: captcha.isConfigured(),
      clientConfig: config,
      sources: captchaCspSources(config),
      actions,
    };
  });
}
