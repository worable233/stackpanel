import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 会员权益记录：一行 = 一次授予（订单 + 商品 + 用户 → 权限组）。
 *
 * 为什么不直接读 `user_groups`：内核的成员关系表不记录「谁授予的」。到期撤权时
 * 若无条件删除 `(userId, groupId)`，会把管理员手工授予的同组永久成员一并删掉——
 * 那是一次静默降权。本模型是撤销的**授权依据**：只有本插件记录过、且组上的到期
 * 时间与本记录一致时，才会被撤销。
 */
export const MEMBERSHIP_KIND = 'store-product-membership/grant';

export const membershipModel = defineModel({
  kind: MEMBERSHIP_KIND,
  label: '会员权益授予',
  schema: z.object({
    userId: z.string(),
    /** 授予的权限组 id（权益载体）。 */
    groupId: z.string(),
    /** 商品 id，便于按商品统计与售后核对。 */
    productId: z.string(),
    /** 来源订单 id（同一订单重复投递只应有一条记录）。 */
    orderId: z.string(),
    /** 权益起始时间（ISO 8601）。 */
    startsAt: z.string(),
    /** 权益到期时间（ISO 8601）；null = 永久会员。 */
    expiresAt: z.string().nullable(),
    /**
     * 到期时间的毫秒值，仅用于索引查询。
     *
     * Extension 引擎的 `gte/gt/lte/lt` 只支持数字字段，字符串日期无法做范围扫描，
     * 所以到期清扫必须靠这一列。永久会员（`expiresAt` 为 null）写 `null`，永不命中。
     */
    expiresAtMs: z.number().nullable(),
    /**
     * ACTIVE：权益有效；REVOKED：已撤销（到期清扫或管理员操作）。
     * 撤销后保留记录用于对账，不物理删除。
     */
    status: z.enum(['ACTIVE', 'REVOKED']).default('ACTIVE'),
    revokedAt: z.string().nullable().optional(),
    /** 撤销原因：expired / manual / replaced。 */
    revokeReason: z.enum(['expired', 'manual', 'replaced']).nullable().optional(),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['groupId'], types: { groupId: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['productId'], types: { productId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['expiresAtMs'], types: { expiresAtMs: 'number' } },
  ],
});

/** 与 {@link membershipModel} 的 zod schema 对齐。 */
export interface MembershipGrantData {
  userId: string;
  groupId: string;
  productId: string;
  orderId: string;
  startsAt: string;
  expiresAt: string | null;
  expiresAtMs: number | null;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt?: string | null;
  revokeReason?: 'expired' | 'manual' | 'replaced' | null;
}
