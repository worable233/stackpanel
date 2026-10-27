'use client';

import { SectionTitle, Select } from '@stackpanel/ui';
import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminCurrencyDefinitionView,
  AdminFxRateView,
  SettlementCurrencyResponse,
} from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import { Input } from '@/components/ui/input';
import {
  deleteCurrencyRateAction,
  saveCurrencyRateAction,
  saveSettlementCurrencyAction,
  setCurrencyEnabledAction,
  type SettingsActionState,
} from '@/lib/settings-actions';

/**
 * Currency governance panel (PLAN-currency §5): settlement currency selection
 * plus the catalog with enable/disable. Disabled rows explain why they may be
 * locked (settlement or referenced by existing data).
 */
export function CurrencySettings({
  catalog,
  rates = [],
}: {
  catalog: SettlementCurrencyResponse & { currencies?: AdminCurrencyDefinitionView[] };
  rates?: AdminFxRateView[];
}) {
  const t = useTranslator();
  const router = useRouter();
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    saveSettlementCurrencyAction,
    {},
  );
  const [isMutating, startTransition] = useTransition();
  const [rateError, setRateError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const candidates = catalog.candidates ?? [];
  const currencies = catalog.currencies ?? [];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <SectionTitle>{t('admin.settings.currency.title')}</SectionTitle>
        <p className="text-sm text-muted-foreground">{t('admin.settings.currency.description')}</p>
      </div>

      <form
        action={(formData) => {
          startTransition(async () => {
            await action(formData);
            router.refresh();
          });
        }}
        className="flex flex-col gap-3"
      >
        <Label htmlFor="settlementCurrency">{t('admin.settings.currency.settlement')}</Label>
        <Select
          id="settlementCurrency"
          name="currency"
          defaultValue={catalog.settlementCurrency}
          className="h-10 w-full rounded-xl bg-muted/40 px-3 text-sm"
        >
          {candidates.map((candidate) => (
            <option key={candidate.code} value={candidate.code}>
              {candidate.code} · {candidate.name}（{candidate.symbol}，{candidate.minorUnit}{' '}
              {t('admin.settings.currency.decimals')}）
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          {t('admin.settings.currency.settlementHint')}
        </p>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok && state.message ? (
          <p className="text-sm text-emerald-600">{state.message}</p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending || isMutating}>
            {t('action.save')}
          </Button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-2xl bg-muted/40 p-1">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.code')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.symbol')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.decimals')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.sample')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.status')}</th>
            </tr>
          </thead>
          <tbody>
            {currencies.map((currency) => {
              return (
                <tr key={currency.code} className="odd:bg-background/40">
                  <td className="px-4 py-2.5">
                    <span className="font-mono">{currency.code}</span>
                    <span className="ml-2 text-muted-foreground">{currency.name}</span>
                  </td>
                  <td className="px-4 py-2.5">{currency.symbol}</td>
                  <td className="px-4 py-2.5">{currency.minorUnit}</td>
                  <td className="px-4 py-2.5 tabular-nums">{currency.sample}</td>
                  <td className="px-4 py-2.5">
                    {currency.settlement ? (
                      <span className="text-xs text-muted-foreground">
                        {t('admin.settings.currency.isSettlement')}
                      </span>
                    ) : currency.referenced ? (
                      <span className="text-xs text-muted-foreground">
                        {t('admin.settings.currency.referenced')}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isMutating}
                        onClick={() => {
                          startTransition(async () => {
                            const result = await setCurrencyEnabledAction(
                              currency.code,
                              !currency.enabled,
                            );
                            setToggleError(result.error ?? null);
                            router.refresh();
                          });
                        }}
                      >
                        {currency.enabled
                          ? t('admin.settings.currency.disable')
                          : t('admin.settings.currency.enable')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {toggleError ? <p className="text-sm text-destructive">{toggleError}</p> : null}

      <div className="flex flex-col gap-1">
        <SectionTitle>{t('admin.settings.currency.ratesTitle')}</SectionTitle>
        <p className="text-sm text-muted-foreground">
          {t('admin.settings.currency.ratesDescription')}
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-muted/40 p-1">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.from')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.to')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.rate')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.source')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.updatedAt')}</th>
              <th className="px-4 py-2.5 font-medium">{t('admin.settings.currency.validUntil')}</th>
              <th className="px-4 py-2.5 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rates.length ? (
              rates.map((rate) => (
                <tr key={rate.id} className="odd:bg-background/40">
                  <td className="px-4 py-2.5 font-mono">{rate.fromCurrency}</td>
                  <td className="px-4 py-2.5 font-mono">{rate.toCurrency}</td>
                  <td className="px-4 py-2.5 tabular-nums">{(rate.rate / 1_000_000).toFixed(6)}</td>
                  <td className="px-4 py-2.5">{rate.source}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {new Date(rate.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {rate.validUntil
                      ? new Date(rate.validUntil).toLocaleString()
                      : t('admin.settings.currency.noExpiry')}
                  </td>
                  <td className="px-4 py-2.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isMutating}
                      onClick={() => {
                        startTransition(async () => {
                          const result = await deleteCurrencyRateAction(
                            rate.fromCurrency,
                            rate.toCurrency,
                          );
                          if (result.error) setRateError(result.error);
                          router.refresh();
                        });
                      }}
                    >
                      {t('admin.settings.currency.delete')}
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                  {t('admin.settings.currency.noRates')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form
        action={(formData) => {
          startTransition(async () => {
            const result = await saveCurrencyRateAction({}, formData);
            setRateError(result.error ?? null);
            router.refresh();
          });
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rate-from">{t('admin.settings.currency.from')}</Label>
          <Select
            id="rate-from"
            name="fromCurrency"
            className="h-10 w-28 rounded-xl bg-muted/40 px-3 text-sm"
          >
            {currencies
              .filter((currency) => currency.code !== catalog.settlementCurrency)
              .map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code}
                </option>
              ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rate-value">{t('admin.settings.currency.rate')}</Label>
          <Input
            id="rate-value"
            name="rate"
            type="number"
            step="0.000001"
            min="0.000001"
            required
            className="w-36"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rate-expiry">{t('admin.settings.currency.validUntil')}</Label>
          <Input id="rate-expiry" name="validUntil" type="datetime-local" className="w-52" />
        </div>
        <Button type="submit" disabled={isMutating}>
          {t('admin.settings.currency.addRate')}
        </Button>
        {rateError ? <p className="w-full text-sm text-destructive">{rateError}</p> : null}
      </form>
    </section>
  );
}
