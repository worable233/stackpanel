'use client';

import {
  Component,
  createElement,
  useMemo,
  type ComponentType,
  type ReactElement,
} from 'react';
import { InlineError } from '@stackpanel/ui';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { LoaderCircle } from 'lucide-react';
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
          <InlineError>{t('pluginPage.loadFailed')}</InlineError>
        </main>
      </>
    );
  }
  if (!Component) {
    return (
      <>
        {bridge}
        {state.kind === 'loaded' ? (
          <main className="mx-auto w-full max-w-3xl">
            <p className="text-sm text-muted-foreground">{t('pluginPage.notFound')}</p>
          </main>
        ) : (
          <PluginPageSkeleton label={t('pluginPage.loading')} />
        )}
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
      <FrontendScopeRoot scope={`plugins:${result.pluginId}`} className="plugin-admin block space-y-6">
        <RuntimeErrorBoundary>
          {createElement(Component, props as never) as unknown as ReactElement}
        </RuntimeErrorBoundary>
      </FrontendScopeRoot>
    </>
  );
}

/**
 * Plugin pages are loaded as browser modules after the shell renders. A bare
 * text placeholder makes that transition look broken, so hold the layout with
 * a quiet skeleton until the real page arrives.
 */
function PluginPageSkeleton({ label }: { label: string }): ReactElement {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-10 shrink-0 animate-pulse rounded-xl bg-muted" />
          <div className="space-y-2">
            <div className="h-6 w-44 animate-pulse rounded-md bg-muted" />
            <div className="h-3.5 w-64 max-w-[60vw] animate-pulse rounded-md bg-muted/70" />
          </div>
        </div>
        <div className="h-9 w-28 animate-pulse rounded-xl bg-muted" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <div key={card} className="rounded-2xl bg-muted/40 p-5">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="mt-4 h-8 w-16 animate-pulse rounded-md bg-muted" />
            <div className="mt-3 h-3 w-32 animate-pulse rounded bg-muted/70" />
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-muted/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="h-5 w-32 animate-pulse rounded bg-muted" />
          <div className="h-8 w-24 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background p-4"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted/70" />
              </div>
              <div className="h-4 w-16 animate-pulse rounded bg-muted/70" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </main>
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
      return <RuntimeRenderError />;
    }
    return this.props.children;
  }
}

/** Static, localised render failure; the exception itself stays in the console. */
function RuntimeRenderError(): ReactElement {
  const t = useTranslator();
  return (
    <InlineError>{t('pluginPage.renderFailed')}</InlineError>
  );
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
