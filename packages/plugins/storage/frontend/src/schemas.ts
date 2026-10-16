import { z } from 'zod';

/**
 * 前端 finder 的响应 schema。
 *
 * 必须与后端 `packages/plugins/storage/src/index.ts` 的 `toView` 逐字对齐——
 * BFF 的 finder 会 `schema.parse`，多一个字段少一个字段都会让页面读不到数据。
 */

export const adminConfigSchema = z.object({
  config: z.object({
    kind: z.enum(['env', 'local', 's3']),
    localRoot: z.string(),
    s3Endpoint: z.string(),
    s3Region: z.string(),
    s3Bucket: z.string(),
    s3ForcePathStyle: z.boolean(),
    publicBaseUrl: z.string(),
    hasCredentials: z.boolean(),
    secretsAvailable: z.boolean(),
  }),
});

export type AdminConfigData = z.infer<typeof adminConfigSchema>;
