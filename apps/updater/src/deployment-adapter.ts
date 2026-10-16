/**
 * 部署适配器契约（PLAN-github-distribution-and-updates §5.1、§5.4）。
 *
 * updater 只操作**安装时绑定的 Compose project / 允许的服务与受管卷**；不执行包内
 * 任意 compose/shell hook（§5.1）。执行器仅通过本接口与宿主交互，便于：
 * - 在测试中注入假适配器，覆盖状态机、恢复、断电续跑（不碰真实 Docker）；
 * - 生产用 Docker/Compose 实现（独立镜像预置客户端）。
 *
 * 每个方法对应 §5.4 的一个步骤，返回该步的**完成凭据**（写入权威日志）。
 */

import type { UpdateTask } from '@stackpanel/spec';

export interface StepContext {
  task: UpdateTask;
  /** 目标内核镜像摘要（`@sha256` 引用，不用 latest）。 */
  targetDigest: string;
  /** 完整部署计划摘要。 */
  planDigest: string;
  /** 工作时目录（updater 独立卷；候选/快照/备份都放这里）。 */
  workDir: string;
}

export interface DeploymentAdapter {
  /** §5.4-1 下载候选镜像与包并校验；返回实际下载的引用。 */
  download(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-2 预检：generation 未变、版本兼容、DB/存储可达、备份目的地可写、磁盘空间。 */
  preflight(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-3 进入维护：拒绝新写入、撤流量、暂停调度与队列消费、排空在途。 */
  quiesce(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-4 备份数据库、包指针、实例配置引用与运行资源；返回备份引用。 */
  snapshot(ctx: StepContext): Promise<{ credential: string; backupRef: string }>;

  /** §5.4-5 用新镜像的**独立一次性**迁移任务执行 DB 迁移（锁保证单次）。 */
  migrate(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-6 把 API/Web/Worker 切到同一目标 release 集合。 */
  switchTo(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-7 维护态探针：依赖 readiness、schema、登录/权限、Web 资源、主题/插件、Worker 心跳。 */
  verify(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-8 提交：开启写入与队列消费、恢复入口。 */
  commit(ctx: StepContext): Promise<{ credential: string }>;

  /** §5.4-9 清理观察期资源（保留策略另见 GC）。 */
  cleanup(ctx: StepContext): Promise<{ credential: string }>;

  /**
   * 失败恢复（§6）。`stage` 给出失败发生处，适配器据「是否已迁移写入」决定：
   * 切回旧 digest / 恢复快照 / 兼容程序回退，**不得**在开放写入后自动恢复旧快照。
   *
   * - `migrated`：迁移步骤已执行（schema 可能已变）。
   * - `postWrite`：已提交并放行写入（committed 之后的失败）。此时禁止自动恢复旧快照
   *   （会丢新数据），只允许兼容程序回退或前向修复。
   */
  recover(
    ctx: StepContext,
    failure: { stage: string; detail: string; migrated: boolean; postWrite: boolean },
  ): Promise<{ recovered: boolean; credential: string; detail?: string }>;

  /**
   * 独立恢复入口（§5.2）限定动作：回退到**上一代**部署。由恢复入口在**持有执行权**
   * 且无在途升级时调用；与 {@link recover} 不同，它不绑定某次任务上下文，只按部署指针
   * 回切 previousDigest。可选：未配置的适配器不提供，入口据此返回「无能力」而非假成功。
   */
  rollbackToPrevious?(): Promise<{ ok: boolean; detail: string }>;

  /**
   * 独立恢复入口（§5.2）限定动作：对账现场——读取当前生效代次/digest 并做一次
   * readiness 探针。幂等，不改部署。可选，语义同上。
   */
  reconcile?(): Promise<{
    ok: boolean;
    generation: number;
    digest: string | null;
    detail: string;
  }>;
}
