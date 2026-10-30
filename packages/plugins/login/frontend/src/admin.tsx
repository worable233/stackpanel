'use client';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, Checkbox, PageHeader } from '@stackpanel/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from './i18n.js';

/**
 * Registration policy.
 *
 * One decision the operator actually makes — **is self-registration open** — and
 * one refinement: does a new account have to prove its mailbox first.
 *
 * The email method is not a checkbox any more. Phone registration has no
 * implementation behind it, so "email on/off" and "registration on/off" were
 * always the same switch wearing two labels; the previous form made that worse
 * by disabling its own save button when email was unchecked, so closing
 * registration was impossible. Now `open` writes `['email']` or `[]`, and the
 * server accepts the empty list.
 */
export function LoginSettings(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const router = useRouter();
  const config = props.data.config as
    | {
        registrationMethods?: string[];
        registrationEnabled?: boolean;
        emailVerificationRequired?: boolean;
        emailVerificationSupported?: boolean;
        emailVerificationBlocked?: boolean;
      }
    | undefined;
  const methods = config?.registrationMethods ?? ['email'];
  const [open, setOpen] = useState(config?.registrationEnabled ?? methods.length > 0);
  const [emailVerification, setEmailVerification] = useState(
    config?.emailVerificationRequired ?? false,
  );
  const supported = config?.emailVerificationSupported ?? false;
  const blocked = config?.emailVerificationBlocked ?? false;
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/plugins/login/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          registrationMethods: open ? ['email'] : [],
          // A requirement without registration is meaningless; keep the stored
          // value off so re-opening registration cannot resurrect a stale policy.
          emailVerificationRequired: open ? emailVerification : false,
        }),
      });
      if (!res.ok) throw new Error(String((await res.json()).error ?? ''));
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
      <p className="text-sm text-muted-foreground">{tr('settings.description')}</p>
      <section className="plugin-section space-y-5">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox checked={open} onCheckedChange={(checked) => setOpen(checked === true)} />
          <span>
            <strong className="font-medium">{tr('settings.registration')}</strong>
            <span className="mt-1 block text-muted-foreground">
              {tr('settings.registrationHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            checked={emailVerification}
            disabled={!supported || !open}
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
            {blocked ? (
              <span className="plugin-warning mt-1 block">
                {tr('settings.emailVerificationBlocked')}
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
        <p className="text-xs text-muted-foreground">{tr('settings.methodLocked')}</p>
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? tr('settings.saving') : tr('settings.save')}
        </Button>
      </section>
    </main>
  );
}

export const adminPages = { 'admin/settings': LoginSettings } as const;
