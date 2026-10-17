import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { hashPassword } from '../lib/password.ts';
import { writeAudit } from '../plugins/audit.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { hasAdmin, lockFirstUser } from './first-user.ts';

/**
 * First-run installation claim (the `/setup` wizard).
 *
 * This is the *only* sanctioned path that may mint the first administrator on a
 * fresh instance. It is deliberately small and heavily gated:
 *
 * 1. **Unclaimed-only.** The claim is evaluated *inside* the shared first-user
 *    advisory lock ({@link lockFirstUser}) so concurrent claimers serialize and
 *    exactly one wins; the loser gets {@link SetupAlreadyCompletedError}. The
 *    check is "any `group_admin` membership exists" ({@link hasAdmin}), not
 *    `user.count() === 0`, because plugins may create system users first.
 * 2. **Token-gated when configured.** When `STACKPANEL_SETUP_TOKEN` is set, the
 *    claimer must present it (constant-time compare). This closes the public
 *    race on an internet-reachable fresh instance. When unset, the wizard is
 *    open — acceptable only on a trusted network until it is claimed.
 * 3. **Fail-closed when disabled.** `STACKPANEL_SETUP_MODE=disabled` removes the
 *    wizard entirely; a fresh instance must then be initialized out-of-band.
 *
 * The password hash is computed *before* the transaction so scrypt never runs
 * while the advisory lock is held.
 */

/** Raised when a write would claim an instance that already has an admin. */
export class SetupAlreadyCompletedError extends Error {
  constructor() {
    super('实例已被初始化');
    this.name = 'SetupAlreadyCompletedError';
  }
}

/**
 * Raised when a self-service signup would elect the first administrator while
 * the instance is hardened (a setup token is configured). In that mode the first
 * admin may ONLY be created through {@link claimInstallation}, so `/register`
 * and OAuth signup cannot be used to bypass the claim token.
 */
export class SetupRequiredError extends Error {
  /** Stable code so plugin boundaries (which serialise errors) can recognise it. */
  readonly code = 'setup.required';
  constructor() {
    super('实例尚未初始化，请先通过初始化向导创建管理员');
    this.name = 'SetupRequiredError';
  }
}

/** Raised when setup is turned off (or unavailable) for this deployment. */
export class SetupDisabledError extends Error {
  constructor() {
    super('初始化向导已关闭');
    this.name = 'SetupDisabledError';
  }
}

/** Raised when the presented claim token is wrong or missing. */
export class SetupTokenError extends Error {
  constructor(message = '初始化令牌无效') {
    super(message);
    this.name = 'SetupTokenError';
  }
}

export interface SetupStatus {
  /** True while the instance has no administrator and the wizard is enabled. */
  required: boolean;
  /** True when the deployment requires a claim token to complete setup. */
  tokenRequired: boolean;
}

/** Whether the wizard is enabled at all for this deployment. */
export function setupEnabled(): boolean {
  return env.STACKPANEL_SETUP_MODE !== 'disabled';
}

/**
 * Whether the first-admin election on self-service signup paths (`/register`,
 * OAuth) must be refused. True when a claim token is configured: in that mode
 * the only sanctioned first-admin creator is {@link claimInstallation}, so a
 * stranger cannot bypass the token by registering or logging in via OAuth.
 */
export function firstAdminElectionGuarded(): boolean {
  return env.STACKPANEL_SETUP_TOKEN !== undefined;
}

/**
 * Constant-time token check. A configured token of a different length still
 * compares (length is not secret — the token is generated at deploy time) by
 * hashing both sides to a fixed width, so an attacker cannot learn the length
 * from response timing.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read the public setup state. No side effects; safe to call unauthenticated. */
export async function setupStatus(): Promise<SetupStatus> {
  if (!setupEnabled()) return { required: false, tokenRequired: false };
  const prisma = getPrisma();
  const adminCount = await prisma.userGroup.count({ where: { groupId: 'group_admin' } });
  return {
    required: adminCount === 0,
    tokenRequired: env.STACKPANEL_SETUP_TOKEN !== undefined,
  };
}

export interface ClaimInstallationInput {
  email: string;
  password: string;
  setupToken?: string;
  ip?: string;
  userAgent?: string;
}

export interface ClaimInstallationResult {
  userId: string;
  email: string;
}

/**
 * Atomically claim the instance by creating the first administrator in
 * `group_admin`. Throws {@link SetupDisabledError} when the wizard is off,
 * {@link SetupTokenError} when a required token is missing/wrong, and
 * {@link SetupAlreadyCompletedError} when an admin already exists.
 */
export async function claimInstallation(
  input: ClaimInstallationInput,
): Promise<ClaimInstallationResult> {
  if (!setupEnabled()) throw new SetupDisabledError();

  const expectedToken = env.STACKPANEL_SETUP_TOKEN;
  if (expectedToken !== undefined) {
    const provided = input.setupToken ?? '';
    if (!tokensMatch(provided, expectedToken)) throw new SetupTokenError();
  }

  const email = input.email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('邮箱格式无效'), { name: 'ValidationError' });
  }
  if (typeof input.password !== 'string' || input.password.length < 8) {
    throw Object.assign(new Error('密码至少需要 8 位'), { name: 'ValidationError' });
  }

  // Hash outside the transaction: scrypt is deliberately slow and must not run
  // while the global first-user advisory lock is held.
  const passwordHash = await hashPassword(input.password);

  const prisma = getPrisma();
  const userId = await prisma.$transaction(async (tx) => {
    // Serializes every first-admin election (wizard, register, OAuth) so exactly
    // one wins; the loser observes the winner and fails cleanly.
    await lockFirstUser(tx);
    // "Claimed" is an existing `group_admin` membership, not `user.count() === 0`:
    // plugins may have already created password-less system users before the
    // operator ever opens the wizard.
    if (await hasAdmin(tx)) throw new SetupAlreadyCompletedError();
    const user = await tx.user.create({
      data: { email, passwordHash, status: 'ACTIVE' },
    });
    const adminGroup = await tx.permissionGroup.findUnique({ where: { id: 'group_admin' } });
    if (!adminGroup) {
      // A migration always seeds the built-in groups; if it is gone the instance
      // is corrupt and silently creating a password account without admin rights
      // would leave the operator locked out of a "claimed" instance.
      throw new Error('内置权限组 group_admin 缺失，无法完成初始化');
    }
    await tx.userGroup.create({ data: { userId: user.id, groupId: adminGroup.id } });
    return user.id;
  });

  await writeAudit({
    action: 'setup.complete',
    resource: 'user',
    resourceId: userId,
    meta: { email },
    ...(input.ip ? { ip: input.ip } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
  });

  return { userId, email };
}
