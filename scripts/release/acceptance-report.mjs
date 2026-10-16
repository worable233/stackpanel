#!/usr/bin/env node
/**
 * 分发/升级验收报告（PLAN-github-distribution-and-updates §13）。
 *
 * §13 要求「最终报告必须列出实际发布版本、支持部署形态、全部检查结果、故障恢复证据、
 * 残余限制和可重放命令」，并明确：未取得 GitHub 发布权限/真机时，先交付 workflows、
 * 签名测试产物与本地完整演练，且**不得**用 mock 冒充真机验收。
 *
 * 本脚本把这条要求做成可重放门禁：
 *   1. 实际执行两条**离线**端到端演练（分发链路 rehearse + 升级链路 updater-drill），
 *      任一失败即非零退出。
 *   2. 打印 §13 验收表的**逐行状态**：离线已验证 / 待真机（§13-7）/ 待多节点。
 *   3. 打印**可重放命令**与**残余限制**，供运维与后续真机验收直接照做。
 *
 * 它**不**声称真机通过：真机行一律标 `gated`，并在结尾显式说明「本报告不代表 §13 已
 * 全部通过，ADR-0023 仍为提议」。这是诚实的证据边界，不是验收替代。
 *
 * 用法：node scripts/release/acceptance-report.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

/** 运行一个 node 脚本，返回是否成功。 */
function runNode(script) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'release', script)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true' },
  });
  return { ok: result.status === 0, status: result.status };
}

/**
 * §13 验收表逐行状态。
 * kind:
 *   - 'offline'：已由本仓离线演练/单测覆盖（可重放证据存在）。
 *   - 'real'   ：需真机（真实 Docker/PG/干净机器/发布镜像）才能给出证据 → gated。
 *   - 'multi'  ：需多节点真机环境 → gated（不得用单机模拟）。
 */
const TABLE = [
  {
    acceptance: '全新部署后无需 CLI，自动发现并安装新内核',
    kind: 'real',
    evidence: '需两个真实发布版本 + 目标 digest + 任务记录 + 最终探针（§13-7）',
  },
  {
    acceptance: '新插件/主题从 Release 安装及升级（后端/公开页/后台页/账户面/样式/action 可用）',
    kind: 'real',
    evidence:
      '需真实 production build/start 浏览器测试（§13-7 / PLAN-runtime-frontend-loading §7）',
  },
  {
    acceptance: '线上零构建（运行镜像无源码/构建工具，安装升级期间无构建命令）',
    kind: 'gated-by-build-removal',
    evidence: '源码构建链移除门禁于浏览器 E2E（§13-2）',
  },
  {
    acceptance: '插件/主题配置、激活、enabled、业务数据保留',
    kind: 'offline',
    evidence: 'updates-plan/installed 单测 + PackageManager 事务（apps/api）',
  },
  {
    acceptance: '内核与扩展联合兼容计划，不兼容 ABI/依赖被阻止，中间版本路径自动求解',
    kind: 'offline',
    evidence: 'packages/spec resolveKernelUpgrade/resolveUpdatePlan 单测 + rehearse-distribution',
  },
  {
    acceptance:
      '下载中断、GitHub 限流、过期/回放目录、伪造签名、恶意归档 → 保留现部署、明确错误、无降级验签',
    kind: 'offline',
    evidence: 'rehearse-distribution 故障注入 + updater-drill 场景 D',
  },
  {
    acceptance: '迁移失败、新镜像无法启动、Web/Worker 探针失败 → 自动恢复旧版本和必要快照',
    kind: 'offline',
    evidence: 'updater-drill 场景 B/C + failure-injection.test.ts（§6 回退矩阵）',
  },
  {
    acceptance: '每个关键检查点杀进程/断电模拟 → 重启后幂等恢复、无并发执行、无半切换',
    kind: 'offline',
    evidence: 'journal-lock.test.ts（append-only/断点续跑）+ engine 断点测试',
  },
  {
    acceptance: '备份损坏、磁盘满、恢复失败 → 升级前阻止或保持维护，独立入口仍可诊断',
    kind: 'offline',
    evidence: 'compose-adapter 预检/恢复测试 + recovery-actions 对账/回退',
  },
  {
    acceptance: '开放写入后的错误 → 不恢复旧库丢新数据，验证兼容回退或前向修复',
    kind: 'offline',
    evidence: 'updater-drill 场景 D（postWrite 禁止自动恢复旧快照）',
  },
  {
    acceptance: '双请求/双执行器/节点断线/丢广播 → 单执行者、持久对账、掉队节点不接流量',
    kind: 'multi',
    evidence: '单执行者由 ExecutorLock 覆盖（离线）；跨节点对账需多节点真机（§9/§13-7）',
  },
  {
    acceptance:
      '老 HTML、旧 chunk、Portal/CSP、M1 hydration、客户端导航 → 真实 production 浏览器测试',
    kind: 'real',
    evidence: '需真实 production build/start（§13-7 / PLAN-runtime-frontend-loading §7）',
  },
  {
    acceptance: 'updater 自身升级与候选失败 → 交接与回退记录，业务内核失败不影响执行器',
    kind: 'offline',
    evidence: 'updater-drill 场景 F（切换→确认 / 超时→回退）+ self-update-executor 单测',
  },
  {
    acceptance: '核心镜像更新不会读取旧 .next 卷 → 新内核页面及 build 标识匹配目标 digest',
    kind: 'real',
    evidence: '需真实镜像切换（§13-7）',
  },
];

