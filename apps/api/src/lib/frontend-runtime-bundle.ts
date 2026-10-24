import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HOST_FRONTEND_ABI_SLOTS } from '@stackpanel/spec';

/**
 * 插件 admin 产物的**浏览器可装载**变体（契约 02 §5、主计划 §5 阶段 4）。
 *
 * 浏览器没有 import map，裸说明符（`react`、`@stackpanel/ui`）无法解析，因此发布期
 * 会额外产出 `dist/admin.runtime.js`：同一份 bundle，但把每个宿主 ABI 说明符改写成
 * 同源受控适配器：
 *
 *   import { useState } from "react"
 *   → import { useState } from "/api/frontend-abi/react?names=useState"
 *
 * `?names=` 必须是**原始导入名**（`import { useState as useState4 }` 里的
 * `useState`），因为适配器按名逐项从宿主命名空间重导；写成本地别名会让浏览器报
 * `does not provide an export named ...`。
 *
 * ## 为什么内核需要这份逻辑
 *
 * `admin.runtime.js` 是发布期产物，只存在于用新构建流程产出的包里。早于运行期装载
 * 的安装（以及部分第三方包）只有 `dist/admin.js`，于是 `/plugins/frontends` 给出的
 * 版本化 URL 直接 404：
 *
 *   Failed to fetch dynamically imported module: .../dist/admin.runtime.js
 *
 * 内核对这类包**就地补齐** runtime 变体，把兼容性放在装载方，而不是要求每个已安装
 * 的包重新发布。补齐结果是 `dist/admin.js` 的确定性函数：同一输入必得同一字节，
 * revision 摘要因此稳定、不会每次请求抖动。
 */

/** 受控适配器前缀（与 `app/api/frontend-abi/[...slot]/route.ts` 对齐）。 */
export const HOST_ABI_ADAPTER_PREFIX = '/api/frontend-abi/';

const ADMIN_SOURCE = 'frontend/dist/admin.js';
const ADMIN_RUNTIME = 'frontend/dist/admin.runtime.js';
const MANIFEST = 'frontend/manifest.json';

/** 与 `frontend.ts` 的每文件上限一致；超限的派生产物无法物化为 revision。 */
const MAX_RUNTIME_BYTES = 1024 * 1024;

/** 相对/绝对/URL 说明符：不参与宿主 ABI 映射。 */
function isNonBareSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('data:') ||
    /^[a-z][a-z0-9+.-]*:/i.test(specifier)
  );
}

/**
 * 把裸说明符映射到宿主 ABI 槽：精确命中优先（`react/jsx-runtime`），否则取最长的
 * `slot + '/'` 前缀（`react-dom/client` → `react-dom`）。
 */
export function hostAbiSlotFor(specifier: string): string | null {
  let best: string | null = null;
  for (const slot of HOST_FRONTEND_ABI_SLOTS) {
    if (specifier === slot) return slot;
    if (specifier.startsWith(`${slot}/`) && (!best || slot.length > best.length)) best = slot;
  }
  return best;
}

/** 从 import/export 子句里取**原始**导入名（剔除 `default` 与 `as` 别名）。 */
export function importedNames(clause: string): Set<string> {
  const names = new Set<string>();
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (!braces) return names;
  for (const raw of (braces[1] ?? '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const aliased = /^(\S+)\s+as\s+\S+$/.exec(part);
    const original = aliased ? (aliased[1] ?? '') : part;
    if (!original || original === 'default') continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(original)) continue;
    names.add(original);
  }
  return names;
}

/**
 * 一条 `import`/`export ... from "<specifier>"` 语句。
 *
 * `[^;]*?` 允许子句跨行（esbuild 会把长命名列表折行），并在语句的 `;` 处停下，
 * 因此不会跨语句吞掉下一条的 `from`。同时覆盖 `import Default, { … }` 与
 * `export * from …`。
 */
