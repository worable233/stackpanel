import { PageHeader } from '@stackpanel/ui';
import { ApiTokenManager } from '@/components/api-token-manager';
import { getAuthedApiClient, publicApiBaseUrl } from '@/lib/api';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/** Account center: self-service platform API credentials. */
export default async function AccountApiKeysPage() {
  const t = createTranslator(await getLocale());
  const api = await getAuthedApiClient();
  const [tokenResult, scopeResult] = await Promise.all([
    api.getApiTokens(),
    api.getApiTokenScopes(),
  ]);

  return (
    <main className="max-w-3xl space-y-6">
      <PageHeader
        title={t('account.apiKeys.title')}
        description={t('account.apiKeys.description')}
      />
      <ApiTokenManager
        tokens={tokenResult.tokens}
        scopes={scopeResult.scopes}
        prefix={scopeResult.prefix}
      />
      <section className="space-y-2 rounded-lg border bg-card p-5">
        <p className="text-sm font-medium">{t('account.apiKeys.howTo')}</p>
        <p className="text-sm text-muted-foreground">{t('account.apiKeys.usage')}</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
          {`curl ${publicApiBaseUrl()}/notifications \\\n  -H "Authorization: Bearer ${t('account.apiKeys.placeholder')}"`}
        </pre>
      </section>
    </main>
  );
}
