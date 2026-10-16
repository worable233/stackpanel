import { describe, expect, it } from 'vitest';
import {
  agentDayStart,
  DEFAULT_AGENT_POLICY,
  policyFromProfile,
  restrictAgentPolicy,
} from '../../src/lib/agent-policy.ts';

describe('agent policy ceilings', () => {
  it('does not allow requests to raise administrative autonomy or steps', () => {
    const policy = restrictAgentPolicy(
      { ...DEFAULT_AGENT_POLICY, maxSteps: 5 },
      { autonomy: 'act', maxSteps: 200 },
    );
    expect(policy.autonomy).toBe('read');
    expect(policy.maxSteps).toBe(5);
  });
  it('intersects saved and current restrictions without treating disjoint models as unrestricted', () => {
    const policy = restrictAgentPolicy(
      { ...DEFAULT_AGENT_POLICY, allowedModels: ['a'] },
      { allowedModels: ['b'] },
    );
    expect(policy.allowedModels).not.toContain('a');
    expect(policy.allowedModels).not.toHaveLength(0);
  });
  it('keeps stricter saved budgets and finite defaults for null legacy fields', () => {
    expect(
      restrictAgentPolicy({ ...DEFAULT_AGENT_POLICY, budgetMinor: 50 }, { budgetMinor: 10 })
        .budgetMinor,
    ).toBe(10);
    expect(policyFromProfile({ dailySteps: null }).dailySteps).toBe(500);
  });
  it('rolls the daily ledger at Shanghai midnight', () => {
    expect(agentDayStart(new Date('2026-10-17T16:01:00Z')).toISOString()).toBe(
      '2026-10-17T16:00:00.000Z',
    );
  });
});
