import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FileSelfUpdatePlan,
  FileSelfUpdateRequest,
  SelfUpdateError,
  SelfUpdateExecutor,
  imagesMatch,
  type SelfUpdateAdapter,
} from '../src/self-update-executor.ts';

const CURRENT = `sha256:${'1'.repeat(64)}`;
const CANDIDATE = `sha256:${'2'.repeat(64)}`;

/** Fake self-update adapter: tracks the "live" updater image and command log. */
function fakeAdapter() {
  const calls: string[] = [];
  let current = CURRENT;
  const adapter: SelfUpdateAdapter = {
    async currentUpdaterImage() {
      return current;
    },
    async pullAndVerifyUpdater(digest) {
      calls.push(`pull:${digest}`);
      return { credential: `pulled:${digest}` };
    },
    async switchUpdaterTo(digest) {
      calls.push(`switch:${digest}`);
      current = digest;
      return { credential: `switched:${digest}` };
    },
    async restoreUpdater(digest) {
      calls.push(`restore:${digest}`);
      current = digest;
      return { credential: `restored:${digest}` };
    },
  };
  return { adapter, calls, getCurrent: () => current };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-selfexec-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function make(
  overrides: {
    hasActiveTask?: () => Promise<boolean>;
    now?: () => Date;
    timeoutMs?: number;
    request?: FileSelfUpdateRequest;
    handovers?: unknown[];
  } = {},
) {
  const { adapter, calls } = fakeAdapter();
  const plan = FileSelfUpdatePlan.resolve(root);
  const executor = new SelfUpdateExecutor({
    adapter,
    plan,
    hasActiveTask: overrides.hasActiveTask ?? (async () => false),
    ...(overrides.request ? { request: overrides.request } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.timeoutMs ? { candidateTimeoutMs: overrides.timeoutMs } : {}),
    requestHandover: async (request) => {
      overrides.handovers?.push(request);
    },
    writerId: 'host:1',
  });
  return { executor, plan, calls };
}

describe('imagesMatch', () => {
  it('matches a bare digest against a full repo@digest reference', () => {
    expect(imagesMatch(`ghcr.io/acme/updater@${CANDIDATE}`, CANDIDATE)).toBe(true);
  });

  it('does not match different digests', () => {
    expect(imagesMatch(`ghcr.io/acme/updater@${CURRENT}`, CANDIDATE)).toBe(false);
  });

  it('matches identical tag references', () => {
    expect(imagesMatch('ghcr.io/acme/updater:1.0.0', 'ghcr.io/acme/updater:1.0.0')).toBe(true);
  });
});

describe('SelfUpdateExecutor', () => {
  it('refuses to self-update while an update task is in flight', async () => {
    const { executor } = make({ hasActiveTask: async () => true });
    await expect(executor.requestUpdate(CANDIDATE)).rejects.toBeInstanceOf(SelfUpdateError);
  });

  it('refuses when the candidate equals the running image', async () => {
    const { executor } = make();
    await expect(executor.requestUpdate(CURRENT)).rejects.toThrow(/相同/);
  });

  it('switches to the candidate, records the rollback point and requests handover', async () => {
    const handovers: unknown[] = [];
    const { executor, plan, calls } = make({ handovers });
    const result = await executor.requestUpdate(CANDIDATE);
    expect(result).toMatchObject({ status: 'switched', candidateDigest: CANDIDATE });
    expect(calls).toContain(`pull:${CANDIDATE}`);
    expect(calls).toContain(`switch:${CANDIDATE}`);
    expect(handovers).toHaveLength(1);
    const stored = await plan.read();
    expect(stored?.phase).toBe('switching');
    expect(stored?.previousDigest).toBe(CURRENT);
  });

  it('confirms the candidate and marks the plan committed', async () => {
    const { executor, plan } = make();
    await executor.requestUpdate(CANDIDATE);
    const result = await executor.confirmCandidate();
    expect(result).toMatchObject({ status: 'committed', candidateDigest: CANDIDATE });
    expect((await plan.read())?.phase).toBe('committed');
  });

  it('does not confirm a non-matching candidate', async () => {
    const { executor } = make();
    // No switching plan present.
    expect((await executor.confirmCandidate()).status).toBe('idle');
  });

  it('rolls back when the candidate never confirms before the deadline', async () => {
    let now = new Date('2026-10-17T00:00:00Z');
    const { executor, plan, calls } = make({
      now: () => now,
      timeoutMs: 60_000,
    });
    await executor.requestUpdate(CANDIDATE);
    // Before deadline: waiting.
    now = new Date('2026-10-17T00:00:30Z');
    expect((await executor.guardTick()).status).toBe('waiting');
    // After deadline: roll back.
    now = new Date('2026-10-17T00:02:00Z');
    const result = await executor.guardTick();
    expect(result).toMatchObject({ status: 'rolled_back', restoredDigest: CURRENT });
    expect(calls).toContain(`restore:${CURRENT}`);
    expect((await plan.read())?.phase).toBe('rolled_back');
  });

  it('settles a committed candidate on start by clearing the plan', async () => {
    const { executor, plan } = make();
    await executor.requestUpdate(CANDIDATE);
    await executor.confirmCandidate();
    const result = await executor.settleOnStart();
    expect(result).toMatchObject({ status: 'committed', candidateDigest: CANDIDATE });
    expect(await plan.read()).toBeNull();
  });

  it('consumes a pending request and executes it when idle', async () => {
    const request = FileSelfUpdateRequest.resolve(root);
    await request.write({
      candidateDigest: CANDIDATE,
      requestedBy: 'admin',
      requestedAt: '2026-10-17T00:00:00Z',
    });
    const { executor, calls } = make({ request });
    const result = await executor.consumeRequest();
    expect(result).toMatchObject({ status: 'switched', candidateDigest: CANDIDATE });
    expect(calls).toContain(`switch:${CANDIDATE}`);
    // Request is consumed.
    expect(await request.read()).toBeNull();
  });

  it('defers a request while an update task is in flight (does not lose it)', async () => {
    const request = FileSelfUpdateRequest.resolve(root);
    await request.write({
      candidateDigest: CANDIDATE,
      requestedBy: 'admin',
      requestedAt: '2026-10-17T00:00:00Z',
    });
    const { executor } = make({ request, hasActiveTask: async () => true });
    expect((await executor.consumeRequest()).status).toBe('idle');
    expect(await request.read()).not.toBeNull();
  });
});
