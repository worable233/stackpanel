/**
 * 宿主前端 ABI（契约 02 §2/§5，主计划 §4）。
 *
 * `pnpm build:frontend` 产出插件/主题前端时，宿主 ABI 槽被 external 到宿主来源；
 * 运行期由宿主桥接层提供，保证 React/导航/UI 单实例。第三方包可在 manifest 声明
 * `frontendExternals`（槽 → 兼容 semver range），内核按本模块的宿主版本做门禁：
 * 不满足即拒装（409），与 `apiVersion` 的校验路径同构。
 *
 * 本模块是**零运行时依赖**的单一来源：内核、构建脚本、契约脚本、第三方工具共用。
 * 宿主版本必须在**内核发版**时与本表同步（`packages/spec/tests` 有守卫测试核对
 * 已安装的 `node_modules` 版本）。
 */

/**
 * 宿主提供的固定 ABI 槽清单（契约 02 §2、§5 结论）。
 *
 * - React 三件套必须与宿主渲染器单实例（主计划 §3.2 实测 React 不共享）。
 * - `next/*` 为宿主导航/路由/表单 adapter。
 * - `@stackpanel/ui` / `@stackpanel/sdk` 为宿主 workspace 包。
 * - `lucide-react` 因 `@stackpanel/ui` 大量依赖而冻结为宿主 ABI（否则图标树两份）。
 *
 * `zod` **不在**此列：纯 schema 库，由发布者打进产物（契约 02 §5）。
 */
export const HOST_FRONTEND_ABI_SLOTS: readonly string[] = Object.freeze([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'next/link',
  'next/form',
  'next/navigation',
  '@stackpanel/ui',
  '@stackpanel/sdk',
  'lucide-react',
]);

/**
 * 宿主 ABI 槽的**已声明版本**（用于 `frontendExternals` 门禁比对）。
 *
 * 这些值必须在宿主镜像构建时固定，并在内核发版时同步（守卫测试核对，见
 * `packages/spec/tests/frontend-abi.test.ts`）。`@stackpanel/ui` / `@stackpanel/sdk`
 * 使用 workspace 包版本；React / next / lucide 使用宿主安装版本。
 */
export const HOST_FRONTEND_ABI: Readonly<Record<string, string>> = Object.freeze({
  react: '19.2.4',
  'react-dom': '19.2.4',
  'react/jsx-runtime': '19.2.4',
  'next/link': '16.3.8',
  'next/form': '16.3.8',
  'next/navigation': '16.3.8',
  '@stackpanel/ui': '0.2.0',
  '@stackpanel/sdk': '0.4.0',
  'lucide-react': '1.31.0',
});

export interface FrontendExternalsError {
  slot: string;
  reason: 'unknown-slot' | 'invalid-range' | 'unsatisfied';
  detail: string;
}

/**
 * 校验一个 `frontendExternals` 声明（槽 → semver range）。
 *
 * 返回错误列表（空数组表示通过）。**不抛异常**，由调用方决定状态码：未知槽与
 * 非法范围视为 422（协议错误），不满足宿主版本视为 409（兼容冲突）——与
 * `apiVersion` 校验的语义一致（契约 02 §5）。
 *
 * @param externals 包声明的槽 → range
 * @param hostAbi    宿主实际版本表（默认 {@link HOST_FRONTEND_ABI}）
 */
export function validateFrontendExternals(
  externals: Record<string, string>,
  hostAbi: Readonly<Record<string, string>> = HOST_FRONTEND_ABI,
): FrontendExternalsError[] {
  const errors: FrontendExternalsError[] = [];
  for (const [slot, range] of Object.entries(externals)) {
    if (!HOST_FRONTEND_ABI_SLOTS.includes(slot)) {
      errors.push({ slot, reason: 'unknown-slot', detail: `未知的宿主 ABI 槽：${slot}` });
      continue;
    }
    if (typeof range !== 'string' || range.trim().length === 0) {
      errors.push({ slot, reason: 'invalid-range', detail: `${slot} 的兼容范围必须是非空字符串` });
      continue;
    }
    const hostVersion = hostAbi[slot];
    if (!hostVersion) {
      // A known slot missing from the host table is a kernel misconfiguration.
      errors.push({ slot, reason: 'unknown-slot', detail: `宿主未声明 ${slot} 的版本` });
      continue;
    }
    if (!satisfiesRange(hostVersion, range)) {
      errors.push({
        slot,
        reason: 'unsatisfied',
        detail: `要求 ${slot} ${range}，宿主为 ${hostVersion}`,
      });
    }
  }
  return errors;
}

/**
 * 极小 semver range 判定（避免给零依赖的 spec 引入 `semver`）。
 *
 * 支持：精确版本、`^x.y.z`、`~x.y.z`、比较符（`>= <= > <`）与空格分隔的合取
 * （如 `>=0.2 <0.3`）。这是 `frontendExternals` 声明所需的受控子集；复杂
 * range（`||`、通配、预发布）由调用方以 `semver` 进一步校验，本函数保守返回
 * 是否满足。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const clauses = range.trim().split(/\s+/).filter((c) => c.length > 0);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => satisfiesClause(version, clause));
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** A partial version where any part may be `x`/`X`/`*` (wildcard). */
function parsePartial(version: string): Array<number | null> | null {
  const match = /^(\d+|x|X|\*)\.(\d+|x|X|\*)\.(\d+|x|X|\*)$/.exec(version.trim());
  if (!match) return null;
  return match.slice(1).map((part) => (/^\d+$/.test(part) ? Number(part) : null));
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function satisfiesClause(version: string, clause: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;

  // Bare partial version with a wildcard, e.g. `19.2.x` / `19.x` / `*`.
  const partial = parsePartial(clause);
  if (partial && partial.some((part) => part === null)) {
    return partial.every((part, index) => part === null || part === v[index]);
  }

  if (clause.startsWith('^')) {
    const base = parseVersion(clause.slice(1));
    if (!base) return false;
    const [maj] = base;
    const upper: [number, number, number] = [maj + 1, 0, 0];
    return compare(v, base) >= 0 && compare(v, upper) < 0;
  }
  if (clause.startsWith('~')) {
    const base = parseVersion(clause.slice(1));
    if (!base) return false;
    const [maj, min] = base;
    const upper: [number, number, number] = [maj, min + 1, 0];
    return compare(v, base) >= 0 && compare(v, upper) < 0;
  }
  const cmp = /^(>=|<=|>|<|=)?(.+)$/.exec(clause);
  if (!cmp) return false;
  const op = cmp[1] ?? '=';
  const target = parseVersion(cmp[2] ?? '');
  if (!target) return false;
  const c = compare(v, target);
  switch (op) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    default:
      return c === 0;
  }
}
