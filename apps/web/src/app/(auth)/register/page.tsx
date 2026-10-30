import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { RegisterForm } from './register-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { AFFILIATE_COOKIE, normalizeAffiliateCode } from '@/lib/affiliate';
import { getCaptchaActions } from '@/lib/captcha';

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSessionUser();
  if (session) {
    redirect(session.role === 'ADMIN' ? '/admin' : '/account');
  }
  // Cookie first (the proxy already captured it), query string as fallback for
  // a cookieless first request straight to /register?affid=...
  const params = await searchParams;
  const raw = params.affid;
  const affid =
    normalizeAffiliateCode((await cookies()).get(AFFILIATE_COOKIE)?.value) ??
    normalizeAffiliateCode(typeof raw === 'string' ? raw : null);
  const api = getApiClient();
  // Canonical first-admin path: while the instance is unclaimed, send visitors
  // to the wizard rather than letting a self-service signup elect an admin.
  const setup = await api.getSetupStatus().catch(() => null);
  if (setup?.required) redirect('/setup');
  const [providers, platform, brand, authConfig, captcha] = await Promise.all([
    api
      .getOAuthProviders()
      .then((result) => result.providers)
      .catch(() => []),
    api
      .getPlatformInfo()
      .then((result) => result.platform)
      .catch(() => DEFAULT_PLATFORM_INFO),
    api
      .getPlatformBrand()
      .then((result) => result.brand)
      .catch(() => null),
    // Public auth policy: whether a verified email code is required and the
    // captcha widget config. Never fatal — a missing plugin falls back to the
    // historical mode (no verification).
    api.getAuthConfig().catch(() => null),
    // Register and send-code are separate guarded actions: a deployment may
    // challenge sign-up but not the code request, or the reverse.
    getCaptchaActions(['register', 'register_send_code']),
  ]);
  return (
    <RegisterForm
      providers={providers}
      platformName={platform.name}
      platformDescription={platform.description}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
      affid={affid}
      emailVerificationRequired={authConfig?.emailVerificationRequired ?? false}
      captcha={captcha.register ?? null}
      sendCodeCaptcha={captcha.register_send_code ?? null}
    />
  );
}
