/**
 * Kernel-owned Agent runtime views and state vocabulary
 * (PLAN-agent-in-kernel §2.2 / §3.3 / §3.5).
 *
 * This file is deliberately **types only**. The Agent loop itself is a kernel
 * deep module (`AgentService.run/step/cancel/listForActor`, §3.2) that is not
 * part of the public SDK contract, and no `agent` member is added to
 * `PluginContext`: a plugin runtime's `ctx` is not request-scoped, so an Agent
 * run reached that way would carry no caller credential and become a privilege
 * escalation channel (the plan's anti-pattern #1). What is shared here is the
 * wire vocabulary the kernel API returns and the web UI renders.
 */

/** Lifecycle of one Agent run. */
export type AgentRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

/**
 * How much the Agent may do on its owner's behalf, within the credential's
 * scope (§2.2). `read` = read-only tools; `propose` = writes require approval
 * first; `act` = writes in scope execute directly. `autonomy` can only relax
 * "does a human have to click", never widen the permission intersection.
 * New agents default to `read`.
 */
export type AgentAutonomy = 'read' | 'propose' | 'act';

/** What one persisted step records (§3.3). */
export type AgentStepKind = 'assistant' | 'tool_call' | 'tool_result' | 'approval';

/** Decision state of a pending mutating action (§4.1). */
export type AgentApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/**
 * The window `budgetMinor` is measured over.
 *
 * `'daily'` rolls over on the natural calendar day, `'monthly'` on the natural
 * calendar month (Asia/Shanghai); the accumulated `spendMinor` resets at each
 * boundary. Decided by the Lead after the T1 report flagged the plan (§2.2)
 * as naming the field without enumerating its values.
 */
export type AgentBudgetWindow = 'daily' | 'monthly';

/** One run of the kernel Agent loop, as exposed to clients. */
export interface AgentRunView {
  parentId?: string | null;
  rootId?: string | null;
  depth?: number;
  id: string;
  /** Owner the run acts for; effective permissions are intersected with this. */
  actorId: string;
  /** The platform credential (`ApiToken`) that scopes the run. */
  tokenId: string;
  /** Natural-language goal the run was started with. */
  objective: string;
  status: AgentRunStatus;
  /**
   * Provider-facing model name (one of `AgentProfileView.allowedModels`).
   * `null` until the first model call for this run is issued.
   */
  model: string | null;
  /** Steps taken so far. */
  steps: number;
  /** Accumulated inference spend in minor units; business tool charges remain in their own ledgers. */
  spendMinor: number;
  tokensIn: number;
  tokensOut: number;
  /** Terminal failure text when `status` is `FAILED`; `null` otherwise. */
  error: string | null;
  /** `null` while the run is still `QUEUED`; set when it starts running. */
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** One persisted step of a run — the unit of audit and of resume (§3.3). */
export interface AgentStepView {
  id: string;
  runId: string;
  /** 0-based position within the run; drives the stable LLM `callId`. */
  index: number;
  kind: AgentStepKind;
  /** Tool name (`mcpToolName(capability.id)`) for tool/approval steps. */
  toolName: string | null;
  /** Tool arguments, as JSON; nullable in the store (`Json?`). */
  args: unknown;
  /** Tool result, or the assistant message text for `assistant` steps; `Json?`. */
  result: unknown;
  isError: boolean;
  tokensIn: number;
  tokensOut: number;
  costMinor: number;
  latencyMs: number;
  /** Set when this step is waiting on (or was) an approval decision. */
  approvalId?: string | null;
  createdAt: string;
}

/** A mutating action parked for a human decision (§4.1). */
export interface AgentApprovalView {
  id: string;
  runId: string;
  stepId: string;
  /** Platform capability the action would invoke. */
  capabilityId: string;
  /**
   * Tool arguments, verbatim. Nullable in the store (`Json?`) so "no parameters"
   * stays distinguishable from `{}`; TS `unknown` already admits `null`.
   */
  args: unknown;
  /**
   * Replay-safe key generated **before** the approval exists (§4.2) and reused
   * unchanged when the action executes, so an approval replay or an execution
   * retry cannot double-charge or double-refund.
   */
  idempotencyKey: string;
  status: AgentApprovalStatus;
  /** Who decided; `null` while `PENDING`. */
  decidedBy: string | null;
  decidedAt: string | null;
  /** Expiry after which the approval times out; `null` means no deadline. */
  expiresAt: string | null;
  /** Decision note, or the denial/expiry reason. */
  reason: string | null;
  createdAt: string;
}

/**
 * The one-to-one agent image attached to a credential (§2.2).
 *
 * There is no second key concept: an Agent's authority is exactly the
 * `ApiToken`'s scopes intersected with the owner's current permissions; this
 * profile only bounds and shapes how that authority is exercised (autonomy,
 * budgets, step/time caps, model allowlist, approval notification target).
 */
export interface AgentProfileView {
  id: string;
  /** The credential this profile belongs to (one-to-one). */
  apiTokenId: string;
  autonomy: AgentAutonomy;
  /** Per-calendar-day model spend cap in minor units; `null` = uncapped. */
  dailyBudgetMinor: number | null;
  /** Per-calendar-day step cap; `null` = uncapped. Over it, no new runs today. */
  dailySteps: number | null;
  /** Cumulative spend cap for a single run; `null` = uncapped. */
  budgetMinor: number | null;
  /** Window `budgetMinor` is measured over; `null` = uncapped/unset. */
  budgetWindow: AgentBudgetWindow | null;
  /** Maximum steps for a single run (runaway-loop guard). */
  maxSteps: number;
  /** Wall-clock cap for a single run. */
  maxRunSeconds: number;
  /** Model allowlist, in provider-facing names. Empty = no restriction. */
  allowedModels: string[];
  /** Who to notify when an approval is pending; `null` uses the owner. */
  approvalNotify: string | null;
  createdAt: string;
  updatedAt: string;
}
