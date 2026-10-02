import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.ts';

describe('password hashing (scrypt)', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right');
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('rejects a malformed stored hash', async () => {
    await expect(verifyPassword('x', 'bcrypt$whatever')).rejects.toThrow();
  });

  it('rejects hashes with unsafe scrypt work factors', async () => {
    await expect(
      verifyPassword(
        'x',
        'scrypt$1048576$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ),
    ).rejects.toThrow('无效的密码哈希参数');
  });

  it('produces distinct hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });
});
