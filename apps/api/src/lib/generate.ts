import { randomBytes } from 'node:crypto';

/** Generate a random URL-safe password of the given length. */
export function generatePassword(length = 24): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}
