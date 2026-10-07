import { definePlugin, isPluginError, PluginError } from '@stackpanel/sdk';
import type { AuthUser, HttpReply, HttpRequest, PluginContext } from '@stackpanel/sdk';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
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

const register = handle(async (req: HttpRequest, reply: HttpReply) => {
  if (!(await allow('ip', req.ip ?? 'unknown', rateLimits().register))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
  const { email, password } = parsed.data;
  if (!(await allow('user', email.toLowerCase(), rateLimits().register))) {
    throw new PluginError('auth.rate_limited', 429, '尝试太频繁，请稍后再试');
  }
  let user: AuthUser;
  try {
    user = await auth().auth.registerUser({ email, password });
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
    meta: { provider: 'password' },
    ...(req.ip ? { ip: req.ip } : {}),
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

export const loginPlugin = definePlugin({
  manifest: {
    id: 'login',
    name: '登录插件',
    version: '0.1.0',
    description: '内置登录/注册插件：登录、注册与注销流程，验证与令牌签发由平台 ctx.auth 完成。',
  },
  routes: [
    { method: 'POST', path: '/login', auth: 'public', handler: login },
    { method: 'POST', path: '/register', auth: 'public', handler: register },
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
