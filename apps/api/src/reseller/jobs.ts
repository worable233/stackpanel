/**
 * SP v1 kernel jobs + lifecycle fan-out (P3).
 *
 * `registerResellerJobs` is wired by the kernel in `plugin-host.ts`
 * (`registerKernelJobs`), which both the API and the worker call — so the
 * webhook dispatcher handler exists on every consumer and the delivery job runs
 * exactly once cluster-wide. The lifecycle subscription is installed in the API
 * too (worker is harmless): it fans store's `order.paid` event out to the
 * originating reseller as a signed webhook.
 */
import type { JobContext } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { getEventBus } from '../plugins/events.ts';
import { enqueueWebhook, processDueWebhooks, WEBHOOK_JOBS } from './webhook.ts';
import { ResellerRepository } from './repository.ts';

/** How often the dispatcher looks for due webhook deliveries. */
export const WEBHOOK_POLL_MS = 5_000;

let lifecycleStarted = false;

/** Install the one-time store→reseller lifecycle fan-out. Idempotent. */
export function startResellerLifecycle(): void {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  getEventBus().subscribe('order.paid', (payload) => {
    const event = payload as OrderPaidEvent | null;
    if (!event?.orderId) return;
    void notifyResellerOfOrder(event).catch(() => undefined);
  });
}

/** Test seam: allow the lifecycle subscription to be installed again. */
export function resetResellerLifecycle(): void {
  lifecycleStarted = false;
}

interface OrderPaidEvent {
  orderId: string;
  channelCode?: string | null;
  status?: string;
  total?: number;
  currency?: string;
}

async function notifyResellerOfOrder(event: OrderPaidEvent): Promise<void> {
  const channelCode = event.channelCode;
  if (!channelCode || !channelCode.startsWith('SP_V1:')) return;
  const keyId = channelCode.split(':')[1];
  if (!keyId) return;
  const prisma = getPrisma();
  const reseller = await new ResellerRepository(prisma).findByKeyId(keyId);
  if (!reseller) return;
  await enqueueWebhook(prisma, reseller, 'order.paid', {
    orderId: event.orderId,
    status: event.status ?? 'PAID',
    total: event.total ?? 0,
    currency: event.currency ?? 'CNY',
  });
}

/** Register the SP v1 webhook dispatcher handler + recurring schedule. */
export function registerResellerJobs(jobs: JobContext): void {
  startResellerLifecycle();
  jobs.handle(WEBHOOK_JOBS.deliver, async () => {
    await processDueWebhooks(getPrisma());
  });
  void jobs.schedule(WEBHOOK_JOBS.deliver, { everyMs: WEBHOOK_POLL_MS });
}
