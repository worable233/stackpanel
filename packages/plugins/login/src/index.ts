import { createHash } from 'node:crypto';
import { definePlugin, EXTENSION_POINTS, isPluginError, PluginError } from '@stackpanel/sdk';
import type {
  AuthUser,
  HttpReply,
  HttpRequest,
  NotificationTypeDefinition,
  PluginContext,
} from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 本插件发出的通知类型（`notification.type` 扩展点，供内核偏好目录展示）。
 * 安全提醒属重要但不涉密，用户可关闭（关闭后仅不再收到提醒，不影响登录本身）。
 */
export const LOGIN_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  {
    type: 'security.login',
    category: 'security',
    label: '管理员登录提醒',
    audience: 'admin',
    order: 10,
  },
  { type: 'security.new-device', category: 'security', label: '新设备登录提醒', order: 20 },
];

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * Challenge response for the `login` action. Guarded routes always declare the
   * field so the policy — not the request shape — decides whether it is required.
   */
  captchaToken: z.string().trim().min(1).max(4096).optional(),
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
const loginConfigSchema = z.object({
  registrationMethods: z.array(z.enum(['email', 'phone'])).min(1).max(2),
  emailVerificationRequired: z.boolean().default(false),
});
const LOGIN_CONFIG_KEY = 'login-config';

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

async function loginConfig(): Promise<{ registrationMethods: Array<'email' | 'phone'>; emailVerificationRequired: boolean }> {
  const saved = await auth().secrets.get(LOGIN_CONFIG_KEY);
  // Registration policy is managed from the administrator settings page.
  // Keep the first-run default deterministic and independent of deployment env.
  if (!saved) return { registrationMethods: ['email'], emailVerificationRequired: false };
  try {
    return loginConfigSchema.parse(JSON.parse(saved));
  } catch {
    return { registrationMethods: ['email'], emailVerificationRequired: false };
  }
}

