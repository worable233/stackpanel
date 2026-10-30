import { redirect } from 'next/navigation';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { ResetPasswordForm } from './reset-password-form';
import { ResetUnavailable } from './reset-unavailable';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { getCaptchaForAction } from '@/lib/captcha';
import { translate } from '@/i18n/core';
import { getLocale } from '@/i18n/locale';

export default async function ForgotPasswordPage() {
  // A signed-in visitor has no reason to be here, and letting them reset would
  // silently sign them out everywhere.
  const session = await getSessionUser();
  if (session) redirect(session.role === 'ADMIN' ? '/admin' : '/account');
  const api = getApiClient();
  const setup = await api.getSetupStatus().catch(() => null);
  if (setup?.required) redirect('/setup');
  const [platform, brand, authConfig, captcha] = await Promise.all([
    api
      .getPlatformInfo()
      .then((result) => result.platform)
      .catch(() => DEFAULT_PLATFORM_INFO),
    api
      .getPlatformBrand()
      .then((result) => result.brand)
      .catch(() => null),
    // Authoritative answer to "can a code even be delivered?". Best-effort: an
    // unreachable login plugin keeps the form (the submit reports the real
    // error), which is friendlier than a dead end.
    api.getAuthConfig().catch(() => null),
    getCaptchaForAction('password_reset'),
  ]);
  const logoSrc = brand?.logo ? apiAssetUrl(brand.logo) : null;
  if (authConfig && !authConfig.passwordResetSupported) {
    const locale = await getLocale();
    return (
      <ResetUnavailable
        platformName={platform.name}
        logoSrc={logoSrc}
        title={translate(locale, 'auth.reset.unavailableTitle')}
        body={translate(locale, 'auth.reset.unavailableBody')}
      />
    );
  }
  return <ResetPasswordForm platformName={platform.name} logoSrc={logoSrc} captcha={captcha} />;
}
