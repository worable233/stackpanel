/** RBAC role names shared across auth, routes, and the SDK contract. */
export type RoleName = 'ADMIN' | 'USER';

/** Whether `actual` is included in the allowed role list. */
export function hasRole(actual: RoleName, allowed: readonly RoleName[]): boolean {
  return allowed.includes(actual);
}
