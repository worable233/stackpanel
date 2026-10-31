import { randomBytes } from 'node:crypto';
import { validatePassword } from '@stackpanel/sdk';

/** Generate a random URL-safe password of the given length. */
export function generatePassword(length = 24): string {
  // The generator must satisfy the policy it feeds: a 24-character base64url
  // secret already does in practice, but "in practice" is exactly how a
  // one-in-a-million blocklist hit becomes a lockout nobody can reproduce.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomBytes(length).toString('base64url').slice(0, length);
    if (validatePassword(candidate).ok) return candidate;
  }
  throw new Error('无法生成符合密码策略的随机密码');
}
