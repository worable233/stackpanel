import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { AccountSettings } from '@/components/account-settings';
import { Separator } from '@/components/ui/separator';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { ApiTokenManager } from '@/components/api-token-manager';

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const t = createTranslator(await getLocale());
  const api = await getAuthedApiClient();
  const [{ user }, identities, nav, credentials] = await Promise.all([
    api.getCurrentUser(),
    api.getConnectedIdentities().catch(() => null),
    api.getNav('account'),
    Promise.all([api.getApiTokens(), api.getApiTokenScopes()]).catch(() => null),
  ]);
  return (
    <main className="w-full">
      <PageHeader title={t('account.settings.title')} />
      <Separator className="my-4 lg:my-6" />
      <AccountSettings
        user={user}
        identities={identities?.identities ?? null}
        agentEnabled={nav.items.some(({ href }) => href === '/account/agent')}
        apiKeys={
          credentials ? (
            <div className="flex flex-col gap-4">
              <ApiTokenManager
                tokens={credentials[0].tokens}
                scopes={credentials[1].scopes}
                prefix={credentials[1].prefix}
              />
            </div>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              暂时无法加载 API 密钥，请刷新后重试。
            </p>
          )
        }
      />
    </main>
  );
}
