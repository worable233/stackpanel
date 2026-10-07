# @stackpanel/sdk

StackPanel 的类型安全客户端与插件开发 SDK。

- **类型化 API 客户端**：`ApiClient` 覆盖内核 / 开放平台端点，请求与响应均有类型与 zod schema。
- **插件开发契约**：`definePlugin`、`PluginManifest`、能力项声明、Extension / 事件总线类型，供第三方插件在后端与前台复用。
- **零额外运行时**：运行期仅依赖 `zod`。

## 安装

```bash
pnpm add @stackpanel/sdk
```

## 使用

```ts
import { ApiClient } from '@stackpanel/sdk';

const client = new ApiClient({ baseUrl: 'https://your-panel.example/api', token: process.env.STACKPANEL_TOKEN });
const me = await client.getCurrentUser();
```

插件作者：

```ts
import { definePlugin } from '@stackpanel/sdk';
import type { HttpReply, HttpRequest } from '@stackpanel/sdk';

async function hello(_req: HttpRequest, _reply: HttpReply): Promise<unknown> {
  return { message: 'hello' };
}

export default definePlugin({
  manifest: { id: 'my-plugin', name: '我的插件', version: '0.1.0' },
  routes: [{ method: 'GET', path: '/hello', handler: hello }],
});
```

## 插件执行模式

第三方插件在生产环境默认使用 `execution: 'isolated'`：入口运行在独立 worker 进程，
`PluginContext` 的媒体引用、事件发布/订阅、后台任务、共享状态、认证、支付、钱包、汇率、
通知、密钥、事务和 Extension CRUD 通过内核 RPC 使用。服务注入必须写入插件定义的
`inject`，扩展消费必须写入 manifest 的 `consumes`；worker 退出时插件会进入 `failed` 隔离状态，重新激活后才会重建 worker，连续三次退出后熔断并要求重新注册修复后的插件包。RPC 使用 10 秒双向超时、双向取消消息、1 MiB 消息上限、64 并发上限，并对 Date、Buffer、BigInt 和 Error 做显式编码。

`execution: 'trusted'` 仅适用于内置插件或非生产开发环境。isolated 模式保留同步的
`auth.sessionCookieConfig()`、`secrets.isAvailable()` 和 `payments.listPaymentMethods()`
契约，但 `events.intercept()` 与 `events.waterfall()` 需要同步 `next()`，因此在 isolated
模式会明确拒绝。原始流式路由和无法转为 JSON Schema 的自定义模型同样不能使用 isolated
协议。

`ctx.state.acquire()` 返回锁 owner token；释放必须传回同一个 token。业务代码优先使用
`ctx.state.withLock()`，避免错误释放其他请求持有的锁。

## 版本联动

`@stackpanel/sdk` 的 `version` 与内核契约版本 `KERNEL_API_VERSION`（发布于 `@stackpanel/spec`）保持一致。插件在 `manifest.apiVersion` 声明兼容的语义化版本范围，内核据此校验。

## 许可

MIT
