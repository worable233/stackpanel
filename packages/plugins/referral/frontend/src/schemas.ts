import { z } from 'zod';

/**
 * 前端 finder 的响应 schema。
 *
 * 必须与后端 `packages/plugins/referral/src/index.ts` 的 `toCodeView` /
 * `toRecordView` / 7 条路由逐字对齐——BFF 的 finder 会 `schema.parse`，
 * 多一个字段少一个字段都会让页面读不到数据（而不是渲染出部分内容）。
 *
 * 账户页（服务端）与管理页（客户端）共用这些 schema，避免两处各写一份漂移。
 */

export const codeViewSchema = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  state: z.string(),
  rewardAmount: z.number(),
  signupCount: z.number(),
  createdAt: z.string(),
});

export const recordViewSchema = z.object({
  id: z.string(),
  code: z.string(),
  inviterId: z.string(),
  inviteeId: z.string(),
  inviteeEmail: z.string(),
  trigger: z.string(),
  inviterState: z.string(),
  inviteeState: z.string(),
  rewardAmount: z.number(),
  inviteeRewardAmount: z.number(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
});

export const mineSchema = z.object({
  config: z.object({
    enabled: z.boolean(),
    trigger: z.string(),
    rewardAmount: z.number(),
    inviteeRewardAmount: z.number(),
    cookieDays: z.number(),
    currency: z.string(),
  }),
  codes: z.array(codeViewSchema),
  invites: z.array(recordViewSchema),
  stats: z.object({
    totalInvites: z.number(),
    paidInvites: z.number(),
    earnedAmount: z.number(),
    balance: z.number(),
  }),
});

/** GET /store/admin/referrals：归因记录 + 推广人汇总（固定 page=1, pageSize=200）。 */
export const adminListSchema = z.object({
  total: z.number(),
  records: z.array(recordViewSchema.extend({ inviterEmail: z.string() })),
  inviters: z.array(
    z.object({
      inviterId: z.string(),
      inviterEmail: z.string(),
      paidAmount: z.number(),
    }),
  ),
  currency: z.string(),
});

/** GET /store/admin/referrals/config：完整 ReferralConfig。 */
export const adminConfigSchema = z.object({
  config: z.object({
    enabled: z.boolean(),
    trigger: z.string(),
    rewardAmount: z.number(),
    inviteeRewardAmount: z.number(),
    freezeDays: z.number(),
    cookieDays: z.number(),
    maxInvitesPerUser: z.number(),
    sameIpLimit: z.number(),
    currency: z.string(),
  }),
});

export type MineData = z.infer<typeof mineSchema>;
export type AdminListData = z.infer<typeof adminListSchema>;
export type AdminConfigData = z.infer<typeof adminConfigSchema>;
export type CodeView = z.infer<typeof codeViewSchema>;
export type RecordView = z.infer<typeof recordViewSchema>;
