import { definePlugin, isPluginError, PluginError } from '@stackpanel/sdk';
import type { AuthUser, HttpReply, HttpRequest, PluginContext } from '@stackpanel/sdk';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Human-verification token captured by the frontend widget. Carried on the
 * register and send-code requests; the kernel's `ctx.captcha.enforce` applies
 * the configured policy, so the plugin never branches on `off`/`optional`/
 * `required` itself.
 */
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  /**
   * Referral code the visitor arrived with. The kernel has no notion of
   * referrals; this plugin only forwards it on the `user.registered` event so
   * an interested plugin can attribute the signup (ADR: referral design §4.1).
   */
  affid: z.string().trim().max(64).optional(),
  /** Verification code, required when registration requires a verified email. */
  code: z.string().trim().min(1).max(16).optional(),
  captchaToken: z.string().trim().min(1).max(4096).optional(),
});

const sendCodeSchema = z.object({
  email: z.string().email(),
  captchaToken: z.string().trim().min(1).max(4096).optional(),
});

/** Fixed-window rate limiter backed by the kernel shared state (Redis-ready). */
const WINDOW_MS = 60_000;

function rateLimits(): { login: number; register: number } {
  return {
    login: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 5),
    register: Number(process.env.REGISTER_RATE_LIMIT_MAX ?? 5),
  };
}

let ctx: PluginContext | null = null;

function auth(): PluginContext {
  if (!ctx) throw new Error('登录插件未就绪');
  return ctx;
}

/**
 * Count one attempt and report whether it is within the window. Counters live
 * in the kernel shared state so every replica enforces the same ceiling and
 * the limit survives a restart (audit M-4). Keys are namespaced by dimension
 * so both the source IP and the target account are limited.
 */
async function allow(kind: 'ip' | 'user', identifier: string, limit: number): Promise<boolean> {
  if (limit <= 0) return true;
  const count = await auth().state.incr(`login:${kind}:${identifier}`, WINDOW_MS);
  return count <= limit;
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      // Deterministic contract: let the kernel error boundary render the code
      // (ADR-0012). Brand check, not `instanceof`, so it holds across the
      // plugin loader's cache-busted SDK copy too.
      if (isPluginError(error)) throw error;
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      return reply.code(status).send({ error: (error as Error).message ?? '请求失败' });
    }
  };
}

function setSessionCookie(reply: HttpReply, token: string): void {
  const config = auth().auth.sessionCookieConfig();
  reply.setCookie?.(config.name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secure,
    path: '/',
    maxAge: config.maxAge,
  });
}

/** Extract the client IP for the captcha verification (scoping per source). */
function clientIp(req: HttpRequest): string | undefined {
  return req.ip ?? undefined;
}

