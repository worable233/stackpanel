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

describe('思考强度 (reasoning → maxTokens)', () => {
  /**
   * 界面上的「快速 / 均衡 / 深入 / 极高」一直只被存进 `AgentChatMessage.reasoning`，
   * 从来没有影响过运行：`stepOnce` 里 `maxTokens` 是写死的 4096。用户以为选了
   * 「极高」就得到更长的推理，实际「快速」和「极高」执行结果一模一样 —— 一个
   * 完全无效的控件。这些用例锁住它落到执行侧的唯一出口。
   */
  it('maps each effort level to a distinct output cap, ascending', async () => {
    const { reasoningMaxTokens } = await import('../../src/routes/agent.ts');
    const fast = reasoningMaxTokens('快速');
    const balanced = reasoningMaxTokens('均衡');
    const deep = reasoningMaxTokens('深入');
    const extreme = reasoningMaxTokens('极高');
    expect(fast).toBeLessThan(balanced);
    expect(balanced).toBeLessThan(deep);
    expect(deep).toBeLessThan(extreme);
    // 默认档必须与 `stepOnce` 的历史硬编码值一致，否则升级会悄悄改变老运行的行为。
    expect(balanced).toBe(4096);
  });

  it('keeps the default policy at the historical 4096 so nothing changes silently', () => {
    expect(DEFAULT_AGENT_POLICY.maxTokens).toBe(4096);
  });

  it('lets an administrator tighten the cap below what a request asks for', () => {
    // 请求想要 16384（极高），策略上限只有 4096 → 取小。
    const restricted = restrictAgentPolicy(
      { ...DEFAULT_AGENT_POLICY, maxTokens: 4096 },
      { maxTokens: 16384 },
    );
    expect(restricted.maxTokens).toBe(4096);
  });

  it('never lets a request raise the cap above the policy ceiling', () => {
    const restricted = restrictAgentPolicy(
      { ...DEFAULT_AGENT_POLICY, maxTokens: 8192 },
      { maxTokens: 32768 },
    );
    expect(restricted.maxTokens).toBe(8192);
  });
});
