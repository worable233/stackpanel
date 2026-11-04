import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadRuntimeFrontend, runtimeFrontendEntry } from '@/lib/frontend-runtime';

/**
 * 真实插件前端的**装载 + 渲染**端到端验证。
 *
 * 在此之前，插件前端只验证到「ABI adapter 返回 200 且含正确导出」—— 那一层
 * 只证明 adapter 生成代码对，完全没碰插件真正的产物。真正会坏的地方是：
 *
 * 1. 产物在磁盘上解析不到（`runtimeFrontendEntry` 返回 null）
 * 2. `import()` 求值时炸（ABI shim 缺失、`createContext` 在 RSC 图里被调用、
 *    ENAMETOOLONG 这类路径长度问题）
 * 3. 导出的 `pageComponents` 不是可渲染的 React 组件
 * 4. 组件真的渲染时因为 props 契约不符而崩
 *
 * 这四条里任何一条坏掉，用户看到的就是整页 500。所以这里一路跑到
 * `renderToStaticMarkup` 为止。
 *
 * props 按内核真实契约构造（见 `lib/frontend-page-data.ts`：`data` 与
 * `settings` 都是必填）。用空对象测渲染会得到误导性的失败 —— 曾经因此误判
 * store 的 `shop` 组件有 bug，实际是测试漏传 `settings`。
 */
// 这些用例需要 `data/plugins/<id>/frontend/dist/index.js` 真实存在。CI 的干净
// checkout 没有安装任何插件，所以整组按条件跳过 —— 用 `skipIf` 而不是让它
// 失败，否则「没装插件」会被误报成「插件坏了」。
const pluginsAvailable = ['store', 'catalog', 'ticket', 'notice'].every(
  (id) => runtimeFrontendEntry('plugins', id) !== null,
);

describe.skipIf(!pluginsAvailable)('插件前端装载与渲染（真实产物）', () => {
  const PLUGINS = ['store', 'catalog', 'ticket', 'notice'];

  it('入口文件能在 data/plugins 下解析到', () => {
    for (const id of PLUGINS) {
      const entry = runtimeFrontendEntry('plugins', id);
      expect(entry, `${id} 缺少 frontend/dist/index.js`).toBeTruthy();
      expect(entry).toContain(`/${id}/frontend/dist/index.js`);
    }
  });

  it('每个插件前端都能 import 求值并导出内容', async () => {
    for (const id of PLUGINS) {
      const mod = (await loadRuntimeFrontend('plugins', id)) as Record<string, unknown> | null;
      expect(mod, `${id} 装载失败（返回 null）`).toBeTruthy();
      expect(Object.keys(mod ?? {}).length, `${id} 没有导出`).toBeGreaterThan(0);
    }
  });

  it('store 的页面组件能渲染出 HTML', async () => {
    const mod = (await loadRuntimeFrontend('plugins', 'store')) as {
      pageComponents?: Record<string, (props: unknown) => unknown>;
    } | null;
    const components = mod?.pageComponents ?? {};
    const names = Object.keys(components);
    expect(names.length, 'store 没有导出 pageComponents').toBeGreaterThan(0);

    const props = {
      params: {},
      data: { categories: [], catalogProducts: { products: [], total: 0 } },
      settings: { shop: {} },
      locale: 'zh-CN',
      t: (key: string) => key,
    };

    const failures: string[] = [];
    let rendered = 0;
    for (const name of names) {
      try {
        const html = renderToStaticMarkup(
          createElement(components[name] as never, props as never),
        );
        if (html.length > 0) rendered += 1;
      } catch (error) {
        // `NEXT_REDIRECT` 是正常控制流：未登录 / 缺参数时页面组件会 redirect。
        // 它不是渲染失败，忽略。
        if (String(error).includes('NEXT_REDIRECT')) continue;
        failures.push(`${name}: ${String(error).slice(0, 160)}`);
      }
    }

    expect(failures, `渲染失败：\n${failures.join('\n')}`).toEqual([]);
    // 至少一个组件真的产出了 HTML（其余可能是 redirect）
    expect(rendered).toBeGreaterThan(0);
  });
});
