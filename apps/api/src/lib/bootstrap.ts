import { env } from '../config/env.ts';
import { hashPassword } from './password.ts';
import { generatePassword } from './generate.ts';
import { writeAudit } from '../plugins/audit.ts';
import { getPrisma } from '../plugins/prisma.ts';

export interface BootstrapResult {
  created: boolean;
  email: string;
  generatedPassword?: string;
}

/**
 * Create the bootstrap ADMIN on first startup when no user exists.
 * Credentials come from env, or a random password is generated and returned
 * (caller logs it exactly once).
 */
export async function ensureBootstrapAdmin(): Promise<BootstrapResult> {
  const prisma = getPrisma();
  const count = await prisma.user.count();
  if (count > 0) {
    return { created: false, email: '' };
  }

  const email = (env.STACKPANEL_BOOTSTRAP_EMAIL ?? 'admin@stackpanel.local').toLowerCase();
  const password = env.STACKPANEL_BOOTSTRAP_PASSWORD ?? generatePassword();
  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, passwordHash, status: 'ACTIVE' },
    });
    // Grant the bootstrap admin the built-in admin group (RBAC).
    const adminGroup = await tx.permissionGroup.findUnique({ where: { id: 'group_admin' } });
    if (adminGroup) {
      await tx.userGroup.create({ data: { userId: user.id, groupId: adminGroup.id } });
    }
  });
  await writeAudit({ action: 'bootstrap.create', resource: 'user', meta: { email } });

  return {
    created: true,
    email,
    ...(env.STACKPANEL_BOOTSTRAP_PASSWORD ? {} : { generatedPassword: password }),
  };
}
