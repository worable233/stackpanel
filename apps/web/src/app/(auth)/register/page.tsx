import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { RegisterClosed } from './register-closed';
import { RegisterForm } from './register-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { AFFILIATE_COOKIE, normalizeAffiliateCode } from '@/lib/affiliate';
import { getCaptchaActions } from '@/lib/captcha';
import { translate } from '@/i18n/core';
import { getLocale } from '@/i18n/locale';

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
  const locale = await getLocale();
  // Two states make the form pointless, and both are the operator's call rather
  // than a transient error: sign-ups closed, and "verification required but no
  // channel" (the kernel refuses registration outright in that case). Rendering
  // the form anyway would let a visitor fill everything in and then eat a
  // 403/503.
  const registrationState = !(authConfig?.registrationEnabled ?? true)
    ? { titleKey: 'auth.register.closedTitle', bodyKey: 'auth.register.closedBody' }
    : authConfig?.emailVerificationBlocked === true
      ? { titleKey: 'auth.register.blockedTitle', bodyKey: 'auth.register.blockedBody' }
      : null;
  if (registrationState) {
    return (
      <RegisterClosed
        platformName={platform.name}
        logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
        title={translate(locale, registrationState.titleKey)}
        body={translate(locale, registrationState.bodyKey)}
      />
    );
  }
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
