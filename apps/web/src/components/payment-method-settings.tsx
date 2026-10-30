'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, Plus, Trash2 } from 'lucide-react';
import type {
  AdminPaymentMethod,
  AdminSalesChannel,
  AdminSalesChannelListResponse,
} from '@stackpanel/sdk';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Select } from '@stackpanel/ui';
import { useTranslator } from '@/i18n/provider';
import {
  createPaymentMethodAction,
  deletePaymentMethodAction,
  togglePaymentMethodAction,
  updatePaymentMethodAction,
  type SettingsActionState,
} from '@/lib/settings-actions';

/**
 * Payment-method administration.
 *
 * Without this panel the `payment_methods` table is unreachable from the UI, and
 * a manual provider (bank transfer / QR) can therefore never be configured. That
 * is not a cosmetic gap: a manual payment has no `paymentUrl`, so the configured
 * row *is* the entire payment step. An unconfigured manual method produced an
 * order the buyer could never pay.
 *
 * The panel works on the admin API shape, which keeps provider `config` visible.
 * Collection details are edited as discrete fields rather than a JSON blob so a
 * typo cannot silently produce an order with nothing to pay with.
 */
type PaymentProviderOption = NonNullable<AdminSalesChannelListResponse['providers']>[number];

export function PaymentMethodSettings({
  channels,
  providers = [],
}: {
  channels: AdminSalesChannel[];
  providers?: PaymentProviderOption[];
}) {
  const t = useTranslator();
  const router = useRouter();
  const [isMutating, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  function run(work: () => Promise<SettingsActionState>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (result.error) setError(result.error);
      if (result.ok && result.message) setNotice(result.message);
      if (result.ok) {
        setCreating(false);
        setEditing(null);
        router.refresh();
      }
    });
  }

  const methods = channels.flatMap((channel) =>
    channel.methods.map((method) => ({ channel, method })),
  );

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">{t('admin.settings.payment.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('admin.settings.payment.description')}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={isMutating || channels.length === 0}
            onClick={() => {
              setCreating((value) => !value);
              setEditing(null);
            }}
          >
            <Plus className="size-4" />
            {t('admin.settings.payment.add')}
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {channels.length === 0 ? (
        <Alert>
          <AlertDescription>{t('admin.settings.payment.noChannel')}</AlertDescription>
        </Alert>
      ) : null}

      {creating && channels.length > 0 ? (
        <PaymentMethodForm
          channels={channels}
          providers={providers}
          pending={isMutating}
          submitLabel={t('admin.settings.payment.create')}
          onCancel={() => setCreating(false)}
          onSubmit={(formData) =>
            run(() => createPaymentMethodAction({}, formData))
          }
        />
      ) : null}

      {methods.length === 0 && !creating ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <CreditCard className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('admin.settings.payment.empty')}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t('admin.settings.payment.emptyHint')}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        {methods.map(({ channel, method }) =>
          editing === method.id ? (
            <PaymentMethodForm
              key={method.id}
              channels={channels}
              providers={providers}
              method={method}
              pending={isMutating}
              submitLabel={t('admin.settings.payment.save')}
              onCancel={() => setEditing(null)}
              onSubmit={(formData) => run(() => updatePaymentMethodAction({}, formData))}
            />
          ) : (
            <PaymentMethodRow
              key={method.id}
              channel={channel}
              method={method}
              pending={isMutating}
              onEdit={() => {
                setEditing(method.id);
                setCreating(false);
              }}
              onToggle={(enabled) =>
                run(() => togglePaymentMethodAction(method.id, enabled))
              }
              onDelete={() => run(() => deletePaymentMethodAction(method.id))}
            />
          ),
        )}
      </div>
    </section>
  );
}

