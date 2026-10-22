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
 *
 * semver range 判定复用分发契约的 `distribution/semver.ts`（同一受控子集），
 * 避免本包出现两份会漂移的实现。
 */

import { satisfiesRange } from './distribution/semver.js';

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
  'sonner',
]);

/**
 * 宿主 ABI 槽的**已声明版本**（用于 `frontendExternals` 门禁比对）。
 *
 * 这些值必须在宿主镜像构建时固定，并在内核发版时同步（守卫测试核对，见
 * `packages/spec/tests/frontend-abi.test.ts`）。`@stackpanel/ui` / `@stackpanel/sdk`
 * 使用 workspace 包版本；React / next / lucide 使用宿主安装版本。
 */
export const HOST_FRONTEND_ABI: Readonly<Record<string, string>> = Object.freeze({
  react: '19.3.1',
  'react-dom': '19.3.1',
  'react/jsx-runtime': '19.3.1',
  'next/link': '16.4.2',
  'next/form': '16.4.2',
  'next/navigation': '16.4.2',
  '@stackpanel/ui': '0.2.0',
  '@stackpanel/sdk': '0.4.0',
  'lucide-react': '1.31.0',
  sonner: '2.0.8',
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
