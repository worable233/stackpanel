import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../src/lib/jwt.ts';

describe('jwt sessions (jose HS256)', () => {
  it('signs and verifies a session', async () => {
    const token = await signSession({ sub: 'u1', jti: 'j1' });
    const claims = await verifySession(token);
    expect(claims).toEqual({ sub: 'u1', jti: 'j1', admin: false });
  });

  it('round-trips an admin session', async () => {
    const token = await signSession({ sub: 'u2', jti: 'j2', admin: true });
    await expect(verifySession(token)).resolves.toMatchObject({ sub: 'u2', admin: true });
  });

  it('rejects a token with an invalid sub', async () => {
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('j1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(secret);
    await expect(verifySession(token)).rejects.toThrow('无效的会话载荷');
  });

  it('rejects an expired token', async () => {
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setJti('j1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(secret);
    await expect(verifySession(token)).rejects.toThrow();
  });
});
