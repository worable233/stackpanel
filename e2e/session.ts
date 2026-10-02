import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_BASE_URL, WEB_BASE_URL } from './constants';

const SESSION_FILE = path.join(process.cwd(), 'e2e', '.runtime.json');

interface SessionFile {
  email: string;
  token: string;
}

/**
 * Login against the API and persist the session token to disk, so the whole
 * suite reuses a single token instead of hammering the login endpoint (which
 * is rate-limited to 5 requests/minute per IP).
 */
export async function getAdminSessionToken(): Promise<string> {
  const cached = readCachedToken();
  if (cached) return cached;
  const token = await apiLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  const file: SessionFile = { email: ADMIN_EMAIL, token };
  writeFileSync(SESSION_FILE, JSON.stringify(file, null, 2));
  return token;
}

/** Cache the session token produced by global setup, if present. */
export function persistAdminSessionToken(token: string): void {
  const file: SessionFile = { email: ADMIN_EMAIL, token };
  writeFileSync(SESSION_FILE, JSON.stringify(file, null, 2));
}

function readCachedToken(): string | null {
  try {
    const file = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SessionFile;
    if (file.email !== ADMIN_EMAIL || typeof file.token !== 'string' || file.token.length === 0) {
      return null;
    }
    if (isJwtExpired(file.token)) return null;
    return file.token;
  } catch {
    // No cached session yet.
  }
  return null;
}

/** Decode the JWT payload and check its `exp` claim without verifying the signature. */
function isJwtExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return true;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (typeof decoded.exp !== 'number') return true;
    return decoded.exp < Date.now() / 1000;
  } catch {
    return true;
  }
}

async function apiLogin(email: string, password: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`API 登录失败（${email}）：${await response.text()}`);
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

/** Prepare an authenticated page by injecting the shared BFF session cookie. */
export async function authedPage(page: Page): Promise<void> {
  const token = await getAdminSessionToken();
  await page
    .context()
    .addCookies([
      { name: 'sp_session', value: token, url: WEB_BASE_URL, httpOnly: true, sameSite: 'Lax' },
    ]);
}
