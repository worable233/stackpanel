import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 推广插件自治数据模型（ADR-0008 / ADR-0009）。
 *
 * 约定：实体生命周期字段命名为 `state`（不是 `status`），这样
 * `ctx.extensions.updateWhere` 才能把「按状态条件原子变更」落到真实索引列；
 * `status` 在内核里被映射到内建状态列，不能拿来当业务字段做条件更新。
 */

/** 推广码：一个推广人可以持有多个码，用于区分渠道。 */
export const codeSchema = z.object({
  /** 推广人用户 id。 */
  ownerId: z.string(),
  /** 短码本身（大写字母数字），出现在 ?affid= 里。 */
  code: z.string(),
  /** 渠道备注，例如「微博」「给朋友的链接」。 */
  label: z.string().default(''),
  /** 生命周期：active | disabled。 */
  state: z.string().default('active'),
  /** 可空的单码奖励覆盖（分）；为 null 时用 referral/config 的默认值。 */
  rewardAmount: z.number().int().nullable().default(null),
  /**
   * 该码带来的成功注册数。
   *
   * 之所以把它声明成索引字段：内核 `extensions.updateWhere` 只允许 patch 已声明
   * 的索引字段（其余字段必须整行 `update`），而计数需要在并发注册下用 `inc`
   * 原子自增，不能读改写。
   */
  signupCount: z.number().int().default(0),
});

export const codeModel = defineModel({
  kind: 'referral/code',
  label: '推广码',
  schema: codeSchema,
  indexes: [
    { fields: ['code'], unique: true, types: { code: 'string' } },
    { fields: ['ownerId'], types: { ownerId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
    // 只为让 `inc` 原子自增可用；不作为查询条件使用。
    { fields: ['signupCount'], types: { signupCount: 'integer' } },
  ],
  // 刻意不声明 cacheTtlMs：停用（state=disabled）必须立刻生效，归因是写路径，
  // 任何陈旧读都可能给一个已被停用的渠道继续发奖。
});

/**
 * 归因记录：一条记录 = 一次有效邀请（邀请人 → 被邀请人）。
 *
 * `inviteeId` 唯一索引是「首次点击固定归因」的硬保证——同一个人永远只有一条
 * 归因记录，换设备重开链接也无法二次归因。
 */
export const recordSchema = z.object({
  code: z.string(),
  inviterId: z.string(),
  inviteeId: z.string(),
  inviteeEmail: z.string().default(''),
  /**
   * 发奖时点快照：register | first_order | register_frozen。
   *
   * 落到记录上而不是每次读当前配置，是因为配置随时可改；一条已经产生的归因必须
   * 按当时的规则结清，否则「注册后改配置」会让老记录永远悬着或突然被人领走。
   */
  trigger: z.string().default('first_order'),
  /** 推广人奖励状态：pending | paid | rejected。 */
  inviterState: z.string().default('pending'),
  /** 被邀请人奖励状态：none | paid。 */
  inviteeState: z.string().default('none'),
  /**
   * 冻结截止时间（epoch ms）；0 表示不等冻结。
   *
   * 注意：epoch ms ≈ 1.7e12，超出 PostgreSQL `integer`（int4，上限 2.1e9）范围。
   * 索引列必须声明为 `number`（double precision），否则写入直接 `out of range`、
   * 整条归因静默失败。与 store 插件的 `expiresAtMs` 同款处理。
   */
  freezeUntil: z.number().int().default(0),
  /** 实际发放的推广人奖励（分）。 */
  rewardAmount: z.number().int().default(0),
  /** 实际发放的被邀请人奖励（分）。 */
  inviteeRewardAmount: z.number().int().default(0),
  /** 注册来源 IP；用于同 IP 防刷判定。 */
  registerIp: z.string().default(''),
  /** 触发首单奖励的订单 id。 */
  qualifiedOrderId: z.string().nullable().default(null),
  qualifiedAt: z.string().nullable().default(null),
  paidAt: z.string().nullable().default(null),
});

export const recordModel = defineModel({
  kind: 'referral/record',
  label: '推广归因记录',
  schema: recordSchema,
  indexes: [
    { fields: ['inviteeId'], unique: true, types: { inviteeId: 'string' } },
    { fields: ['inviterId'], types: { inviterId: 'string' } },
    { fields: ['inviterState'], types: { inviterState: 'string' } },
    { fields: ['registerIp'], types: { registerIp: 'string' } },
    // epoch ms 必须用 `number`（double precision），int4 装不下（见字段注释）。
    { fields: ['freezeUntil'], types: { freezeUntil: 'number' } },
  ],
});

/**
 * 推广配置：单行模型，固定 `name = 'default'`。
 *
 * 内核 PluginContext 不向插件后端暴露插件设置（设置只声明在前端包），所以奖励
 * 金额、触发时点这些必须落库成插件自治模型；前端配置页通过管理端路由读写。
 */
export const configSchema = z.object({
  enabled: z.boolean().default(true),
  /** 发奖时点：register | first_order | register_frozen。 */
  trigger: z.string().default('first_order'),
  /** 推广人默认奖励（分）。 */
  rewardAmount: z.number().int().default(0),
  /** 被邀请人注册奖励（分）；0 表示不发。 */
  inviteeRewardAmount: z.number().int().default(0),
  /** register_frozen 的冻结天数。 */
  freezeDays: z.number().int().default(7),
  /** 归因有效期（天），仅用于前端提示文案。 */
  cookieDays: z.number().int().default(30),
  /** 单个推广人最多可成功邀请的人数；0 表示不限。 */
  maxInvitesPerUser: z.number().int().default(0),
  /** 允许的同一注册 IP 归因上限；超出则标 rejected。0 表示不限。 */
  sameIpLimit: z.number().int().default(1),
  currency: z.string().default('CNY'),
});

export const configModel = defineModel({
  kind: 'referral/config',
  label: '推广配置',
  schema: configSchema,
  indexes: [{ fields: ['enabled'], types: { enabled: 'boolean' } }],
  cacheTtlMs: 10_000,
});

export type ReferralCode = z.infer<typeof codeSchema>;
export type ReferralRecord = z.infer<typeof recordSchema>;
export type ReferralConfig = z.infer<typeof configSchema>;
