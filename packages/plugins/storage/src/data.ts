import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 存储插件自治数据模型（ADR-0008 / ADR-0009）。
 *
 * 单行配置（`name = 'default'`）：选择用哪个后端、以及非敏感参数。**密钥**
 * （S3 access key / secret）绝不进这里，走 `ctx.secrets`（AES-256-GCM）。
 */

/** 后端类型：本地盘（spool）/ S3 兼容（redirect）/ 自定义 HTTP 图床（proxy）。 */
export const configSchema = z.object({
  /** 启用的后端；'env' 表示停用插件、回退内核环境变量驱动。 */
  kind: z.enum(['env', 'local', 's3', 'http']).default('env'),
  /** 本地盘根目录（kind=local）；空则用数据目录下的 storage。 */
  localRoot: z.string().default(''),
  /** S3 端点（kind=s3）；留空走 AWS 默认。 */
  s3Endpoint: z.string().default(''),
  s3Region: z.string().default('us-east-1'),
  s3Bucket: z.string().default(''),
  /** MinIO / 自建网关多为 path-style。 */
  s3ForcePathStyle: z.boolean().default(true),
  /** 浏览器读取对象的公开基址；空则由端点与桶推导。 */
  publicBaseUrl: z.string().default(''),
  /** 图床上传地址（kind=http），接收对象字节的绝对 URL。 */
  httpUploadUrl: z.string().default(''),
  /** 图床读取基址（kind=http）；对象 URL = `<base>/<key>`。 */
  httpPublicBaseUrl: z.string().default(''),
  /** 图床上传方式：PUT 原样发送，POST 以 multipart 发送。 */
  httpMethod: z.enum(['PUT', 'POST']).default('PUT'),
  /** multipart 字段名（kind=http 且 method=POST）。 */
  httpFieldName: z.string().default('file'),
  /** 图床鉴权等附加请求头（kind=http）。 */
  httpHeaders: z.string().default(''),
  /** 删除接口模板（kind=http，可选），`{key}` 占位。 */
  httpDeleteUrlTemplate: z.string().default(''),
  /** 是否已配置密钥（仅状态标记；真实密钥在 ctx.secrets）。 */
  hasCredentials: z.boolean().default(false),
});

export const configModel = defineModel({
  kind: 'storage/config',
  label: '存储配置',
  schema: configSchema,
  indexes: [{ fields: ['kind'], types: { kind: 'string' } }],
  cacheTtlMs: 10_000,
});

export type StoragePluginConfig = z.infer<typeof configSchema>;
