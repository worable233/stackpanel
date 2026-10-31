import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from '../src/password.js';

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    expect(validatePassword('correct horse battery staple')).toEqual({ ok: true });
  });

  it('accepts non-ASCII passwords by code point count', () => {
    // 13 code points, but 39 UTF-8 bytes: byte length must not be the unit.
    expect(validatePassword('我的密码是这一段很长的句子')).toEqual({ ok: true });
  });

  it('accepts passphrases that happen to contain a common word', () => {
    expect(validatePassword('my password is a long sentence')).toEqual({ ok: true });
  });

  it('refuses passwords below the floor', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toEqual({
      ok: false,
      code: 'password.too_short',
    });
  });

  it('refuses whitespace-only input as too short', () => {
    expect(validatePassword(' '.repeat(PASSWORD_MIN_LENGTH + 2))).toEqual({
      ok: false,
      code: 'password.too_short',
    });
  });

  it('refuses passwords above the ceiling', () => {
    expect(validatePassword('a1'.repeat(PASSWORD_MAX_LENGTH))).toEqual({
      ok: false,
      code: 'password.too_long',
    });
    expect(validatePassword(`x${'a1'.repeat(PASSWORD_MAX_LENGTH)}`)).toEqual({
      ok: false,
      code: 'password.too_long',
    });
  });

  it('refuses decorated forms of a blocklisted password', () => {
    for (const candidate of ['Password1!', 'P@ssw0rd!!', 'pass-word-123', 'Welcome@123']) {
      expect(validatePassword(candidate), candidate).toEqual({
        ok: false,
        code: 'password.too_common',
      });
    }
  });

  it('refuses repetition and straight runs', () => {
    for (const candidate of ['aaaaaaaaaaaa', 'abababababab', '1234567890', 'qwertyuiop']) {
      expect(validatePassword(candidate), candidate).toEqual({
        ok: false,
        code: 'password.too_common',
      });
    }
  });

  it('refuses the account email and its local part', () => {
    expect(validatePassword('alice@example.com', { email: 'Alice@Example.com' })).toEqual({
      ok: false,
      code: 'password.matches_identity',
    });
    expect(validatePassword('alice-the-great-2024', { email: 'alice@example.com' })).toEqual({
      ok: false,
      code: 'password.matches_identity',
    });
  });

  it('does not treat a one-letter local part as an identity match', () => {
    expect(validatePassword('a-very-long-passphrase', { email: 'a@example.com' })).toEqual({
      ok: true,
    });
  });

  it('works without an email context', () => {
    expect(validatePassword('a-perfectly-fine-secret')).toEqual({ ok: true });
  });
});
