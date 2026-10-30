import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { AccountSettings } from '@/components/account-settings';
import { Separator } from '@/components/ui/separator';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { ApiTokenManager } from '@/components/api-token-manager';
import { getCaptchaActions } from '@/lib/captcha';

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const t = createTranslator(await getLocale());
  const api = await getAuthedApiClient();
  const [{ user }, identities, nav, credentials, authConfig, captcha] = await Promise.all([
    api.getCurrentUser(),
    api.getConnectedIdentities().catch(() => null),
    api.getNav('account'),
    Promise.all([api.getApiTokens(), api.getApiTokenScopes()]).catch(() => null),
    api.getAuthConfig().catch(() => null),
    // Account-area guarded actions. Read from the kernel capability (not the
    // login plugin) so they keep working with the login plugin uninstalled.
    // Missing entries simply render no widget.
    getCaptchaActions(['change_password', 'change_email', 'api_token_create']),
  ]);
  return (
    <main className="w-full">
      <PageHeader title={t('account.settings.title')} />
      <Separator className="my-4 lg:my-6" />
        <AccountSettings
        user={user}
        emailVerificationRequired={authConfig?.emailVerificationRequired ?? false}
        identities={identities?.identities ?? null}
        agentEnabled={nav.items.some(({ href }) => href === '/account/agent')}
        captcha={captcha}
        apiKeys={
          credentials ? (
            <div className="flex flex-col gap-4">
              <ApiTokenManager
                tokens={credentials[0].tokens}
                scopes={credentials[1].scopes}
                prefix={credentials[1].prefix}
                captcha={captcha.api_token_create ?? null}
              />
            </div>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {t('account.settings.access.keysLoadFailed')}
            </p>
          )
        }
      />
    </main>
  );
}
