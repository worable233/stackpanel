import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.ts';

export interface SessionClaims {
  sub: string;
  jti: string;
  /** Edge-hint for the web proxy (first-line defense). Backend always re-checks permissions. */
  admin?: boolean;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

/** Sign a stateless JWT session (HS256). */
export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ admin: claims.admin ?? false })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + env.SESSION_TTL_SECONDS)
    .sign(secretKey());
}

/** Verify a JWT and return its session claims, or throw on any invalid input. */
export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
  const { sub, jti } = payload;
  if (typeof sub !== 'string' || typeof jti !== 'string') {
    throw new Error('无效的会话载荷');
  }
  return { sub, jti, admin: payload.admin === true };
}