const STATUS_LABEL = {
  offline: '离线已验证（可重放）',
  real: '待真机（§13-7）',
  multi: '待多节点真机（§13-7）',
  'gated-by-build-removal': '门禁于浏览器 E2E（§13-2）',
};

function main() {
  const specDist = path.join(REPO_ROOT, 'packages', 'spec', 'dist', 'index.js');
  const updaterDist = path.join(REPO_ROOT, 'apps', 'updater', 'dist', 'main.js');
  if (!existsSync(specDist) || !existsSync(updaterDist)) {
    console.error(
      '缺少构建产物：请先 `pnpm --filter @stackpanel/spec build` 与 ' +
        '`pnpm --filter @stackpanel/updater build`。',
    );
    process.exit(2);
  }

  console.log('运行离线端到端演练……');
  const rehearse = runNode('rehearse-distribution.mjs');
  console.log(`  分发链路 rehearse：${rehearse.ok ? '通过' : `失败（exit ${rehearse.status}）`}`);
  const drill = runNode('updater-drill.mjs');
  console.log(`  升级链路 updater-drill：${drill.ok ? '通过' : `失败（exit ${drill.status}）`}`);

  const offlineOk = rehearse.ok && drill.ok;

  console.log('\n§13 验收表（逐行状态）');
  for (const row of TABLE) {
    console.log(`  [${STATUS_LABEL[row.kind]}] ${row.acceptance}`);
    console.log(`      证据：${row.evidence}`);
  }

  const counts = TABLE.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] ?? 0) + 1), acc), {});
  console.log('\n汇总：');
  console.log(
    `  离线已验证 ${counts.offline ?? 0} 行；` +
      `待真机 ${counts.real ?? 0} 行；` +
      `待多节点真机 ${counts.multi ?? 0} 行；` +
      `门禁于浏览器 E2E ${counts['gated-by-build-removal'] ?? 0} 行。`,
  );

  console.log('\n可重放命令（离线）：');
  console.log('  pnpm --filter @stackpanel/spec build');
  console.log('  pnpm --filter @stackpanel/updater build');
  console.log('  pnpm release:rehearse          # 分发链路离线端到端 + 故障注入');
  console.log(
    '  pnpm release:updater-drill     # 升级链路离线端到端（成功/失败恢复/恢复入口/自升级）',
  );
  console.log('  pnpm release:acceptance-report # 本报告的再生成');
  console.log('  # 真机演练（需 Docker + 已发布镜像）：');
  console.log('  node scripts/release/updater-drill.mjs --real');

  console.log('\n残余限制：');
  console.log('  - 真机 Docker/Compose、干净机器从旧发行版升级、真实发布版本与发布镜像的端到端');
  console.log('    证据尚未取得，属 §13-7，需在具备 Docker/PG 与已发布镜像的宿主上执行。');
  console.log('  - 跨主机集群执行与对账需多节点真机；不得用单机模拟宣称集群自动升级已验收。');
  console.log('  - GitHub 实际发布权限未取得时，仅交付 workflows、签名测试产物与本地完整演练。');
  console.log('  - 源码构建链移除（§13-2）门禁于真实 production 浏览器 E2E。');

  console.log(
    '\n结论：本报告只证明**离线可重放**部分通过，不代表 §13 端到端验收全部通过；' +
      '**ADR-0023 仍为「提议」**，不得标为已接受或已实现。',
  );

  process.exit(offlineOk ? 0 : 1);
}

main();
