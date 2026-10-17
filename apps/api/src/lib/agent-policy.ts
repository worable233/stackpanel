import { z } from 'zod';
import type { AgentAutonomy } from '@stackpanel/sdk';

/** Finite defaults also bound a site-owner-funded fallback model. */
export const agentPolicySchema = z
  .object({
    autonomy: z.enum(['read', 'propose', 'act']).default('read'),
    maxSteps: z.number().int().min(1).max(200).default(50),
    maxRunSeconds: z.number().int().min(1).max(3600).default(600),
    budgetMinor: z.number().int().positive().max(2147483647).nullable().default(null),
    dailyBudgetMinor: z.number().int().positive().max(2147483647).nullable().default(null),
    dailySteps: z.number().int().min(1).max(10000).default(500),
    allowedModels: z.array(z.string().trim().min(1).max(191)).max(100).default([]),
    approvalNotify: z.string().min(1).max(191).nullable().default(null),
  })
  .strict();

export type AgentPolicy = z.infer<typeof agentPolicySchema>;
export const DEFAULT_AGENT_POLICY = agentPolicySchema.parse({});

export function policyFromProfile(profile: unknown): AgentPolicy {
  if (!profile || typeof profile !== 'object') return { ...DEFAULT_AGENT_POLICY };
  const row = profile as Record<string, unknown>;
  return agentPolicySchema.parse(
    Object.fromEntries(
      Object.keys(agentPolicySchema.shape).map((key) => [
        key,
        row[key] ?? DEFAULT_AGENT_POLICY[key as keyof AgentPolicy],
      ]),
    ),
  );
}

const rank: Record<AgentAutonomy, number> = { read: 0, propose: 1, act: 2 };
function minimum(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

/** Intersect a saved policy/request with the current administrative ceiling. */
export function restrictAgentPolicy(
  ceiling: AgentPolicy,
  request: Partial<AgentPolicy>,
): AgentPolicy {
  const requestedModels = request.allowedModels ?? [];
  const allowedModels =
    ceiling.allowedModels.length === 0
      ? requestedModels
      : requestedModels.length === 0
        ? ceiling.allowedModels
        : ceiling.allowedModels.filter((model) => requestedModels.includes(model));
  // An empty intersection is a deny-all sentinel, not the normal empty/unrestricted list.
  if (ceiling.allowedModels.length && requestedModels.length && !allowedModels.length) {
    allowedModels.push('__agent_no_allowed_model__');
  }
  return {
    ...ceiling,
    autonomy:
      request.autonomy && rank[request.autonomy] < rank[ceiling.autonomy]
        ? request.autonomy
        : ceiling.autonomy,
    maxSteps: Math.min(ceiling.maxSteps, request.maxSteps ?? ceiling.maxSteps),
    maxRunSeconds: Math.min(ceiling.maxRunSeconds, request.maxRunSeconds ?? ceiling.maxRunSeconds),
    budgetMinor: minimum(ceiling.budgetMinor, request.budgetMinor ?? null),
    dailyBudgetMinor: minimum(ceiling.dailyBudgetMinor, request.dailyBudgetMinor ?? null),
    dailySteps: Math.min(ceiling.dailySteps, request.dailySteps ?? ceiling.dailySteps),
    allowedModels,
  };
}

/** Shanghai natural-day boundary, independent of the API host timezone. */
export function agentDayStart(now = new Date()): Date {
  const offset = 8 * 3600_000;
  return new Date(Math.floor((now.getTime() + offset) / 86400_000) * 86400_000 - offset);
}
