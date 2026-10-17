import type { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
export function parseAgent<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
  return result.data;
}
