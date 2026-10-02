import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/lib/password.ts';
import { getPrisma } from '../src/plugins/prisma.ts';

export interface TestUserOptions {
  /** Assign the user to the `admin` group (grants platform.admin + all plugin permissions). */
  admin?: boolean;
  /** Permission group ids to assign (defaults to `user` when not admin). */
  groupIds?: string[];
  status?: 'ACTIVE' | 'DISABLED';
}

/**
 * Create a user with the given permission groups (defaults to `user`), then log
 * in through the login plugin's `/login` endpoint. Returns the user record and
 * session token.
 */
export async function createTestUser(
  app: FastifyInstance,
  email: string,
  password = 'IntegrationPass123',
  options: TestUserOptions = {},
): Promise<{ token: string; userId: string }> {
  const prisma = getPrisma();
  const groupIds = options.groupIds ?? (options.admin ? ['group_admin'] : ['group_user']);
  const groups = groupIds.length > 0 ? groupIds : ['group_user'];
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      status: options.status ?? 'ACTIVE',
      groups: { create: groups.map((groupId) => ({ groupId })) },
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { email: email.toLowerCase(), password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`createTestUser: login failed (${login.statusCode}): ${login.body}`);
  }
  return { token: (login.json() as { token: string }).token, userId: user.id };
}

/** Alias kept for readability in admin tests. */
export async function createAdminUser(
  app: FastifyInstance,
  email: string,
  password = 'IntegrationPass123',
): Promise<{ token: string; userId: string }> {
  return createTestUser(app, email, password, { admin: true });
}
