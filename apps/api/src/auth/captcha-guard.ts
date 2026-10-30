import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaptchaAction } from '@stackpanel/sdk';

/**
 * Kernel route helper: run the captcha policy for one sensitive operation.
 *
 * Wrapping {@link CaptchaService.enforce} keeps every kernel call site to one
 * line and, more importantly, keeps the *ordering* rule in one obvious place:
 * this must be called **before** the credential check it guards (before
 * `verifyPassword`, before minting a token). Verifying afterwards would hand an
 * attacker a free password oracle — the "current password incorrect" branch —
 * on every attempt.
 *
 * `enforce` throws a deterministic `PluginError` (`auth.captcha_required` /
 * `auth.captcha_failed` / `auth.captcha_unavailable`), which the kernel's error
 * handler already renders as an RFC 9457 problem document.
 */
export async function guardCaptcha(
  app: FastifyInstance,
  request: FastifyRequest,
  action: CaptchaAction,
  token: string | undefined,
): Promise<void> {
  await app.captcha.enforce({
    token: token ?? '',
    action,
    ...(request.ip ? { remoteIp: request.ip } : {}),
  });
}

/**
 * Shared schema fragment for the optional challenge response.
 *
 * Declared once so every guarded route caps the token identically: the value is
 * echoed into a provider's `siteverify` request body, so an unbounded string is a
 * cheap amplification vector.
 */
export const captchaTokenSchema = z.string().trim().min(1).max(4096).optional();
