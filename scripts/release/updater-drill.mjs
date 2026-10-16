#!/usr/bin/env node
/**
 * 干净机器升级链路**离线端到端演练**（PLAN-github-distribution-and-updates §13-7）。
 *
 * 目标：在没有真实 Docker 宿主、也不接触网络的情况下，把「声明式升级任务 → 独立执行器
 * → 九步状态机 → 失败恢复」整条链跑一遍，作为可重放证据。它用的是**真实**
 * `UpdateEngine` + **真实** `ComposeDeploymentAdapter` + **真实** 部署指针/快照存储/日志，
 * 只把宿主命令执行（`docker`/`compose`/`pg_*`）换成可注入的假 runner，并注入一个恒真探针。
 *
 * 覆盖四个场景：
 *   A. 成功路径：queued→…→committed，部署指针 generation 递增，摘要落到目标。
 *   B. 迁移**前**失败：允许解除维护并恢复原消费者 → recovered。
 *   C. 迁移**后**失败（未放行写入）：识别快照并恢复数据库 + 回退旧 digest → recovered。
 *   D. 已提交后（postWrite）失败：**禁止**自动恢复旧快照（§6）→ recovery_failed。
 *
 * 真实 Docker/Compose + 真机 + 发布镜像的端到端验收仍属 §13-7，需 `--real` 与宿主前提，
 * 本脚本在无 Docker 时只做离线证据并显式说明未验收的部分。
 *
 * 用法：
 *   node scripts/release/updater-drill.mjs            # 离线演练（CI 可跑）
 *   node scripts/release/updater-drill.mjs --real     # 真机（需 Docker + 已发布镜像）
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DRILL_ENTRY = path.join(REPO_ROOT, 'apps', 'updater', 'dist', 'drill.js');

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

async function loadDrill() {
  if (!existsSync(DRILL_ENTRY)) {
    throw new Error(
      `未找到 ${path.relative(REPO_ROOT, DRILL_ENTRY)}；请先运行 pnpm --filter @stackpanel/updater build`,
    );
  }
  return import(pathToFileURL(DRILL_ENTRY).href);
}

const TARGET_DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD_DIGEST = `sha256:${'b'.repeat(64)}`;

/** 造一个绑定配置（值本身无所谓，假 runner 不会真的执行 docker）。 */
function composeConfig(projectDir, backupDir) {
  return {
    projectName: 'sp-drill',
    projectDir,
    composeFiles: ['docker-compose.yml'],
    services: { api: 'api', worker: 'worker', web: 'web' },
    imageEnv: 'STACKPANEL_IMAGE',
    imageRepository: 'ghcr.io/worable233/stackpanel',
    allowedServices: ['api', 'worker', 'web'],
    database: { service: 'db', user: 'stackpanel', name: 'stackpanel' },
    probes: { readinessUrl: 'http://api:3001/health' },
    backupDir,
  };
}

function makeTask(overrides = {}) {
  return {
    protocolVersion: 1,
    instanceId: 'drill-instance',
    baselineGeneration: 0,
    targetDigest: TARGET_DIGEST,
    planDigest: 'plan-digest',
    idempotencyKey: 'drill-key',
    policyVersion: 1,
    plan: {
      kernel: { version: '0.3.0', digest: TARGET_DIGEST, migration: 'm-0.3.0' },
      packages: [],
      planDigestInput: {
        kernelVersion: '0.3.0',
        packages: [],
        frontendAbi: '1',
        schemaRange: '*',
      },
    },
    createdAt: '2026-10-17T00:00:00Z',
    ...overrides,
  };
}

/**
 * 假命令执行器：记录所有命令，按 `failOn` 谓词对某条命令返回失败。
 * 也模拟 `docker image inspect` 返回目标摘要、`pg_dump` 写 stdoutFile。
 *
 * 遵循真实契约：`allowNonZeroExit` 的命令即便返回非零也不抛错（用于「预期失败」的
 * 探测/恢复命令），只有非豁免命令才以 {@link drill.CommandError} 拒绝。
 */
