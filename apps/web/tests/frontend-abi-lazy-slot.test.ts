import { describe, expect, it, beforeEach, afterEach } from 'vitest';

/**
 * 宿主 ABI 适配器的**惰性槽**契约。
 *
 * ## 背景
 *
 * `@stackpanel/ui/charts`（图表组件，依赖 recharts 559 KB）不是同步命名空间，
 * 而是发布成一个**返回 Promise 的函数**。原因：如果在 ABI 发布时无条件
 * `import()`，recharts 会重新进入每个页面的模块图，拆分就白做了 ——
 * 实测 `/login` 首屏从 2987 KB 弹回 3360 KB。
 *
 * 适配器因此必须识别函数并 await 它。
 *
 * ## 为什么断言生成代码
 *
 * 这里的被测对象是「适配器生成什么 JS 交给浏览器」。断言生成代码直接锁住
 * 契约，比构造 globalThis 时序（`vi.waitFor` + 未决 Promise）稳定得多。
 * 运行时行为已在真实服务上验证过：`GET /api/frontend-abi/@stackpanel/ui/charts
 * ?names=MetricsExplorer` 返回 200 且导出 `MetricsExplorer`。
 */

const SLOT_MODULE = '@/app/api/frontend-abi/[...slot]/route';

type AbiGlobal = { __STACKPANEL_CLIENT_ABI__?: Record<string, unknown> };
const g = globalThis as unknown as AbiGlobal;

async function adapterBody(slot: string, names = ''): Promise<Response> {
  const request = new Request(`http://localhost/api/frontend-abi/${slot}?names=${names}`);
  const context = { params: Promise.resolve({ slot: slot.split('/') }) };
  const mod = await import(SLOT_MODULE);
  return mod.GET(request, context);
}

beforeEach(() => {
  // 只要 ABI 里**存在**该键，生成代码就能产出；取值是否可用不在本文件范围内。
  g.__STACKPANEL_CLIENT_ABI__ = {
    react: { useState: () => null },
    '@stackpanel/ui/charts': () => Promise.resolve({}),
  };
});

afterEach(() => {
  delete g.__STACKPANEL_CLIENT_ABI__;
});

const HEAVY_IMPORT_TIMEOUT = 30_000;

  /**
   * 这些用例首次 import 时会加载 route 模块（连带 `@stackpanel/ui` 整桶）。
   * 单跑约 1s，但全量并行时会被 CPU 争用拖到 5s+（实测打穿默认 5s 超时）。
   * 这里测的是语义，不是速度。
   */
describe('frontend ABI adapter — lazy slots', { timeout: HEAVY_IMPORT_TIMEOUT }, () => {
  it('generates an await branch so a function-valued slot is resolved', async () => {
    const response = await adapterBody('@stackpanel/ui/charts', 'MetricsExplorer');
    expect(response.status).toBe(200);

    const body = await response.text();
    // 惰性槽的核心：识别函数并 await。少了这行，浏览器拿到的 `ns` 会是函数本身，
    // `ns["MetricsExplorer"]` 是 undefined，图表静默不渲染。
    expect(body).toContain(`const raw = A["@stackpanel/ui/charts"];`);
    expect(body).toContain(`typeof raw === 'function' ? await raw() : raw`);
    expect(body).toContain('export const MetricsExplorer = ns["MetricsExplorer"];');
  });

  it('keeps synchronous slots on the direct property read path', async () => {
    const response = await adapterBody('react', 'useState');
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('export const useState = ns["useState"];');
    // 同步槽同样经过 `typeof` 判断（统一路径），但它发布的是对象，
    // 走 `: raw` 分支 —— 不需要 await。
    expect(body).toContain(`const ns = typeof raw === 'function' ? await raw() : raw;`);
  });

  it('exposes the charts slot in the whitelist', async () => {
    const response = await adapterBody('@stackpanel/ui/charts', 'UsageTrendChart');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('export const UsageTrendChart = ns["UsageTrendChart"];');
  });

  it('rejects a bare recharts slot', async () => {
    // 历史上 adapter 白名单里有个从未实现的 `recharts` 槽，spec 里却没有 —— 半成品。
    // 图表能力统一走 `@stackpanel/ui/charts`，避免插件绑死图表库版本。
    const response = await adapterBody('recharts', 'Area');
    expect(response.status).toBe(404);
  });

  it('404s an unknown slot', async () => {
    const response = await adapterBody('not-a-real-slot', 'Whatever');
    expect(response.status).toBe(404);
  });

  it('only re-exports identifier-shaped names', async () => {
    const response = await adapterBody('@stackpanel/ui/charts', 'MetricsExplorer,not-valid');
    const body = await response.text();
    expect(body).toContain('export const MetricsExplorer');
    // 非法标识符不得进入生成的 export 语句（会产出语法错误）。
    expect(body).not.toContain('not-valid');
  });
});
