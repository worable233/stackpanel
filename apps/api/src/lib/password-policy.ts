import { PluginError, validatePassword, type PasswordIssueCode } from '@stackpanel/sdk';

/**
 * Kernel-side enforcement of the shared password policy.
 *
 * Every kernel surface that writes a password (register, change, admin reset,
 * open platform, setup wizard) calls this so the rule lives in exactly one
 * place: `validatePassword` in the SDK, which the web forms also use for their
 * hint. The message here is only a log/default; the interface renders
 * `error.<code>` (ADR-0012 §4), so the user always sees their own locale.
 */
const MESSAGES: Record<PasswordIssueCode, string> = {
  'password.too_short': '密码太短',
  'password.too_long': '密码太长',
  'password.too_common': '密码过于常见，请换一个',
  'password.matches_identity': '密码不能与邮箱相同或包含邮箱名',
};

/**
 * Throw a `PluginError` carrying the policy code when `password` is refused.
 *
 * @param password candidate plaintext
 * @param email the account's email, for the identity screen; omit when the
 *   account is not known yet (a new registration still passes it)
 */
export function assertPassword(password: string, email?: string | null): void {
  const check = validatePassword(password, { email: email ?? null });
  if (check.ok) return;
  throw new PluginError(check.code, 400, MESSAGES[check.code]);
}
