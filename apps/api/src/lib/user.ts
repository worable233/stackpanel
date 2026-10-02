import type { User } from '@stackpanel/db';
import { getPrisma } from '../plugins/prisma.ts';

export type PublicUser = Omit<User, 'passwordHash'>;

/** Seeded admin group id. Not a `builtin` flag: the row is an ordinary group. */
export const ADMIN_GROUP_ID = 'group_admin';
/** Seeded default user group id. */
export const USER_GROUP_ID = 'group_user';

/**
 * Structurally load-bearing groups. Since the `builtin` column was dropped
 * (migration 20260821290000), every group is editable — but these two are
 * referenced by fixed id across the kernel (bootstrap, auth, plugin role
 * templates). Deleting one cascades its memberships and permissions away and
 * can lock every admin out, so the API refuses to delete them.
 */
export const STRUCTURAL_GROUP_IDS: readonly string[] = [ADMIN_GROUP_ID, USER_GROUP_ID];

/** Strip credentials from a user record before returning it over the API. */
export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

/**
 * Whether `userId` is the last *active* admin-group user. Disabled admins are
 * excluded so an active admin can clean up a disabled one without lockout.
 */
export async function isLastAdmin(userId: string): Promise<boolean> {
  const prisma = getPrisma();
  const activeAdmins = await prisma.userGroup.findMany({
    where: { groupId: ADMIN_GROUP_ID, user: { status: 'ACTIVE' } },
    select: { userId: true },
  });
  if (activeAdmins.length !== 1) return false;
  return activeAdmins[0]?.userId === userId;
}
