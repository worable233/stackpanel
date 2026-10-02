import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;
const MAX_N = 32768;
const MAX_R = 32;
const MAX_P = 4;

interface ScryptOptions {
  N: number;
  r: number;
  p: number;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
      } else {
        resolve(derivedKey as Buffer);
      }
    });
  });
}

interface PasswordParts {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseStored(stored: string): PasswordParts {
  const [scheme, n, rn, pn, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) {
    throw new Error('不支持的密码哈希格式');
  }
  const parsed = {
    N: Number(n),
    r: Number(rn),
    p: Number(pn),
    salt: Buffer.from(saltB64, 'base64'),
    hash: Buffer.from(hashB64, 'base64'),
  };
  if (
    !Number.isInteger(parsed.N) ||
    parsed.N < 2 ||
    parsed.N > MAX_N ||
    (parsed.N & (parsed.N - 1)) !== 0 ||
    !Number.isInteger(parsed.r) ||
    parsed.r < 1 ||
    parsed.r > MAX_R ||
    !Number.isInteger(parsed.p) ||
    parsed.p < 1 ||
    parsed.p > MAX_P ||
    parsed.salt.length < 16 ||
    parsed.hash.length < 32 ||
    parsed.hash.length > KEYLEN
  ) {
    throw new Error('无效的密码哈希参数');
  }
  return parsed;
}

/** Hash a password with scrypt. Format: scrypt$N$r$p$salt$hash (self-contained). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time verify of a password against a stored scrypt hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = parseStored(stored);
  const actual = await scryptAsync(password, parts.salt, parts.hash.length, {
    N: parts.N,
    r: parts.r,
    p: parts.p,
  });
  return actual.length === parts.hash.length && timingSafeEqual(actual, parts.hash);
}
