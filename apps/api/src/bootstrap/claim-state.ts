/**
 * Mark the bootstrap state as claimed after the first administrator exists.
 *
 * BOOTSTRAP-R4: the setup token must stay valid until the administrator is
 * actually created. Consequently the *token* is never deleted by the migration
 * runner, and the *phase* only becomes `complete` here — after the claim
 * transaction committed. Two separate facts, two separate writes:
 *
 * - the claim itself is authoritative in the database (`group_admin` exists);
 * - the state file is the projection that the web page and the runner read.
 *
 * Failure to update the state file must never fail the claim: the admin has
 * already been created, and `setupStatus()` recomputes `complete` from the
 * database on the next request. The state file is repaired opportunistically.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { BootstrapStateStore, defaultBootstrapStateDir } from './state.ts';

/** Resolve `<state>/bootstrap` from the same env the provision app uses. */
function bootstrapDir(): string | null {
  const explicit = process.env['STACKPANEL_STATE_DIR'];
  if (explicit && explicit.trim().length > 0) {
    return defaultBootstrapStateDir(path.resolve(explicit));
  }
  const dataDir = process.env['STACKPANEL_DATA_DIR'];
  if (dataDir && dataDir.trim().length > 0) {
    return defaultBootstrapStateDir(path.dirname(path.resolve(dataDir)));
  }
  return null;
}

/**
 * Advance `needs_admin` → `complete`.
 *
 * Deliberately narrow: if the phase is anything else (for example a stale
 * `needs_infra` left by a broken install) this does nothing rather than
 * inventing a state transition. `setupStatus()` remains the source of truth
 * for whether the wizard is required.
 */
export async function markAdminClaimed(
  log: (message: string) => void = (message) => console.info(message),
): Promise<void> {
  const dir = bootstrapDir();
  if (!dir) return;
  if (!existsSync(path.join(dir, 'state.json'))) return;

  const store = new BootstrapStateStore({ dir, targetVersion: 'unknown' });
  try {
    const state = await store.read();
    if (!state) return;
    if (state.phase !== 'needs_admin' && state.phase !== 'queued') {
      // `complete` is idempotent; anything else means the instance is not in a
      // shape where a claim should have succeeded — leave it for diagnostics.
      if (state.phase !== 'complete') {
        log(`[bootstrap] 管理员已创建，但状态阶段为 ${state.phase}，未自动推进到 complete`);
      }
      return;
    }
    await store.transition({
      phase: 'complete',
      adminClaimed: true,
      runtimeReady: true,
      migrationSucceeded: true,
    });
    log('[bootstrap] 管理员已认领，自举状态推进到 complete');
  } catch (error) {
    // Never fail the claim because bookkeeping failed (see module docs).
    log(
      `[bootstrap] 更新自举状态失败（不影响管理员创建）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