function emailVerificationEnabled(config: { emailVerificationRequired: boolean }): boolean {
  return config.emailVerificationRequired && auth().identity.isDeliveryConfigured();
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

/** One-way fingerprint of the source, so a notice never persists a raw IP/UA. */
function sourceFingerprint(ip: string | undefined, userAgent: string | undefined): string {
  return createHash('sha256')
    .update(`${ip ?? 'unknown'}|${userAgent ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Security notice on a successful login (audit §5).
 *
 * Two signals, both deduped so a repeated visit from the same source stays
 * quiet rather than spamming the inbox:
 *   - the account holds an admin permission → always worth a "new admin
 *     sign-in" record;
 *   - a source (IP + User-Agent) not seen for this account in the observation
 *     window → a "new device / abnormal source" notice.
 *
 * Known sources are tracked in kernel shared state (Redis-ready) keyed by a
 * one-way fingerprint, so no raw IP is stored and multi-replica installs share
 * one view. Notification failure never blocks the login.
 */
async function notifySuccessfulLogin(input: {
  user: AuthUser;
  ip: string | undefined;
  userAgent: string | undefined;
}): Promise<void> {
  try {
    const { user } = input;
    const fingerprint = sourceFingerprint(input.ip, input.userAgent);
    const knownKey = `login:known-source:${user.id}:${fingerprint}`;
    const isKnownSource = (await auth().state.get(knownKey)) !== null;
    // Remember this source for 90 days; this is what makes a *repeat* login quiet.
    await auth().state.set(knownKey, '1', 90 * 24 * 60 * 60 * 1000);
    const isAdmin = await auth().auth.hasPermission(user.id, 'platform.admin');
    const source = input.ip ?? '未知来源';

    if (isAdmin) {
      await auth().notifications.upsert({
        userId: user.id,
        dedupeKey: `login:admin:${fingerprint}`,
        type: 'security.login',
        title: '管理员登录',
        body: `你的管理员账号刚刚从 ${source} 登录。如非本人操作，请立即修改密码并撤销会话。`,
        link: '/account',
      });
    }
    if (!isKnownSource && !isAdmin) {
      await auth().notifications.upsert({
        userId: user.id,
        dedupeKey: `login:new-source:${fingerprint}`,
        type: 'security.new-device',
        title: '新设备登录',
        body: `你的账号刚刚从新来源 ${source} 登录。如非本人操作，请立即修改密码并撤销会话。`,
        link: '/account',
      });
    }
  } catch (error) {
    // A security notice is advisory: never fail the login over it.
    auth().logger.warn(`login: security notice failed: ${String(error)}`);
  }
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
  // Credential stuffing is the reason this action exists, so the challenge is
  // enforced *before* `verifyPassword`: otherwise every rejected challenge still
  // answers "was that the right password?".
  await auth().captcha.enforce({
    token: parsed.data.captchaToken ?? '',
    action: 'login',
    ...(req.ip ? { remoteIp: req.ip } : {}),
  });
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
  await notifySuccessfulLogin({
    user,
    ip: req.ip ?? undefined,
    userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined,
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
  const configured = await loginConfig();
  if (!emailVerificationEnabled(configured)) {
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
  const configured = await loginConfig();
  if (!configured.registrationMethods.includes('email')) {
    throw new PluginError('auth.email_registration_disabled', 403, '邮箱注册已关闭');
  }
  if (!(await allow('user', email.toLowerCase(), rateLimits().register))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }

  // Human verification covers the register entry point.
  await auth().captcha.enforce({
    token: parsed.data.captchaToken ?? '',
    action: 'register',
    ...(ip ? { remoteIp: ip } : {}),
  });

  const requireVerification = emailVerificationEnabled(configured);
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
    if ((error as { code?: string }).code === 'setup.required') {
      throw new PluginError('auth.setup_required', 409, message);
    }
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
  const configured = await loginConfig();
  const captcha = auth().captcha;
  // Per-action widget configs for the actions this deployment actually guards.
  // Only non-`off` actions are listed: an anonymous caller needs the widgets it
  // will render, not a full map of the deployment's policy.
  const actionConfig = (action: string) => {
    const config = captcha.clientConfigFor(action);
    return { policy: captcha.policyFor(action), clientConfig: config };
  };
  const actions: Record<string, ReturnType<typeof actionConfig>> = {};
  for (const action of ['login', 'register', 'register_send_code', 'password_reset'] as const) {
    if (captcha.policyFor(action) === 'off') continue;
    actions[action] = actionConfig(action);
  }
  return {
    registrationMethods: configured.registrationMethods,
    // Public clients receive the effective policy. A saved requirement cannot
    // activate verification until a delivery extension is available.
    emailVerificationRequired: emailVerificationEnabled(configured),
    emailVerificationSupported: auth().identity.isDeliveryConfigured(),
    captcha: {
      mode: captcha.mode(),
      configured: captcha.isConfigured(),
      providerIds: captcha.providerIds(),
      clientConfig: captcha.clientConfig(),
      actions,
    },
  };
});

const adminConfig = handle(async (req, reply) => {
  if (!auth().secrets.isAvailable()) return reply.code(503).send({ error: '平台加密密钥未配置，无法保存登录配置' });
  const parsed = loginConfigSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: '至少选择一种注册方式' });
  if (parsed.data.emailVerificationRequired && !auth().identity.isDeliveryConfigured()) {
    return reply.code(400).send({ error: '当前没有可用的邮箱验证码发送插件，请先配置 SMTP 邮件' });
  }
  await auth().secrets.set(LOGIN_CONFIG_KEY, JSON.stringify(parsed.data));
  return loginConfig();
});

export const loginPlugin = definePlugin({
  manifest: {
    id: 'login',
    name: '登录插件',
    version: '0.2.0',
    permissions: ['platform.admin'],
    description:
      '内置登录/注册插件：登录、注册与注销流程，支持可选的注册邮箱验证与人机验证。验证与令牌签发由平台 ctx 完成。',
  },
  routes: [
    { method: 'POST', path: '/login', auth: 'public', handler: login },
    { method: 'POST', path: '/register', auth: 'public', handler: register },
    { method: 'POST', path: '/register/send-code', auth: 'public', handler: sendCode },
    { method: 'GET', path: '/auth/config', auth: 'public', handler: authConfig },
    {
      method: 'GET',
      path: '/login/admin/config',
      auth: 'admin',
      permission: 'platform.admin',
      handler: handle(async () => ({
        ...(await loginConfig()),
        emailVerificationSupported: auth().identity.isDeliveryConfigured(),
      })),
    },
    { method: 'POST', path: '/login/admin/config', auth: 'admin', permission: 'platform.admin', handler: adminConfig },
    { method: 'POST', path: '/logout', auth: 'user', handler: logout },
    { method: 'GET', path: '/auth/me', auth: 'user', handler: me },
  ],
  onActivate: (pluginCtx) => {
    ctx = pluginCtx;
    // 声明本插件发出的通知类型，供内核偏好目录展示（未声明不可关闭）。
    for (const def of LOGIN_NOTIFICATION_TYPES) {
      pluginCtx.registerExtension(EXTENSION_POINTS.notificationType, def);
    }
    pluginCtx.logger.info('login: activated');
  },
  onDeactivate: (pluginCtx) => {
    ctx = null;
    pluginCtx.logger.info('login: deactivated');
  },
});

export default loginPlugin;
