import { env } from '../config/env.ts';
import { hashPassword } from './password.ts';
import { generatePassword } from './generate.ts';
import { writeAudit } from '../plugins/audit.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { isFirstUser } from '../auth/first-user.ts';

export interface BootstrapResult {
  created: boolean;
  email: string;
  generatedPassword?: string;
}

/**
 * Create the bootstrap ADMIN on first startup when no user exists.
 * Credentials come from env, or a random password is generated and returned
 * (caller logs it exactly once).
 *
 * The "is the DB empty?" check runs *inside* the transaction under the shared
 * first-user advisory lock (SECURITY-AUDIT-2026-10-04 L-4), so two replicas
 * booting simultaneously serialize: one creates the admin, the other observes
 * the new user and returns `created: false` instead of crashing on a unique
 * email violation or creating a duplicate admin.
 */
export async function ensureBootstrapAdmin(): Promise<BootstrapResult> {
  const prisma = getPrisma();

  // Fast path: a populated instance never bootstraps. This is only an
  // optimisation to skip scrypt + a transaction on the common path; the
  // authoritative election still happens inside the locked transaction below.
  if ((await prisma.user.count()) > 0) {
    return { created: false, email: '' };
  }

  const email = (env.STACKPANEL_BOOTSTRAP_EMAIL ?? 'admin@stackpanel.local').toLowerCase();
  const password = env.STACKPANEL_BOOTSTRAP_PASSWORD ?? generatePassword();
  const passwordHash = await hashPassword(password);

  const created = await prisma.$transaction(async (tx) => {
    if (!(await isFirstUser(tx))) return false;
    const user = await tx.user.create({
      data: { email, passwordHash, status: 'ACTIVE' },
    });
    // Grant the bootstrap admin the built-in admin group (RBAC).
    const adminGroup = await tx.permissionGroup.findUnique({ where: { id: 'group_admin' } });
    if (adminGroup) {
      await tx.userGroup.create({ data: { userId: user.id, groupId: adminGroup.id } });
    }
    return true;
  });

  if (!created) return { created: false, email: '' };

  await writeAudit({ action: 'bootstrap.create', resource: 'user', meta: { email } });

  return {
    created: true,
    email,
    ...(env.STACKPANEL_BOOTSTRAP_PASSWORD ? {} : { generatedPassword: password }),
  };
}
