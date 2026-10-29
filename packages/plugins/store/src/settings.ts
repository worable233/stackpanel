import { z } from 'zod';
import type { HttpRequest } from '@stackpanel/sdk';
import { context } from './context';
import { StoreError } from './errors';
import { auditActor, recordStoreAudit } from './audit';
import { DEFAULT_REFUND_POLICY } from './refund-policy';
import type { RefundPolicy } from './refund-policy';

/**
 * 退款政策（后台可配）。
 *
 * 运营能定四件事：能不能退（开关）、什么时候之前能退（窗口，含「永久」和「禁止」）、
 * 退多少（全额 / 按未使用时长比例 + 手续费）、以及流程怎么走（申请即停用、
 * 通过后向上游停服）。
 */
const refundPolicySchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_REFUND_POLICY.enabled),
    windowDays: z.number().int().min(0).max(3650).nullable().default(DEFAULT_REFUND_POLICY.windowDays),
    amountMode: z.enum(['full', 'prorated']).default(DEFAULT_REFUND_POLICY.amountMode),
    feePercentBps: z.number().int().min(0).max(10_000).default(DEFAULT_REFUND_POLICY.feePercentBps),
    suspendOnRequest: z.boolean().default(DEFAULT_REFUND_POLICY.suspendOnRequest),
    terminateOnApprove: z.boolean().default(DEFAULT_REFUND_POLICY.terminateOnApprove),
    oncePerOrder: z.boolean().default(DEFAULT_REFUND_POLICY.oncePerOrder),
  })
  .strict();

const schema = z
  .object({
    provisioningMode: z.enum(['manual', 'automatic']),
    /**
     * 旧数据只有 `provisioningMode`：缺失时整块退回默认值（默认**关闭**退款），
     * 升级不会给存量部署凭空打开一个花钱的入口。
     */
    refund: refundPolicySchema.default(DEFAULT_REFUND_POLICY),
  })
  .strict();

export type StoreSettings = z.infer<typeof schema>;

const key = 'store-provisioning-policy';

export async function storeSettings(): Promise<StoreSettings> {
  const saved = await context().secrets.get(key);
  if (saved == null) return { provisioningMode: 'manual', refund: DEFAULT_REFUND_POLICY };
  try {
    const parsed = schema.safeParse(JSON.parse(saved));
    if (parsed.success) return parsed.data;
  } catch {
    // 存储里是坏 JSON：落到下面的 fail-closed 默认值，而不是让设置页整个 500。
  }
  // 存量数据可能带已废弃字段：解析失败时保留开通方式、退款退回默认，不让整个
  // 后台设置页因为一条旧记录打不开。
  return { provisioningMode: 'manual', refund: DEFAULT_REFUND_POLICY };
}

/** 只读退款政策（生命周期各处用）。 */
export async function refundPolicy(): Promise<RefundPolicy> {
  return (await storeSettings()).refund;
}

export async function saveStoreSettings(req: HttpRequest): Promise<unknown> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // 局部更新：后台可能只提交退款政策（或只提交开通方式），缺的部分沿用现值。
  const current = await storeSettings();
  const merged = {
    provisioningMode: body['provisioningMode'] ?? current.provisioningMode,
    refund:
      body['refund'] === undefined
        ? current.refund
        : { ...current.refund, ...(body['refund'] as Record<string, unknown>) },
  };
  const parsed = schema.safeParse(merged);
  if (!parsed.success) throw new StoreError(400, '设置无效');
  await context().secrets.set(key, JSON.stringify(parsed.data));
  await recordStoreAudit({
    action: 'store.settings.updated',
    resource: 'store/settings',
    ...auditActor(req),
    // 审计 meta 只接受扁平标量，嵌套的退款政策序列化后写入。
    meta: { provisioningMode: parsed.data.provisioningMode, refund: JSON.stringify(parsed.data.refund) },
  });
  return parsed.data;
}
