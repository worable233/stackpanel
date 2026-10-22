'use client';

import { useState, useTransition } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, Input, Label, PageHeader } from '@stackpanel/ui';
import { t } from './i18n.js';

type Source = {
  repository: string;
  channel: 'stable' | 'beta';
  ref: string;
  tokenConfigured: boolean;
};

export function MarketSettingsPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const source = (props.data.source as { source?: Source } | undefined)?.source ?? {
    repository: '',
    channel: 'stable',
    ref: 'main',
    tokenConfigured: false,
  };
  const [draft, setDraft] = useState(source);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const action = props.actions['market.save-source'];

  function save() {
    if (!action) return;
    setError(null);
    setSaved(false);
    const form = new FormData();
    form.set('repository', draft.repository);
    form.set('channel', draft.channel);
    form.set('ref', draft.ref);
    if (token) form.set('token', token);
    if (clearToken) form.set('clearToken', 'true');
    startTransition(async () => {
      try {
        await action(form);
        setToken('');
        setClearToken(false);
        setSaved(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : tr('settings.saveError'));
      }
    });
  }

  return (
    <main className="w-full space-y-6">
      {!props.embedded ? <PageHeader title={tr('settings.title')} /> : null}
      <section className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-base font-semibold">{tr('settings.sourceTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{tr('settings.sourceDescription')}</p>
        </div>
        <div className="space-y-4 rounded-xl border bg-card p-4">
          <div className="space-y-2">
            <Label htmlFor="market-repository">{tr('settings.repository')}</Label>
            <Input
              id="market-repository"
              value={draft.repository}
              onChange={(e) => setDraft({ ...draft, repository: e.target.value })}
              placeholder="owner/repository"
            />
            <p className="text-xs text-muted-foreground">{tr('settings.repositoryHelp')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="market-channel">{tr('settings.channel')}</Label>
              <select
                id="market-channel"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={draft.channel}
                onChange={(e) =>
                  setDraft({ ...draft, channel: e.target.value as Source['channel'] })
                }
              >
                <option value="stable">{tr('settings.stable')}</option>
                <option value="beta">{tr('settings.beta')}</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="market-ref">{tr('settings.ref')}</Label>
              <Input
                id="market-ref"
                value={draft.ref}
                onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
                placeholder="main"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="market-token">{tr('settings.token')}</Label>
            <Input
              id="market-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                source.tokenConfigured
                  ? tr('settings.tokenConfigured')
                  : tr('settings.tokenOptional')
              }
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">{tr('settings.tokenHelp')}</p>
            {source.tokenConfigured ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={clearToken}
                  onChange={(e) => setClearToken(e.target.checked)}
                />
                {tr('settings.clearToken')}
              </label>
            ) : null}
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {saved ? <p className="text-sm text-emerald-600">{tr('settings.saved')}</p> : null}
          <div className="flex justify-end">
            <Button type="button" onClick={save} disabled={pending || !action}>
              {pending ? tr('settings.saving') : tr('settings.save')}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
