# @stackpanel/spec

StackPanel 协议契约的**单一来源**。零运行时依赖，供内核、SDK、契约脚本、CI 与第三方工具复用。

## 导出

### 版本

- `KERNEL_API_VERSION`：内核契约 API 版本。插件 `manifest.apiVersion` 据此校验，打包脚本据此注入 `apiVersion` 下限。
- `API_VERSION` / `OPEN_API_NAMESPACE`：开放平台版本（`v1`）与命名空间（`/api/v1`）。
- `kernelApiVersionRange()`：`>=<KERNEL_API_VERSION>`，打包注入用。

### OpenAPI 投影

把能力项投影成文档 operation；内核 `docs` 与契约快照共用同一实现，二者不可能漂移。

- `OpenApiCapability` / `OpenApiOperation`
- `toOpenApiOperation` / `applyCapabilityOperations` / `capabilityPaths`

### 兼容性

把 OpenAPI 投影成稳定契约语义并比对，把破坏性变更（删接口、加必填、加鉴权、删响应码）变成红灯。

- `ContractOperation` / `ContractSnapshot` / `ContractDiff` / `ContractBreak`
- `normalizeSpec` / `buildSnapshot` / `snapshotFromOperations` / `diffContracts`
- `scopeOperations` / `hashOperations` / `toOpenApiPath`

## 使用

```ts
import { buildSnapshot, capabilityPaths, diffContracts } from '@stackpanel/spec';

const current = buildSnapshot(
  capabilityPaths([
    { method: 'GET', path: '/api/v1/widgets', summary: 'List widgets', scope: 'widget:read', mutating: false },
  ]),
  'v1',
);
```

## 版本联动

本包的 `version` 与 `KERNEL_API_VERSION`（`src/version.ts`）以及 `@stackpanel/sdk` 的 `version` 必须一致，由测试与流水线钉死。

## 许可

MIT
