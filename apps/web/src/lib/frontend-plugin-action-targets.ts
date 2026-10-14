import { z } from 'zod';

/**
 * Shape of the kernel's `GET /plugins/:id/action-targets` response.
 *
 * The endpoint exposes the active plugin's full route table (including GET
 * finder routes consumed by the same-origin BFF proxy), not just mutations.
 * The action executor only ever dispatches the mutation methods declared by
 * `PluginActionDefinition`, but it must accept every method the endpoint can
 * return: a narrower enum made the parse fail before the route match, which
 * silently turned every plugin save action into「网络请求失败」.
 *
 * Kept in a plain module (not the `'use server'` executor) so it stays unit
 * testable — a `'use server'` file may only export async functions.
 */
export const actionTargetsSchema = z.object({
  routes: z.array(
    z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']),
      path: z.string(),
      permission: z.string().optional(),
    }),
  ),
});