function makeRunner({ failOn } = {}) {
  const calls = [];
  const runner = {
    async run(request) {
      const flat = [request.file, ...request.args].join(' ');
      calls.push(flat);
      const failure = failOn?.(request);
      if (failure) {
        // `allowNonZeroExit` 只豁免「非零退出码」，不豁免 spawn 级失败（如超时/找不到
        // 可执行文件）。用 `failure.spawnError` 标记后者。
        if (request.allowNonZeroExit && !failure.spawnError) {
          return { code: 1, stdout: '', stderr: failure.message };
        }
        return Promise.reject(failure);
      }
      let stdout = '';
      if (
        request.file === 'docker' &&
        request.args[0] === 'image' &&
        request.args[1] === 'inspect'
      ) {
        stdout = `${request.args[request.args.length - 1].split('@')[0]}@${TARGET_DIGEST}`;
      }
      if (request.file === 'df') {
        // 第 4 列 = 可用 KB（给足空间）。
        stdout =
          'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10000000 1 9999999 1% /';
      }
      if (request.stdoutFile) {
        await writeFile(request.stdoutFile, 'PGDUMP');
      }
      return { code: 0, stdout, stderr: '' };
    },
  };
  return { runner, calls };
}

function deploymentAdapterFactory(drill, { stateDir, projectDir, backupDir, runner }) {
  return new drill.ComposeDeploymentAdapter({
    config: composeConfig(projectDir, backupDir),
    runner,
    stateDir,
    // 恒真探针：离线演练不真的做 HTTP。
    probe: async () => true,
  });
}

async function scenarioSuccess(drill, root) {
  console.log('\n场景 A：成功路径（queued → committed）');
  const stateDir = path.join(root, 'A-state');
  const projectDir = path.join(root, 'A-project');
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const { runner, calls } = makeRunner();
  const adapter = deploymentAdapterFactory(drill, {
    stateDir,
    projectDir,
    backupDir: path.join(stateDir, 'backups'),
    runner,
  });
  const journal = new drill.FileUpdateJournal(path.join(stateDir, 'journal.jsonl'));
  const lock = new drill.ExecutorLock({ filePath: path.join(stateDir, 'lock'), owner: 'drill' });
  const engine = new drill.UpdateEngine({ adapter, journal, lock, workDir: stateDir });
  const result = await engine.run(makeTask());
  assert(result.phase === 'committed', `引擎推进到 committed（实际 ${result.phase}）`);
  const pointer = await drill.FileDeploymentPointer.resolve(stateDir).read();
  assert(pointer?.generation === 1, `部署指针 generation = 1（实际 ${pointer?.generation}）`);
  assert(pointer?.digest === TARGET_DIGEST, '部署指针 digest = 目标摘要');
  assert(
    calls.some((c) => c.includes('pull')),
    '执行了 docker pull 候选镜像',
  );
  assert(
    calls.some((c) => c.includes('pg_dump')),
    '执行了数据库备份（pg_dump）',
  );
  const phases = (await journal.forTask('drill-instance:drill-key')).map((e) => e.phase);
  for (const phase of [
    'downloading',
    'snapshotting',
    'migrating',
    'switching',
    'verifying',
    'committed',
    'cleanup',
  ]) {
    assert(phases.includes(phase), `权威日志记录阶段 ${phase}`);
  }
}

async function scenarioPreMigrationFailure(drill, root) {
  console.log('\n场景 B：迁移前失败（允许解除维护并恢复原消费者）');
  const stateDir = path.join(root, 'B-state');
  const projectDir = path.join(root, 'B-project');
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const { runner } = makeRunner({
    // 精确失败在一次性迁移任务上（`compose run … migrate:deploy`），而非任意命令。
    failOn: (req) =>
      req.args.includes('migrate:deploy')
        ? new drill.DeploymentAdapterError('迁移任务失败', 'migrating')
        : undefined,
  });
  const adapter = deploymentAdapterFactory(drill, {
    stateDir,
    projectDir,
    backupDir: path.join(stateDir, 'backups'),
    runner,
  });
  const journal = new drill.FileUpdateJournal(path.join(stateDir, 'journal.jsonl'));
  const lock = new drill.ExecutorLock({ filePath: path.join(stateDir, 'lock'), owner: 'drill' });
  const engine = new drill.UpdateEngine({ adapter, journal, lock, workDir: stateDir });
  const result = await engine.run(makeTask({ idempotencyKey: 'pre-mig' }));
  assert(result.phase === 'recovered', `迁移前失败 → recovered（实际 ${result.phase}）`);
  const pointer = await drill.FileDeploymentPointer.resolve(stateDir).read();
  assert(pointer === null, '迁移前失败未推进部署指针');
}