const login = handle(async (req: HttpRequest, reply: HttpReply) => {
  if (!(await allow('ip', req.ip ?? 'unknown', rateLimits().login))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
  const { email, password } = parsed.data;
  if (!(await allow('user', email.toLowerCase(), rateLimits().login))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }
  const user = await auth().auth.verifyPassword(email, password);
  if (!user) {
    await auth().auth.audit({
      action: 'auth.login.failed',
      resource: 'user',
      meta: { email: email.toLowerCase(), provider: 'password' },
      ...(req.ip ? { ip: req.ip } : {}),
    });
    throw new PluginError('auth.invalid_credentials', 401, '邮箱或密码错误');
  }
  const token = await auth().auth.issueSession(user.id);
  setSessionCookie(reply, token);
  await auth().auth.audit({
    action: 'auth.login',
    resource: 'user',
    resourceId: user.id,
    meta: { provider: 'password' },
    ...(req.ip ? { ip: req.ip } : {}),
  });
  return { token, user };
});

/**
 * Send a registration verification code. Independent identity-challenge flow:
 * the kernel owns the challenge table (digest, TTL, attempt/limit, single
 * consumption) and the delivery channel (an `identity.challengeSender` plugin);
 * the code never touches the in-app inbox (audit §5).
 */
const sendCode = handle(async (req: HttpRequest, reply: HttpReply) => {
  const ip = clientIp(req);
  if (!(await allow('ip', ip ?? 'unknown', rateLimits().register))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }
  const parsed = sendCodeSchema.safeParse(req.body);
  if (!parsed.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
  const email = parsed.data.email.toLowerCase();

  // Human verification covers the send-code entry point (audit §5).
  await auth().captcha.enforce({
    token: parsed.data.captchaToken ?? '',
    action: 'register_send_code',
    ...(ip ? { remoteIp: ip } : {}),
  });

  // Fail fast when email verification is off and no code is wanted: avoid
  // spending a challenge/email for a flow that ignores it.
  if (!auth().identity.requiresEmailVerification()) {
    throw new PluginError('auth.code_not_required', 400, '当前未启用注册邮箱验证');
  }

  const existing = await auth().auth.getUserByEmail(email);
  if (existing) {
    // Do not confirm existence to an unauthenticated caller beyond what the
    // register endpoint already reveals; but skip sending a code.
    throw new PluginError('auth.email_taken', 409, '邮箱已被使用');
  }

  const issued = await auth().identity.issue({
    purpose: 'register',
    email,
    ...(ip ? { ip } : {}),
    ...(req.headers['user-agent'] ? { userAgent: String(req.headers['user-agent']) } : {}),
  });
  await auth().auth.audit({
    action: 'auth.register.code_sent',
    resource: 'user',
    meta: { email, deliveredBy: issued.deliveredBy, provider: 'password' },
    ...(ip ? { ip } : {}),
  });
  return reply.code(202).send({
    sent: true,
    email: issued.email,
    expiresAt: issued.expiresAt,
    expiresInSeconds: issued.expiresInSeconds,
  });
});

const register = handle(async (req: HttpRequest, reply: HttpReply) => {
  const ip = clientIp(req);
  if (!(await allow('ip', ip ?? 'unknown', rateLimits().register))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
  const { email, password, affid, code } = parsed.data;
  if (!(await allow('user', email.toLowerCase(), rateLimits().register))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }

  // Human verification covers the register entry point.
  await auth().captcha.enforce({
    token: parsed.data.captchaToken ?? '',
    action: 'register',
    ...(ip ? { remoteIp: ip } : {}),
  });

  const requireVerification = auth().identity.requiresEmailVerification();
  if (requireVerification) {
    // Consume the code *before* creating the account: a verified email is a
    // precondition for an ACTIVE account, and single-use consumption is atomic
    // in the kernel service (audit §5).
    await auth().identity.consume({
      purpose: 'register',
      email: email.toLowerCase(),
      code: code ?? '',
    });
  }

  let user: AuthUser;
  try {
    user = await auth().auth.registerUser({ email, password, emailVerified: requireVerification });
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (message.includes('邮箱已被使用')) {
      throw new PluginError('auth.email_taken', 409, message);
    }
    if (message.includes('邮箱') || message.includes('密码')) {
      throw new PluginError('validation.invalid', 422, message);
    }
    throw new PluginError('auth.register_failed', 409, '注册失败，请稍后再试');
  }
  const token = await auth().auth.issueSession(user.id);
  setSessionCookie(reply, token);
  await auth().auth.audit({
    action: 'auth.register',
    resource: 'user',
    resourceId: user.id,
    meta: { provider: 'password', emailVerified: user.emailVerifiedAt != null },
    ...(ip ? { ip } : {}),
  });
  // Announce the signup so downstream plugins can attribute it. Published after
  // the account and session exist so a subscriber can safely act on the user.
  auth().events.publish('user.registered', {
    userId: user.id,
    email: user.email,
    affid: affid ?? null,
    ip: req.ip ?? null,
  });
  return reply.code(201).send({ token, user });
});

const logout = handle(async (req: HttpRequest, reply: HttpReply) => {
  const config = auth().auth.sessionCookieConfig();
  if (req.sessionToken) {
    await auth().auth.revokeSession(req.sessionToken);
  }
  reply.clearCookie?.(config.name, { path: '/' });
  return reply.code(204).send();
});

const me = handle(async (req: HttpRequest) => {
  if (!req.user) return { user: null };
  const fullUser = await auth().auth.getUser(req.user.id);
  if (!fullUser) return { user: null };
  return { user: fullUser };
});

/**
 * Public authentication policy for the frontend: whether a verification code is
 * required at registration and the (non-secret) captcha widget config. Keeps the
 * register form from hard-coding deployment policy.
 */
const authConfig = handle(async () => {
  return {
    emailVerificationRequired: auth().identity.requiresEmailVerification(),
    captcha: {
      mode: auth().captcha.mode(),
      configured: auth().captcha.isConfigured(),
      providerIds: auth().captcha.providerIds(),
      clientConfig: auth().captcha.clientConfig(),
    },
  };
});

export const loginPlugin = definePlugin({
  manifest: {
    id: 'login',
    name: '登录插件',
    version: '0.2.0',
    description:
      '内置登录/注册插件：登录、注册与注销流程，支持可选的注册邮箱验证与人机验证。验证与令牌签发由平台 ctx 完成。',
  },
  routes: [
    { method: 'POST', path: '/login', auth: 'public', handler: login },
    { method: 'POST', path: '/register', auth: 'public', handler: register },
    { method: 'POST', path: '/register/send-code', auth: 'public', handler: sendCode },
    { method: 'GET', path: '/auth/config', auth: 'public', handler: authConfig },
    { method: 'POST', path: '/logout', auth: 'user', handler: logout },
    { method: 'GET', path: '/auth/me', auth: 'user', handler: me },
  ],
  onActivate: (pluginCtx) => {
    ctx = pluginCtx;
    pluginCtx.logger.info('login: activated');
  },
  onDeactivate: (pluginCtx) => {
    ctx = null;
    pluginCtx.logger.info('login: deactivated');
  },
});

export default loginPlugin;
