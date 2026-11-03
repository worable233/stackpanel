/**
 * 会话代为签发的短期运行凭证（B-2）。
 *
 * 独立成模块是为了让 `routes/agent.ts`（签发方）与 `agent/background.ts`
 * （清扫方）共享常量而不形成循环依赖 —— 后者已经被前者 import。
 */

/**
 * 短期 run token 的有效期。
 *
 * 内核 Agent 的设计前提是「每一条运行都归属于一把平台凭证」（`AgentRun.tokenId`
 * 非空、续跑要求同一把）。管理员在自己后台里发起任务时手贴一枚长期令牌，然后
 * 刷新页面再贴一次——把内部凭据当外部凭据用，既难用也扩大了泄露面。
 *
 * 这里改成：会话身份 → 后端签发一枚 5 分钟、audience = `agent-run` 的短命
 * `ApiToken`，`POST /runs` 消费它之后立刻置为 REVOKED。续跑/取消用同一枚令牌
 * （`requireOriginalAgentToken` 的语义因此仍然成立），但能力面比通用 `mcp.write`
 * 窄：只开放 `/api/v1/agent/*` 与内核自带的 `/api/v1/*` 能力路由。
 */
export const RUN_TOKEN_TTL_MS = 5 * 60_000;
export const RUN_TOKEN_AUDIENCE = 'agent-run';

/** 这枚短期令牌在任何 `/api/v1` 上生效（插件 raw/后台路由不在内）。 */
export const RUN_TOKEN_SCOPE = 'api.v1';