/** Read the collection detail keys this panel manages out of the stored config. */
function configValue(method: AdminPaymentMethod, key: string): string {
  const config = method.config;
  if (!config || typeof config !== 'object') return '';
  const value = (config as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

const CONFIG_FIELDS = [
  ['payee', '收款户名'], // i18n-exempt — stored config key, not UI copy
  ['bankName', '开户行'], // i18n-exempt — stored config key, not UI copy
  ['account', '账号'], // i18n-exempt — stored config key, not UI copy
  ['note', '备注'], // i18n-exempt — stored config key, not UI copy
  ['qrImage', '收款码'], // i18n-exempt — stored config key, not UI copy
] as const;

function PaymentMethodRow({
  channel,
  method,
  pending,
  onEdit,
  onToggle,
  onDelete,
}: {
  channel: AdminSalesChannel;
  method: AdminPaymentMethod;
  pending: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const t = useTranslator();
  const details = CONFIG_FIELDS.map(([field, key]) => ({
    field,
    key,
    value: configValue(method, key),
  })).filter((entry) => entry.value);

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-muted/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{method.name}</p>
            <Badge variant="secondary">{method.providerId}</Badge>
            <Badge variant="outline">{channel.name}</Badge>
            {method.enabled ? null : (
              <Badge variant="outline">{t('admin.settings.payment.disabled')}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {method.currencies.length
              ? method.currencies.join(' / ')
              : t('admin.settings.payment.allCurrencies')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={method.enabled}
            disabled={pending}
            onCheckedChange={(checked) => onToggle(checked)}
            aria-label={t('admin.settings.payment.enabled')}
          />
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onEdit}>
            {t('common.edit')}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button type="button" variant="outline" size="sm" disabled={pending}>
                  <Trash2 className="size-3.5" />
                  {t('common.delete')}
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('admin.settings.payment.confirmDelete')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('admin.settings.payment.confirmDeleteHint')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>{t('common.delete')}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {details.length ? (
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {details.map((entry) => (
            <div key={entry.field} className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">{entry.key}</dt>
              <dd className="break-all">{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : method.providerMode === 'gateway' ? null : (
        /*
         * Only manual providers are warned about here. A gateway keeps its
         * credentials in its own plugin settings and returns a `paymentUrl`, so
         * an empty `config` is expected — warning on it would be noise. A
         * manual provider has no gateway: with no details configured the buyer
         * gets an order and no way to pay it.
         */
        <Alert>
          <AlertDescription>
            {method.providerMode === 'manual'
              ? t('admin.settings.payment.missingConfig')
              : t('admin.settings.payment.providerMissing')}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PaymentMethodForm({
  channels,
  providers,
  method,
  pending,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  channels: AdminSalesChannel[];
  providers: PaymentProviderOption[];
  method?: AdminPaymentMethod;
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
}) {
  const t = useTranslator();
  return (
    <form
      className="flex flex-col gap-4 rounded-2xl bg-muted/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      {method ? <input type="hidden" name="id" value={method.id} /> : null}
      <FieldGroup>
        {method ? null : (
          <>
            <Field>
              <Label htmlFor="payment-channel">
                {t('admin.settings.payment.channel')}
              </Label>
              <Select
                id="payment-channel"
                name="channelId"
                defaultValue={channels[0]?.id ?? ''}
                className="h-10 bg-muted/40"
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name} ({channel.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <Label htmlFor="payment-provider">
                {t('admin.settings.payment.provider')}
              </Label>
              {providers.length > 0 ? (
                /*
                 * Prefer the live catalogue: a hand-typed provider id is only
                 * rejected on save, and a typo produces a row that looks
                 * configured but can never be used at checkout.
                 */
                <Select
                  id="payment-provider"
                  name="providerId"
                  defaultValue={providers[0]?.id ?? ''}
                  className="h-10 bg-muted/40"
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} ({provider.id})
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="payment-provider"
                  name="providerId"
                  required
                  placeholder="manual / epay"
                />
              )}
              <FieldDescription>{t('admin.settings.payment.providerHint')}</FieldDescription>
            </Field>
          </>
        )}
        <Field>
          <Label htmlFor="payment-name">{t('admin.settings.payment.name')}</Label>
          <Input
            id="payment-name"
            name="name"
            required
            defaultValue={method?.name ?? ''}
            placeholder={t('admin.settings.payment.namePlaceholder')}
          />
        </Field>
        <Field>
          <Label htmlFor="payment-currencies">
            {t('admin.settings.payment.currencies')}
          </Label>
          <Input
            id="payment-currencies"
            name="currencies"
            defaultValue={method?.currencies.join(',') ?? ''}
            placeholder="CNY, USD" // i18n-exempt — example currency codes
          />
          <FieldDescription>{t('admin.settings.payment.currenciesHint')}</FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Label htmlFor="payment-enabled">
            {t('admin.settings.payment.enabled')}
          </Label>
          <Switch id="payment-enabled" name="enabled" defaultChecked={method?.enabled ?? true} />
        </Field>
      </FieldGroup>

      {method?.providerMode === 'gateway' ? (
        /*
         * A gateway stores its credentials in its own plugin settings, so there
         * is nothing for this panel to edit. Rendering the collection fields
         * anyway invites operators to "fill them in", and the values would then
         * be ignored by the provider.
         */
        <div className="border-t pt-4">
          <p className="text-sm text-muted-foreground">
            {t('admin.settings.payment.gatewayConfigNote')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">{t('admin.settings.payment.collectionTitle')}</p>
          <p className="text-sm text-muted-foreground">
            {t('admin.settings.payment.collectionHint')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {CONFIG_FIELDS.map(([field, label]) => (
              <Field key={field}>
                <Label htmlFor={`payment-${field}`}>{label}</Label>
                <Input
                  id={`payment-${field}`}
                  name={field}
                  defaultValue={method ? configValue(method, label) : ''}
                />
                {field === 'qrImage' ? (
                  // The app's CSP allows images from its own origin only, so a
                  // pasted external QR URL cannot be embedded on the order page.
                  <FieldDescription>
                    {t('admin.settings.payment.qrHint')}
                  </FieldDescription>
                ) : null}
              </Field>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
