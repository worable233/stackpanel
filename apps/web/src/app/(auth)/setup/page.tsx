import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { ProvisionForm } from './provision-form';
import { SetupForm } from './setup-form';
import { SetupUnavailable } from './setup-unavailable';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: translate(await getLocale(), 'auth.setup.pageTitle'),
    robots: { index: false, follow: false },
  };
}

/**
 * First-run setup wizard.
 *
 * The page branches on the **authoritative phase** from `GET /setup/status`
 * (BOOTSTRAP-R1), never on "the API answered". Three cases must stay distinct:
 *
 * 1. **Unreachable API / unknown phase** — render a retryable failure. This is
 *    deliberately *not* a redirect: sending a fresh install to `/login` is the
 *    exact bug where the operator could never reach the form.
 * 2. **Provisioning phases** — render the infrastructure form. These pages must
 *    not depend on the database, plugins or themes, so it uses host styles and
 *    skips the runtime platform/brand lookups.
 * 3. **`needs_admin`** — the existing first-administrator form.
 *
 * Terminal phases (`complete`, `starting`, `runtime_failed`, …) are not a
 * wizard: they go to login or the workspace, exactly as before.
 */
export default async function SetupPage() {
  const api = getApiClient();
  const status = await api.getSetupStatus().catch(() => null);

  // Not a wizard state at all: either already installed or offline.
  if (!status) {
    return <SetupUnavailable />;
  }

  switch (status.phase) {
    case 'needs_infra':
    case 'migration_failed':
      // Infrastructure bootstrap. Deliberately no platform/brand fetch: the
      // API is up in provision mode but the database is not, so those calls
      // would only produce 404/timeout noise (BOOTSTRAP-R10).
      //
      // `migration_failed` stays submittable so the operator can correct a
      // candidate (BOOTSTRAP-R6) — unless the runner flagged that automatic
      // retry is unsafe (unknown/non-empty schema, failed migration record).
      return (
        <ProvisionForm
          canSubmit={
            status.phase === 'needs_infra' || status.operation?.diagnosticsRequired !== true
          }
          diagnosticsRequired={status.operation?.diagnosticsRequired === true}
        />
      );

    case 'validating':
    case 'queued':
    case 'migrating':
    case 'starting':
      // Work in progress; the form polls `/setup/status` until the phase moves.
      return <ProvisionForm canSubmit={false} />;

    case 'runtime_failed':
      return <ProvisionForm canSubmit={false} failed />;

    case 'needs_admin':
      break;

    default:
      // `complete` (or any future terminal phase): leave the wizard.
      await redirectAway();
  }

  const [platform, brand] = await Promise.all([
    api.getPlatformInfo().then((r) => r.platform).catch(() => DEFAULT_PLATFORM_INFO),
    api.getPlatformBrand().then((r) => r.brand).catch(() => null),
  ]);

  return (
    <SetupForm
      platformName={platform.name}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
      tokenRequired={status.tokenRequired}
    />
  );
}

/** Redirect an already-initialized instance to its normal destination. */
async function redirectAway(): Promise<never> {
  const session = await getSessionUser();
  redirect(session ? (session.role === 'ADMIN' ? '/admin' : '/account') : '/login');
}