const FROM_STATEMENT = /^[ \t]*((?:import|export)\b[^;]*?)\bfrom\s*(['"])([^'"\n]+)\2/gm;
/** 副作用导入 `import "specifier"`。 */
const SIDE_EFFECT_STATEMENT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
/** 动态导入 `import("specifier")`。 */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

function adapterSpecifier(slot: string, names: Iterable<string>): string {
  const sorted = [...names].sort();
  return sorted.length > 0
    ? `${HOST_ABI_ADAPTER_PREFIX}${slot}?names=${sorted.join(',')}`
    : `${HOST_ABI_ADAPTER_PREFIX}${slot}`;
}

/**
 * 把 `dist/admin.js` 改写为浏览器可装载的 `admin.runtime.js`。
 *
 * 返回 `null` 表示**不能安全派生**：存在无法映射到宿主 ABI 的裸说明符（发布者漏
 * 打包的第三方库，例如 `sonner`）。此时宁可不派生，也不要产出一个浏览器仍然解析
 * 不了的产物。
 */
export function rewriteHostAbiImports(source: string): string | null {
  const perSlot = new Map<string, Set<string>>();
  let unsafe = false;

  let out = source.replace(FROM_STATEMENT, (full, clause: string, quote: string, spec: string) => {
    if (isNonBareSpecifier(spec)) return full;
    const slot = hostAbiSlotFor(spec);
    if (!slot) {
      unsafe = true;
      return full;
    }
    let names = perSlot.get(slot);
    if (!names) {
      names = new Set();
      perSlot.set(slot, names);
    }
    for (const name of importedNames(clause)) names.add(name);
    return full.replace(
      `${quote}${spec}${quote}`,
      `${quote}${adapterSpecifier(slot, names)}${quote}`,
    );
  });

  out = out.replace(SIDE_EFFECT_STATEMENT, (full, quote: string, spec: string) => {
    if (isNonBareSpecifier(spec)) return full;
    const slot = hostAbiSlotFor(spec);
    if (!slot) {
      unsafe = true;
      return full;
    }
    return full.replace(
      `${quote}${spec}${quote}`,
      `${quote}${adapterSpecifier(slot, perSlot.get(slot) ?? [])}${quote}`,
    );
  });

  if (unsafe) return null;
  // 动态导入无法在发布期绑定命名；只要它指向宿主槽就放行（适配器默认导出可用）。
  for (const match of out.matchAll(DYNAMIC_IMPORT)) {
    const spec = match[2] ?? '';
    if (isNonBareSpecifier(spec)) continue;
    if (!hostAbiSlotFor(spec)) return null;
  }

  // 同一槽可能被多条语句导入：`?names=` 必须是该槽所有语句的并集，否则靠后的
  // 语句会引用到前面尚未生成的命名。第二遍统一收敛到完整集合。
  //
  // 已有 `?names=` 的并集也会保留，因此对已经是 runtime 变体的输入是**不动点**
  // （第二次改写不会把命名抹掉）。
  return out.replace(
    /(['"])\/api\/frontend-abi\/([^"'?]+)(\?names=[^"']*)?\1/g,
    (full, quote: string, slot: string, query: string | undefined) => {
      if (!HOST_FRONTEND_ABI_SLOTS.includes(slot)) return full;
      const names = new Set(perSlot.get(slot) ?? []);
      if (query) {
        for (const name of new URLSearchParams(query.slice(1)).get('names')?.split(',') ?? []) {
          if (name) names.add(name);
        }
      }
      return `${quote}${adapterSpecifier(slot, names)}${quote}`;
    },
  );
}

/**
 * 一个已存在的 runtime 产物是否确实能被浏览器装载。
 *
 * 判定用**不变量**（而不是与派生结果逐字节比对），这样发布期由
 * `pnpm build:frontend` 产出的合法文件不会被内核反复重写：
 *
 * 1. 不存在裸说明符；
 * 2. 每个适配器导入都指向已知槽；
 * 3. 每条导入语句的**原始命名**都在该槽的 `?names=` 里。
 *
 * 旧版 `build-frontend.mjs` 把本地别名（`useState4`）而不是原始名（`useState`）写进
 * `?names=`，命中第 3 条即可被识别并重建。
 */
export function isRuntimeAdminBundleValid(source: string): boolean {
  for (const match of source.matchAll(FROM_STATEMENT)) {
    const clause = match[1] ?? '';
    const spec = match[3] ?? '';
    if (!isNonBareSpecifier(spec)) return false;
    if (!spec.startsWith(HOST_ABI_ADAPTER_PREFIX)) continue;
    const slot = spec.slice(HOST_ABI_ADAPTER_PREFIX.length).split('?')[0] ?? '';
    if (!HOST_FRONTEND_ABI_SLOTS.includes(slot)) return false;
    const query = spec.includes('?') ? spec.slice(spec.indexOf('?') + 1) : '';
    const declared = new Set(
      (new URLSearchParams(query).get('names') ?? '').split(',').filter(Boolean),
    );
    for (const name of importedNames(clause)) {
      if (!declared.has(name)) return false;
    }
  }
  for (const match of source.matchAll(SIDE_EFFECT_STATEMENT)) {
    if (!isNonBareSpecifier(match[2] ?? '')) return false;
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    if (!isNonBareSpecifier(match[2] ?? '')) return false;
  }
  return true;
}

/**
 * `dist/admin.js` 的身份（mtime + size）。用作“已检查过”的缓存键：同一份源码
 * 只处理一次，重装/重建后键变化，自然重跑。
 */
async function adminSourceStamp(adminPath: string): Promise<string | null> {
  try {
    const info = await stat(adminPath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

/** 已处理过的 `packageDir → 源码印章`。进程内缓存，避免每个请求重读 1 MB。 */
const checked = new Map<string, string>();

/**
 * 保证包里有一个可装载的 `dist/admin.runtime.js`，并把它登记进 manifest 白名单。
 *
 * 幂等：产物已合法时只补 manifest（若缺），源码未变化时直接命中缓存。包里没有
 * `dist/admin.js`，或派生不可行（存在非宿主 ABI 的裸说明符）时不动任何文件。
 *
 * @returns 是否改动了磁盘。
 */
export async function ensureRuntimeAdminBundle(packageDir: string): Promise<boolean> {
  const adminPath = path.join(packageDir, ADMIN_SOURCE);
  const stamp = await adminSourceStamp(adminPath);
  if (!stamp) return false; // 没有 admin.js：该包没有可装载的 admin 前端。

  const cached = checked.get(packageDir);
  if (cached === stamp) return false;

  const result = await repair(packageDir, adminPath);
  // 只缓存已完成的状态：写盘失败（只读挂载、权限不足）时下次请求重试，而不是
  // 把“修不了”永久记成“已检查过”。
  if (!result.failed) checked.set(packageDir, stamp);
  return result.changed;
}

interface RepairResult {
  changed: boolean;
  failed: boolean;
}

async function repair(packageDir: string, adminPath: string): Promise<RepairResult> {
  const runtimePath = path.join(packageDir, ADMIN_RUNTIME);
  const manifestPath = path.join(packageDir, MANIFEST);

  let manifest: { files?: unknown } & Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    return { changed: false, failed: false };
  }
  if (!manifest || typeof manifest !== 'object') return { changed: false, failed: false };

  let changed = false;
  const existing = existsSync(runtimePath)
    ? await readFile(runtimePath, 'utf8').catch(() => null)
    : null;
  if (existing === null || !isRuntimeAdminBundleValid(existing)) {
    const derived = rewriteHostAbiImports(await readFile(adminPath, 'utf8').catch(() => ''));
    if (!derived) return { changed: false, failed: false }; // 派生不可行：宁可保持原状，也不产出坏产物。
    if (Buffer.byteLength(derived) > MAX_RUNTIME_BYTES) return { changed: false, failed: false };
    // 写临时文件再 rename：并发请求可能同时补齐，最终字节完全相同。
    const staging = `${runtimePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(staging, derived, 'utf8');
      await rename(staging, runtimePath);
    } catch {
      await rm(staging, { force: true }).catch(() => undefined);
      return { changed: false, failed: true };
    }
    changed = true;
  }

  const files = Array.isArray(manifest.files) ? (manifest.files as string[]) : [];
  if (!files.includes(ADMIN_RUNTIME)) {
    manifest.files = [...files, ADMIN_RUNTIME];
    try {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch {
      return { changed, failed: true };
    }
    changed = true;
  }
  return { changed, failed: false };
}

/** 清空进程内缓存（测试用）。 */
export function resetRuntimeAdminBundleCache(): void {
  checked.clear();
}
