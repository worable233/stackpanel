import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AccountSecurityPage() {
  const t = createTranslator(await getLocale());
  const api = await getAuthedApiClient();
  const [currentUser, identityResult] = await Promise.all([
    api.getCurrentUser(),
    api.getConnectedIdentities().catch(() => ({ identities: [] })),
  ]);
  return (
    <main className="max-w-3xl space-y-6">
      <PageHeader
        title={t('account.security.title')}
        description={t('account.security.description')}
      />
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-5 py-4">
          <p className="text-sm font-medium">{t('account.security.loginAccount')}</p>
        </div>
        <dl className="divide-y text-sm">
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <dt className="text-muted-foreground">{t('account.security.email')}</dt>
            <dd>{currentUser.user.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <dt className="text-muted-foreground">{t('account.security.accountStatus')}</dt>
            <dd>{t('account.security.statusActive')}</dd>
          </div>
        </dl>
      </section>
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-5 py-4">
          <p className="text-sm font-medium">{t('account.security.boundIdentities')}</p>
        </div>
        {identityResult.identities.length > 0 ? (
          <ul className="divide-y">
            {identityResult.identities.map((identity) => (
              <li
                key={identity.id}
                className="flex items-center justify-between gap-4 px-5 py-4 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {identity.providerId === 'wowid' ? 'WowID' : identity.providerId}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {identity.displayName ?? identity.email ?? t('account.security.boundFallback')}
                  </p>
                </div>
                <span className="text-sm text-muted-foreground">
                  {t('account.security.connected')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {t('account.security.noIdentities')}
          </p>
        )}
      </section>
    </main>
  );
}
