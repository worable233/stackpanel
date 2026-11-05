import { describe, expect, it, vi } from 'vitest';

/**
 * v0.1.3 线上事故的三条回归守卫（P0-A / P0-B / P0-C）。
 *
 * 三者是同一个架构缺口的三种表现：**图表组件在服务端渲染路径上被执行**。
 * 修复把它们拆成三个可独立验证的断言，任何一条回退都会让对应用例变红。
 */

/**
 * 这些用例首次 import 时会加载 `@stackpanel/ui` 整桶（客户端与服务端两份）。
 * 单跑约 1.4s，但 `pnpm -r test` 全量并行时会被 CPU 争用拖到 5s+（实测打穿默认 5s超时）。
 * 这里测的是语义，不是速度，给出显式预算。
 */
const HEAVY_IMPORT_TIMEOUT = 30_000;

describe('图表组件的服务端降级（P0-B）', { timeout: HEAVY_IMPORT_TIMEOUT }, () => {
  it('主入口取图表组件时返回可调用的桩，而不是 undefined', async () => {
    vi.resetModules();
    const abi = await import('@/lib/frontend-host-abi');
    // 关键：`@stackpanel/ui` 主入口**不含**图表（recharts 拆分），但插件仍从
    // 主入口 import 它们。少一个具名导出就是 ESM 链接失败、整包装载不了。
    expect(abi.CHART_COMPONENT_NAMES).toContain('MetricsExplorer');
    expect(abi.CHART_COMPONENT_NAMES).toContain('UsageTrendChart');
  });

  it('从实际发布的 ABI 里取到图表组件并调用，必须返回 null', async () => {
    vi.resetModules();
    const { publishHostServerAbi } = await import('@/lib/frontend-host-abi');
    const { resetChartComponentWarnings } = await import('@/lib/frontend-runtime-diagnostics');
    resetChartComponentWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const abi = publishHostServerAbi();
      const ui = abi['@stackpanel/ui'] as Record<string, unknown>;
      const charts = abi['@stackpanel/ui/charts'] as Record<string, unknown>;
      // 主入口与 charts 槽都必须可链接这两个名字。
      for (const name of ['MetricsExplorer', 'UsageTrendChart']) {
        expect(typeof ui[name]).toBe('function');
        expect(typeof charts[name]).toBe('function');
        // 真实调用：返回 null（React 渲染为空块），而不是抛错。
        // 回退成 throw 就是线上整页 500。
        expect((ui[name] as () => unknown)()).toBeNull();
        expect((charts[name] as () => unknown)()).toBeNull();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('插件自带 ./charts.js 的 absorbed 能力是真实组件，不是桩（P0-A）', async () => {
    vi.resetModules();
    const { ABSORBED_CLIENT_STEMS, publishHostServerAbi } = await import('@/lib/frontend-host-abi');
    expect(ABSORBED_CLIENT_STEMS).toContain('charts');
    publishHostServerAbi();
    const absorbed = (globalThis as Record<string, unknown>).__STACKPANEL_ABSORBED_CLIENT__ as Record<
      string,
      Record<string, unknown>
    >;
    // 回退成 chartsServerAbi()（调用即抛的桩）时整页 500：这里必须是
    // 真实的客户端组件。RSC 下它作为客户端引用不会被调用。
    for (const name of ['MetricsExplorer', 'UsageTrendChart']) {
      const component = absorbed.charts?.[name];
      expect(component).toBeTruthy();
      expect(typeof component).toBe('function');
      // 桩是无参数的函数，且调用就抛。真实组件不会因为被提取就抛。
      // 桩的形态是「无参数且调用即返回 null」；真实组件（next/dynamic 包装）不是。
      expect(String(component)).not.toContain('ChartRenderedOnServer');
    }
  });

  it('诊断辅助函数不抛错（日志失败不能反过来把页面弄挂）', async () => {
    vi.resetModules();
    const { reportChartComponentOnServer, resetChartComponentWarnings } = await import(
      '@/lib/frontend-runtime-diagnostics'
    );
    resetChartComponentWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 桩的真实形态：返回值必须是 null（React 渲染 null = 空块），不能抛。
      // 回退成 `throw` 会让线上实例详情页整页 500（digest 1508909678）。
      reportChartComponentOnServer('MetricsExplorer');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? '');
      expect(message).toContain('MetricsExplorer');
      // P1-B：诊断必须带插件/路由上下文，否则定位只能 grep 编译产物。
      expect(message).toContain('[frontend-runtime]');
    } finally {
      warn.mockRestore();
    }
  });

  it('同一处误用的 warn 去重，不同插件分别报', async () => {
    vi.resetModules();
    const { reportChartComponentOnServer, resetChartComponentWarnings, enterFrontendContext } =
      await import('@/lib/frontend-runtime-diagnostics');
    resetChartComponentWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      enterFrontendContext({ kind: 'plugins', id: 'store', route: 'account/service-detail' });
      reportChartComponentOnServer('MetricsExplorer');
      reportChartComponentOnServer('MetricsExplorer');
      // 同一插件同一路由：只报一次，不刷屏。
      expect(warn).toHaveBeenCalledTimes(1);
      const first = String(warn.mock.calls[0]?.[0] ?? '');
      expect(first).toContain('plugins/store');
      expect(first).toContain('route=account/service-detail');

      // 换一个插件：必须再报一条（这才是需要区分的信息）。
      enterFrontendContext({ kind: 'plugins', id: 'llm-gateway', route: 'admin/usage' });
      reportChartComponentOnServer('MetricsExplorer');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]?.[0] ?? '')).toContain('plugins/llm-gateway');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('客户端适配器的图表回落（P0-C）', { timeout: HEAVY_IMPORT_TIMEOUT }, () => {
  it('从主入口取图表名时生成回落到 charts 槽的代码', async () => {
    const { GET } = await import('@/app/api/frontend-abi/[...slot]/route');
    const response = await GET(
      new Request(
        'http://localhost/api/frontend-abi/%40stackpanel%2Fui?names=PageHeader,UsageTrendChart',
      ),
      { params: Promise.resolve({ slot: ['@stackpanel/ui'] }) },
    );
    const source = await response.text();
    // 回退成「直接 export const X = ns['X']」会让插件拿到 undefined，
    // 渲染时报 `Element type is invalid`（比 500 更难查）。
    expect(source).toContain("'@stackpanel/ui/charts'");
    expect(source).toContain('__charts');
    // 非图表名字仍然直接从主桶取，不引入多余等待。
    expect(source).toContain("export const PageHeader = ns[\"PageHeader\"];");
  });

  it('没有图表名时不生成 charts 回落代码（不白等惰性槽）', async () => {
    const { GET } = await import('@/app/api/frontend-abi/[...slot]/route');
    const response = await GET(
      new Request('http://localhost/api/frontend-abi/%40stackpanel%2Fui?names=PageHeader'),
      { params: Promise.resolve({ slot: ['@stackpanel/ui'] }) },
    );
    const source = await response.text();
    expect(source).not.toContain('__charts');
  });
});
