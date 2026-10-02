/**
 * Kernel job wiring for the async variant pipeline (ADR-0014 §4 Stage B).
 *
 * Registered in `plugin-host.ts`'s `registerKernelJobs()` — the assembly both the
 * API replicas and the standalone worker run — so a variant job enqueued by an
 * upload is consumed wherever it lands, and the recovery sweep runs once across
 * the cluster (BullMQ scheduler, ADR-0013). The handler throws while a variant is
 * still worth retrying, which is exactly the signal both the BullMQ backend and
 * the in-process fallback use to apply their backoff.
 */
import type { JobContext } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { getStorage } from '../infra.ts';
import { getStateService } from '../state/index.ts';
import { createKernelJobContext, getJobRuntime } from '../jobs/index.ts';
import { createSharpTransformer } from './sharp-transformer.ts';
import { PrismaAttachmentRepository } from './prisma-attachment-repository.ts';
import type { VariantQueue } from './service.ts';
import { processPendingVariants, runVariantJob, type VariantWorkerDeps } from './worker.ts';
import { VARIANT_ATTEMPT_CAP, VARIANT_JOB_BACKOFF_MS, type VariantJobPayload } from './variants.ts';

/** Kernel-owned job names (qualified to `kernel.<name>` by the runtime). */
export const MEDIA_JOBS = {
  /** One attachment's pending variants. */
  encode: 'media.variants',
  /** Recurring sweep that re-enqueues rows left pending by a crash. */
  backfill: 'media.variants-backfill',
} as const;

/** How often the recovery sweep looks for orphaned `pending` variants. */
export const MEDIA_BACKFILL_MS = 60_000;

const logger = {
  warn: (message: string): void => console.warn(message),
  info: (message: string): void => console.info(message),
};

/** Assemble the worker dependencies from the process-wide singletons. */
export function buildVariantWorkerDeps(): VariantWorkerDeps {
  const state = getStateService();
  return {
    repository: new PrismaAttachmentRepository(getPrisma()),
    storage: getStorage(),
    transform: createSharpTransformer(),
    logger,
    withLock: (key, ttlMs, fn) => state.withLock(key, ttlMs, fn),
    maxAttempts: VARIANT_ATTEMPT_CAP,
  };
}

/** Register the variant handler + recovery sweep on a kernel job context. */
export function registerMediaJobs(jobs: JobContext): void {
  jobs.handle(MEDIA_JOBS.encode, async (payload: VariantJobPayload) => {
    const result = await runVariantJob(buildVariantWorkerDeps(), payload);
    // Throwing asks the backend to back off and retry; a `done` pass is silent.
    if (result === 'retry') throw new Error(`media: 附件 ${payload?.attachmentId} 变体待重试`);
  });
  jobs.handle(MEDIA_JOBS.backfill, async () => {
    await processPendingVariants(buildVariantWorkerDeps());
  });
  void jobs.schedule(MEDIA_JOBS.backfill, { everyMs: MEDIA_BACKFILL_MS });
}

/** Enqueue options shared by the upload path (attempts + fixed backoff). */
export const VARIANT_JOB_OPTIONS = {
  attempts: VARIANT_ATTEMPT_CAP,
  backoffMs: VARIANT_JOB_BACKOFF_MS,
} as const;

/**
 * Build the production queue over the shared kernel job runtime. Returns null
 * when no backend is attached yet (before `initInfra()`); the caller then keeps
 * the Stage A synchronous path, so an upload never depends on Redis being ready.
 */
export function tryBuildVariantQueue(): VariantQueue | null {
  const runtime = getJobRuntime();
  if (!runtime.hasBackend()) return null;
  const jobs = createKernelJobContext('kernel', runtime);
  return {
    enqueue: async (payload) => {
      const id = await jobs.enqueue(MEDIA_JOBS.encode, payload, VARIANT_JOB_OPTIONS);
      if (!id) throw new Error('media: 变体任务入队失败');
    },
  };
}
