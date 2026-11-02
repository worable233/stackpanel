import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  KERNEL_ROOT_EXACT,
  WEB_BFF_PREFIXES,
  kernelRewriteTarget,
  routeOwner,
  singlePortEnabled,
} from '../src/lib/single-port';

/**
 * 单端口的全部风险集中在一件事上：**别把 Web 自己的路由抢走**。
 *
 * 抢错的症状是「登录 404 / 通知不弹 / 插件后台白屏，但首页正常」—— 和这次反代事故
 * 长得一模一样，而且更难查，因为它发生在代码里而不是部署配置里。
 */

const webAppApiDir = path.resolve(__dirname, '../src/app/api');

describe('routeOwner', () => {
  it('内核的 /api/v1/* 全部归内核', () => {
    for (const pathname of [
      '/api/v1',
      '/api/v1/',
      '/api/v1/me',
      '/api/v1/market/admin/catalog',
      '/api/v1/system/proxy-check',
    ]) {
      expect(routeOwner(pathname), pathname).toBe('kernel');
    }
  });

  it('内核的根级前缀归内核', () => {
    for (const pathname of [
      ...KERNEL_ROOT_EXACT,
      '/mcp',
      '/mcp/',
      '/mcp/tools',
      '/sp/v1/foo',
      '/llm-gateway/chat/completions',
      '/callbacks/wechat',
      '/zjmf_api_login',
      '/cart/abc',
      '/host/abc',
      '/provision/abc',
      '/themes/atlas/theme.css',
      '/platform/info',
    ]) {
      expect(routeOwner(pathname), pathname).toBe('kernel');
    }
  });

  it('Web 自己的 BFF 归 Web', () => {
    for (const pathname of [
      '/api/account/avatar',
      '/api/action-flash',
      '/api/action-flash/abc',
      '/api/admin/notifications',
      '/api/agent/chat',
      '/api/frontend-abi/manifest',
      '/api/notifications',
      '/api/notifications/stream',
      '/api/plugins/market',
      '/api/store/cart',
    ]) {
      expect(routeOwner(pathname), pathname).toBe('web');
    }
  });

  it('页面与静态资源归 Web', () => {
    for (const pathname of ['/', '/login', '/admin', '/store', '/_next/static/x.js', '/blog/hello']) {
      expect(routeOwner(pathname), pathname).toBe('web');
    }
  });

  it('不吃掉只共享前缀的相邻路径', () => {
    // `/healthcheck` 不是 `/health`；`/versioned` 不是 `/version`。
    expect(routeOwner('/healthcheck')).toBe('web');
    expect(routeOwner('/versioned')).toBe('web');
    expect(routeOwner('/readiness')).toBe('web');
    expect(routeOwner('/plugins-x')).toBe('web');
    expect(routeOwner('/apix')).toBe('web');
  });

  it('BFF 清单与 apps/web/src/app/api 下的目录一致', () => {
    // 这条是防漂移用的：新增一个 BFF 目录却忘了加进 WEB_BFF_PREFIXES，单端口模式
    // 下它就归内核了（或者反过来）。两边必须同步。
    const dirs = readdirSync(webAppApiDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const declared = [...new Set(WEB_BFF_PREFIXES.map((prefix) => prefix.split('/')[2]))].sort();
    expect(dirs).toEqual(declared);
  });
});

describe('kernelRewriteTarget', () => {
  it('保留路径与查询串，只换 origin', () => {
    const target = kernelRewriteTarget('/api/v1/me', '?a=1', 'http://api:3001');
    expect(target?.toString()).toBe('http://api:3001/api/v1/me?a=1');
  });

  it('基地址的尾斜杠被归一化（不会出现 //api）', () => {
    const target = kernelRewriteTarget('/health', '', 'http://api:3001/');
    expect(target?.toString()).toBe('http://api:3001/health');
  });

  it('Web 归属的路径不产生转发', () => {
    expect(kernelRewriteTarget('/api/notifications', '', 'http://api:3001')).toBeNull();
    expect(kernelRewriteTarget('/', '', 'http://api:3001')).toBeNull();
  });
});

describe('singlePortEnabled', () => {
  it('接受常见真值写法', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' on ']) {
      expect(singlePortEnabled({ STACKPANEL_SINGLE_PORT: value }), value).toBe(true);
    }
  });

  it('默认关闭', () => {
    expect(singlePortEnabled({})).toBe(false);
    expect(singlePortEnabled({ STACKPANEL_SINGLE_PORT: '0' })).toBe(false);
    expect(singlePortEnabled({ STACKPANEL_SINGLE_PORT: 'false' })).toBe(false);
    expect(singlePortEnabled({ STACKPANEL_SINGLE_PORT: '' })).toBe(false);
  });
});

describe('middleware 接线', () => {
  /**
   * 单端口转发必须**在** middleware 里、并且真的被调用。这里的断言不是重复
   * `kernelRewriteTarget` 的单元测试，而是防「实现写好了但没人调用」这种静默
   * 失效 —— 事故的原始形态之一就是配置存在、路由不生效。
   */
  it('proxy.ts 在 singlePortEnabled() 时调用 kernelRewriteTarget 并 rewrite', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/proxy.ts'), 'utf8');
    expect(source).toContain('singlePortEnabled()');
    expect(source).toContain('kernelRewriteTarget(');
    expect(source).toContain('NextResponse.rewrite');
  });

  it('middleware matcher 不再排除 /api（否则单端口转发永远看不到 API 请求）', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/proxy.ts'), 'utf8');
    const matcher = /matcher:\s*\[([\s\S]*?)\n  \],/.exec(source)?.[1] ?? '';
    expect(matcher).toContain('_next/static');
    // 负向断言里出现 `api` 就说明 /api 又被排除了。
    expect(matcher).not.toMatch(/\(\?!api\|/);
  });
});
