import { z } from 'zod';
import type { HttpRequest } from '@stackpanel/sdk';
import { context } from './context';
import { StoreError } from './errors';
import { auditActor, recordStoreAudit } from './audit';
const schema = z.object({ provisioningMode: z.enum(['manual', 'automatic']) }).strict();
const key = 'store-provisioning-policy';
export async function storeSettings() {
  const saved = await context().secrets.get(key);
  return saved == null ? { provisioningMode: 'manual' as const } : schema.parse(JSON.parse(saved));
}
export async function saveStoreSettings(req: HttpRequest) {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '开通方式无效');
  await context().secrets.set(key, JSON.stringify(parsed.data));
  await recordStoreAudit({ action: 'store.settings.updated', resource: 'store/settings', ...auditActor(req), meta: parsed.data });
  return parsed.data;
}
