import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '../src/lib/capability-registry.ts';
import {
  buildSnapshot,
  diffContracts,
  type ContractSnapshot,
} from '../src/lib/contract-snapshot.ts';
import {
  capabilityPaths,
  fromKernelCapability,
} from '../src/lib/openapi-contract.ts';

/**
 * Generate / check the OpenAPI contract snapshot (CONTRACT-SEC / G2).
 *
 * Usage:
 *   pnpm --filter @stackpanel/api contract:snapshot           # write/update the baseline
 *   pnpm --filter @stackpanel/api contract:snapshot -- --check  # fail on breaking changes
 *
 * The snapshot is a pure function of the kernel capability registry
 * (`lib/capability-registry.ts`) — no app boot, no database — so it runs in CI
 * without PostgreSQL and never drifts with whichever plugins happen to be
 * active. `app.ts` derives the live `/api/v1` doc from the same projection, so
 * the committed baseline always matches what the kernel serves.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(here, '..', 'contracts', 'openapi-v1.snapshot.json');

/** The canonical open-platform contract for this build. */
function currentSnapshot(): ContractSnapshot {
  const spec = capabilityPaths(CAPABILITIES.map(fromKernelCapability));
  return buildSnapshot(spec, 'v1');
}

async function readBaseline(): Promise<ContractSnapshot | null> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as ContractSnapshot;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const snapshot = currentSnapshot();

  if (!check) {
    await mkdir(path.dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`契约快照已写入：${path.relative(process.cwd(), BASELINE_PATH)}`);
    console.log(
      `  操作数：${Object.keys(snapshot.operations).length}，hash：${snapshot.hash.slice(0, 16)}`,
    );
    return;
  }

  const baseline = await readBaseline();
  if (!baseline) {
    console.error('缺少契约基线快照；先运行 contract:snapshot 生成。');
    process.exit(1);
  }
  if (baseline.formatVersion !== snapshot.formatVersion) {
    console.error(
      `契约快照格式版本不一致（基线 ${baseline.formatVersion}，当前 ${snapshot.formatVersion}）；` +
        '请更新基线并走接口变更流程（INTERFACES.md §5）。',
    );
    process.exit(1);
  }

  const diff = diffContracts(baseline, snapshot.operations);
  if (diff.added.length > 0) {
    console.log(`新增操作（兼容）：\n  ${diff.added.join('\n  ')}`);
  }
  if (diff.breaking.length > 0) {
    console.error('检测到破坏性契约变更：');
    for (const item of diff.breaking) {
      console.error(`  - [${item.kind}] ${item.method} ${item.path}：${item.detail}`);
    }
    console.error('如属预期，请更新基线快照并走接口变更流程（INTERFACES.md §5）。');
    process.exit(1);
  }
  console.log(`契约兼容检查通过（基线操作数：${Object.keys(baseline.operations).length}）。`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
