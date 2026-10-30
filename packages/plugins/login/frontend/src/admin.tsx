'use client';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, Checkbox, PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from './i18n.js';

export function LoginSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
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
      const res = await fetch('/api/plugins/login/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          registrationMethods: email ? ['email'] : [],
          emailVerificationRequired: emailVerification,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? tr('settings.saveFailed'));
      toast.success(tr('settings.saved'));
      // 整页 reload 会把刚弹出的 toast 一起销毁（与 smtp 同一类 bug）；
      // `router.refresh()` 只重取 RSC 数据，宿主 `<Toaster />` 不动。
      router.refresh();
    } catch (e) {
      console.error('[login] save failed', e);
      toast.error(tr('settings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('settings.title')} />
      <section className="plugin-section space-y-5">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={email}
            onCheckedChange={(checked) => setEmail(checked === true)}
          />
          <span>
            <strong className="font-medium">{tr('settings.emailGroup')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.emailGroupHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={emailVerification}
            disabled={!supported || !email}
            onCheckedChange={(checked) => setEmailVerification(checked === true)}
          />
          <span>
            <strong className="font-medium">{tr('settings.emailVerification')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.emailVerificationHint')}
            </span>
            {!supported ? (
              <span className="plugin-warning mt-1 block">
                {tr('settings.emailVerificationUnavailable')}
              </span>
            ) : null}
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm opacity-60">
          <Checkbox disabled checked={false} />
          <span>
            <strong className="font-medium">{tr('settings.phoneGroup')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.phoneGroupHint')}
            </span>
          </span>
        </label>
        <Button disabled={busy || !email} onClick={() => void save()}>
          {busy ? tr('settings.saving') : tr('settings.save')}
        </Button>
      </section>
    </main>
  );
}

export const adminPages = { 'admin/settings': LoginSettings } as const;
