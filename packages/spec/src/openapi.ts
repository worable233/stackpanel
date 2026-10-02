/**
 * 能力项 → OpenAPI 文档投影（SPEC-SDK / D15）。
 *
 * 开放平台 `/api/v1` 的文档面是能力注册表（内核 `CAPABILITIES` + 活跃插件能力）的
 * 纯函数。把该投影抽到契约包，让内核 `app.ts` 的 swagger
 * `transformSpecification`、契约快照脚本与兼容性测试**共用同一实现**，文档与快照
 * 不可能漂移。
 */

/** 投影接受的最小能力形状（内核 + 插件皆可结构化满足）。 */
export interface OpenApiCapability {
  method: string;
  path: string;
  summary: string;
  scope: string | null;
  mutating: boolean;
}

export interface OpenApiOperation {
  tags: string[];
  summary: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required: boolean;
    schema: { type: string };
  }>;
  responses: Record<string, { description: string }>;
}

/** 把一个能力项投影成文档化的 OpenAPI operation。 */
export function toOpenApiOperation(capability: OpenApiCapability): OpenApiOperation {
  return {
    tags: ['open-api'],
    summary: capability.summary,
    ...(capability.scope ? { security: [{ bearerAuth: [] }] } : {}),
    ...(capability.mutating
      ? {
          parameters: [
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
          ],
        }
      : {}),
    responses: {
      '200': { description: 'OK' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
    },
  };
}

/**
 * 把所有能力项合并进 swagger `paths` 映射（就地修改，Fastify swagger
 * `transformSpecification` 传给我们的形状）。
 */
export function applyCapabilityOperations(
  paths: Record<string, unknown>,
  capabilities: readonly OpenApiCapability[],
): void {
  for (const capability of capabilities) {
    const pathItem = (paths[capability.path] ?? {}) as Record<string, unknown>;
    pathItem[capability.method.toLowerCase()] = toOpenApiOperation(capability);
    paths[capability.path] = pathItem;
  }
}

/**
 * 仅由能力项构建完整 `{ paths }` 文档。契约快照用它，因此无需启动应用
 * （也无需 DB/Redis）。
 */
export function capabilityPaths(
  capabilities: readonly OpenApiCapability[],
): { paths: Record<string, Record<string, OpenApiOperation>> } {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const capability of capabilities) {
    const pathItem = (paths[capability.path] ??= {});
    pathItem[capability.method.toLowerCase()] = toOpenApiOperation(capability);
  }
  return { paths };
}
