'use client';

import {
  Component,
  createElement,
  useMemo,
  type ComponentType,
  type ReactElement,
} from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { FrontendAbiBridge } from './frontend-abi-bridge';
import { FrontendScopeRoot } from './frontend-scope';
import { useRuntimeModule } from '@/lib/use-runtime-module';
import { useLocale, useTranslator } from '@/i18n/provider';
import { isNextRedirectError } from '@/lib/next-navigation';

/**
 * 主计划 §5 阶段 4 M2：固定客户端容器 + 运行期浏览器模块。
 *
 * 宿主**没有**在构建期见过这个模块：服务端按 revision 给出它的同源 URL（发布期已把
 * 宿主 ABI 说明符改写为受控适配器导入 `/api/frontend-abi/*`）。容器负责装载它、把
 * 宿主 ABI 发布到位、按组件 id 取组件，并用宿主 `createElement` 渲染——从而与宿主
 * 共享同一份 React（SPIKE-results §0）。
 *
 * 装载失败降级为提示（契约 06 §1.2 M2 失败路径），不抛出、不污染其余页面。
 */
export interface RuntimeAdminResult {
  pluginId: string;
  path: string;
  params: Record<string, string>;
  settings: Record<string, unknown>;
  data: Record<string, unknown>;
  actions: Record<string, unknown>;
  componentId: string;
}

export function RuntimeAdminPage({
  moduleUrl,
  result,
}: {
  moduleUrl: string;
  result: RuntimeAdminResult;
}): ReactElement {
  const t = useTranslator();
  const locale = useLocale();
  const state = useRuntimeModule(moduleUrl);
  const adminPages = useMemo(() => extractAdminPages(state.data), [state.data]);
  const Component = adminPages?.[result.componentId] as
    | ComponentType<AdminPageComponentProps>
    | undefined;

  // 无论加载状态如何，宿主 ABI 都必须在挂载时发布，保证后续 import() 可用。
  const bridge = <FrontendAbiBridge />;

  if (state.kind === 'error') {
    return (
      <>
        {bridge}
        <main className="mx-auto w-full max-w-3xl">
          <p role="alert" className="text-sm text-destructive">
            {t('pluginPage.loadFailed', { message: state.message })}
          </p>
        </main>
      </>
    );
  }
  if (!Component) {
    return (
      <>
        {bridge}
        <main className="mx-auto w-full max-w-3xl">
          <p className="text-sm text-muted-foreground">{t('pluginPage.loading')}</p>
        </main>
      </>
    );
  }
  const props = {
    pluginId: result.pluginId,
    path: result.path,
    params: result.params,
    settings: result.settings,
    data: result.data,
    actions: result.actions,
    locale,
  } as unknown as AdminPageComponentProps;
  return (
    <>
      {bridge}
      <FrontendScopeRoot scope={`plugins:${result.pluginId}`} className="block space-y-6">
        <RuntimeErrorBoundary>
          {createElement(Component, props as never) as unknown as ReactElement}
        </RuntimeErrorBoundary>
      </FrontendScopeRoot>
    </>
  );
}

/** 渲染期错误边界：装载成功但渲染抛错时降级（契约 06 §1.2）。 */
export class RuntimeErrorBoundary extends Component<
  { children: ReactElement },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      // Server actions use this exception as navigation control flow. Catching
      // it here leaves the URL change intact but renders its digest as an error.
      if (isNextRedirectError(this.state.error)) throw this.state.error;
      return (
        <p role="alert" className="text-sm text-destructive">
          {this.state.error.message}
        </p>
      );
    }
    return this.props.children;
  }
}

function extractAdminPages(
  data: unknown,
): Record<string, ComponentType<AdminPageComponentProps>> | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const pages = (record['adminPages'] ?? record['default']) as
    | Record<string, ComponentType<AdminPageComponentProps>>
    | undefined;
  return pages ?? null;
}