async function scenarioPostMigrationFailure(drill, root) {
  console.log('\n场景 C：迁移后失败（识别快照 + 恢复数据库 + 回退旧 digest）');
  const stateDir = path.join(root, 'C-state');
  const projectDir = path.join(root, 'C-project');
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  // 预置一个已部署的旧代次。
  await drill.FileDeploymentPointer.resolve(stateDir).write({
    generation: 1,
    digest: OLD_DIGEST,
    previousDigest: null,
    previousGeneration: null,
    updatedAt: '2026-10-16T00:00:00Z',
  });
  const { runner, calls } = makeRunner({
    // 精确失败在切换（`compose up -d …`），而非恢复时的回退 `up -d`（后者 allowNonZeroExit）。
    failOn: (req) =>
      req.file === 'docker' && req.args.includes('up') && req.args.includes('-d')
        ? new drill.DeploymentAdapterError('切换失败', 'switching')
        : undefined,
  });
  const adapter = deploymentAdapterFactory(drill, {
    stateDir,
    projectDir,
    backupDir: path.join(stateDir, 'backups'),
    runner,
  });
  const journal = new drill.FileUpdateJournal(path.join(stateDir, 'journal.jsonl'));
  const lock = new drill.ExecutorLock({ filePath: path.join(stateDir, 'lock'), owner: 'drill' });
  const engine = new drill.UpdateEngine({ adapter, journal, lock, workDir: stateDir });
  const result = await engine.run(makeTask({ idempotencyKey: 'post-mig', baselineGeneration: 1 }));
  assert(result.phase === 'recovered', `迁移后失败 → recovered（实际 ${result.phase}）`);
  assert(
    calls.some((c) => c.includes('pg_restore')),
    '识别到快照并执行 pg_restore 恢复数据库',
  );
  const pointer = await drill.FileDeploymentPointer.resolve(stateDir).read();
  assert(pointer?.digest === OLD_DIGEST, '部署指针回退到旧 digest');
}

async function scenarioPostWriteFailure(drill, root) {
  console.log('\n场景 D：已提交后失败（禁止自动恢复旧快照）');
  const stateDir = path.join(root, 'D-state');
  const projectDir = path.join(root, 'D-project');
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const { runner, calls } = makeRunner({
    failOn: (req) =>
      req.file === 'docker' && req.args[0] === 'image' && req.args[1] === 'prune'
        ? Object.assign(new drill.DeploymentAdapterError('清理失败', 'cleanup'), {
            // cleanup 命令带 allowNonZeroExit；用 spawn 级失败绕过该豁免（超时/无客户端）。
            spawnError: true,
          })
        : undefined,
  });
  const adapter = deploymentAdapterFactory(drill, {
    stateDir,
    projectDir,
    backupDir: path.join(stateDir, 'backups'),
    runner,
  });
  const journal = new drill.FileUpdateJournal(path.join(stateDir, 'journal.jsonl'));
  const lock = new drill.ExecutorLock({ filePath: path.join(stateDir, 'lock'), owner: 'drill' });
  const engine = new drill.UpdateEngine({ adapter, journal, lock, workDir: stateDir });
  const result = await engine.run(makeTask({ idempotencyKey: 'post-write' }));
  assert(
    result.phase === 'recovery_failed',
    `已提交后失败 → recovery_failed，不自动回退（实际 ${result.phase}）`,
  );
  assert(
    !calls.some((c) => c.includes('pg_restore')),
    '已放行写入后**未**执行 pg_restore（不丢新数据）',
  );
}

async function main() {
  const real = process.argv.includes('--real');
  const drill = await loadDrill();
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-updater-drill-'));
  try {
    await scenarioSuccess(drill, root);
    await scenarioPreMigrationFailure(drill, root);
    await scenarioPostMigrationFailure(drill, root);
    await scenarioPostWriteFailure(drill, root);
    console.log('\n离线演练通过：成功路径 + §6 三类失败恢复语义均符合预期。');
    if (!real) {
      console.log(
        '\n注：真实 Docker/Compose、真机干净安装与发布镜像的端到端验收（§13-7）尚未执行。\n' +
          '    在具备 Docker 与已发布镜像的宿主上以 `--real` 运行对应真机演练后再标记 ADR-0023 为 Accepted。',
      );
    }
  } finally {
    if (!process.argv.includes('--keep')) {
      await rm(root, { recursive: true, force: true });
    } else {
      console.log(`\n保留演练目录：${root}`);
    }
  }

  if (real) {
    console.log(
      '\n[--real] 真机模式尚未在本仓库内自动化：需绑定的 Compose project、已发布镜像与\n' +
        '    可回滚数据库。请按 apps/updater/README.md 在干净机器执行并归档证据。',
    );
  }
}

main().catch((error) => {
  console.error(`\n演练失败：${error.message}`);
  process.exitCode = 1;
});
