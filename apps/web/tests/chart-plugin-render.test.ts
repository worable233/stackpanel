import { describe, expect, it, vi } from 'vitest';

/**
 * P0-A 守卫：插件服务端入口 import 自己的 `'use client'` charts 模块时，
 * 宿主收编的必须是**真实客户端组件**，而不是「调用即抛」的桩。
 *
 * 线上 v0.1.3 的实例详情页 500（digest 1508909678）正是这条路径：store 插件的
 * `index.tsx`（服务端 RSC 入口）顶层 import `./charts.js`，被 loader 重定向到
 * 宿主收编表；那时收编表给的是 `chartsServerAbi()`（调用即抛），于是整页 500。
 */

describe('插件 charts 相对导入的收编（P0-A）', () => {
  it('收编的是真实客户端组件（next/dynamic 包装），不是服务端桩', async () => {
    vi.resetModules();
    const { publishHostServerAbi } = await import('@/lib/frontend-host-abi');
    publishHostServerAbi();
    const absorbed = (globalThis as Record<string, unknown>).__STACKPANEL_ABSORBED_CLIENT__ as Record<
      string,
      Record<string, unknown>
    >;
    for (const name of ['MetricsExplorer', 'UsageTrendChart']) {
      const component = absorbed.charts?.[name] as Record<string, unknown> | undefined;
      expect(component, `absorbed.charts.${name} 必须存在`).toBeTruthy();
      expect(typeof component).toBe('function');
      // 服务端桩的唯一实现是 `function ChartRenderedOnServer()`（返回 null）。
      // 回退成 `chartsServerAbi()` 时这里命中，用例变红。
      expect(String(component)).not.toContain('ChartRenderedOnServer');
      // next/dynamic 包装出来的组件带 displayName / 或至少不是裸的无参桩；
      // 用「函数源码长度」区分：桩只有一行 return null。
      expect(String(component).length).toBeGreaterThan(40);
    }
  });

  it('服务端桩本身仍可链接且不抛（P0-B 的降级路径）', async () => {
    vi.resetModules();
    const { publishHostServerAbi } = await import('@/lib/frontend-host-abi');
    const { resetChartComponentWarnings } = await import('@/lib/frontend-runtime-diagnostics');
    resetChartComponentWarnings();
    const charts = publishHostServerAbi()['@stackpanel/ui/charts'] as Record<string, unknown>;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 裸 import `@stackpanel/ui/charts` 的插件走这个槽：能链接、调用降级为空。
      expect((charts.MetricsExplorer as () => unknown)()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
