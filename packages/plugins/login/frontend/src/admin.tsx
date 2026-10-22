'use client';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from './i18n.js';

export function LoginSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const config = props.data.config as
    | {
        registrationMethods?: string[];
        emailVerificationRequired?: boolean;
        emailVerificationSupported?: boolean;
      }
    | undefined;
  const [email, setEmail] = useState(config?.registrationMethods?.includes('email') ?? true);
  const [emailVerification, setEmailVerification] = useState(
    config?.emailVerificationRequired ?? false,
  );
  const supported = config?.emailVerificationSupported ?? false;
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/login/login/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          registrationMethods: email ? ['email'] : [],
          emailVerificationRequired: emailVerification,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? tr('settings.saveFailed'));
      toast.success(tr('settings.saved'));
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr('settings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('settings.title')} />
      <p className="text-sm text-muted-foreground">{tr('settings.description')}</p>
      <section className="space-y-5 border-b pb-6">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={email}
            onChange={(e) => setEmail(e.target.checked)}
          />
          <span>
            <strong className="font-medium">{tr('settings.emailGroup')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.emailGroupHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={emailVerification}
            disabled={!supported || !email}
            onChange={(e) => setEmailVerification(e.target.checked)}
          />
          <span>
            <strong className="font-medium">{tr('settings.emailVerification')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.emailVerificationHint')}
            </span>
            {!supported ? (
              <span className="mt-1 block text-amber-600">
                {tr('settings.emailVerificationUnavailable')}
              </span>
            ) : null}
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm opacity-60">
          <input type="checkbox" disabled checked={false} readOnly />
          <span>
            <strong className="font-medium">{tr('settings.phoneGroup')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.phoneGroupHint')}
            </span>
          </span>
        </label>
        <button
          className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60"
          disabled={busy || !email}
          onClick={() => void save()}
        >
          {busy ? tr('settings.saving') : tr('settings.save')}
        </button>
      </section>
    </main>
  );
}

export const adminPages = { 'admin/settings': LoginSettings } as const;
