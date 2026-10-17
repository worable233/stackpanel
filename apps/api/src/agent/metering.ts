import { createHash } from 'node:crypto';
import { PluginError } from '@stackpanel/sdk';
import type { LlmProvider, LlmCompletionResult, LlmCompletionRequest, LlmCallOptions } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { agentDayStart, type AgentPolicy } from '../lib/agent-policy.ts';

/** Durable inference journal: a completed call replays; an unknown call never re-bills. */
export function journaledProvider(provider: LlmProvider, runId: string, actorId: string, caps: AgentPolicy): LlmProvider {
  return {
    id: provider.id, name: provider.name, listModels: () => provider.listModels(),
    complete: async (request: LlmCompletionRequest, options: LlmCallOptions): Promise<LlmCompletionResult> => {
      const db = getPrisma();
      const id = createHash('sha256').update(`model:${provider.id}:${options.callId}`).digest('hex');
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const existing = await db.agentOperation.findUnique({ where: { id } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new PluginError('agent.model_call_conflict', 409, '同一模型步骤的参数已变化');
        if (existing.status === 'DONE') return existing.result as unknown as LlmCompletionResult;
        throw new PluginError('agent.model_result_unknown', 409, '此前推理结果不明，已停止自动重试，请核对模型账单');
      }
      let reservation = 0;
      if (caps.budgetMinor !== null || caps.dailyBudgetMinor !== null) {
        const model = (await provider.listModels()).find((item) => item.id === request.model);
        const input = model?.inputPriceMinorPerMillion, output = model?.outputPriceMinorPerMillion;
        if (input === undefined || output === undefined || ![input, output].every((price) => Number.isFinite(price) && price >= 0)) {
          throw new PluginError('agent.pricing_unknown', 409, '模型未提供可靠费率，无法执行金额预算');
        }
        // UTF-8 bytes conservatively bound text tokens; include schemas and protocol overhead.
        const promptBound = Buffer.byteLength(JSON.stringify(request)) + 4096;
        reservation = Math.ceil((promptBound * input + (request.maxTokens ?? 4096) * output) / 1_000_000);
        if (!Number.isSafeInteger(reservation) || reservation > 2147483647) throw new PluginError('agent.budget_invalid', 422, '预留金额超出允许范围');
        const current = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
        const family = await db.agentRun.findMany({ where: { OR: [{ id: current.rootId ?? current.id }, { rootId: current.rootId ?? current.id }] }, select: { id: true } });
        const [run, daily] = await Promise.all([
          db.agentOperation.aggregate({ where: { runId: { in: family.map((row) => row.id) }, kind: 'model' }, _sum: { reservedMinor: true } }),
          db.agentOperation.aggregate({ where: { actorId, kind: 'model', createdAt: { gte: agentDayStart() } }, _sum: { reservedMinor: true } }),
        ]);
        if ((caps.budgetMinor !== null && (run._sum.reservedMinor ?? 0) + reservation > caps.budgetMinor) ||
          (caps.dailyBudgetMinor !== null && (daily._sum.reservedMinor ?? 0) + reservation > caps.dailyBudgetMinor)) {
          throw new PluginError('agent.budget_exhausted', 429, '剩余额度不足以预留本轮模型调用');
        }
      }
      await db.agentOperation.create({ data: { id, actorId, runId, kind: 'model', requestHash, reservedMinor: reservation } });
      // Keep STARTED on transport/DB failure: no unaudited retry after an unknown expense.
      const result = await provider.complete(request, options);
      if (!Number.isSafeInteger(result.costMinor) || result.costMinor < 0 || result.costMinor > 2147483647) throw new PluginError('agent.invalid_usage', 502, '模型返回无效费用');
      await db.agentOperation.update({ where: { id }, data: { status: 'DONE', result: result as unknown as object,
        costMinor: result.costMinor, reservedMinor: result.costMinor } });
      if (reservation > 0 && result.costMinor > reservation) throw new PluginError('agent.price_bound_broken', 502, '模型实际费用超出声明上限，已停止任务，请核对提供方定价');
      return result;
    },
  };
}
