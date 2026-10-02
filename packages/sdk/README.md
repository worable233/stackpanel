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

## 版本联动

`@stackpanel/sdk` 的 `version` 与内核契约版本 `KERNEL_API_VERSION`（发布于 `@stackpanel/spec`）保持一致。插件在 `manifest.apiVersion` 声明兼容的语义化版本范围，内核据此校验。

## 许可

MIT
