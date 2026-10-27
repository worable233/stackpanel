'use client';

import { useActionState, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@animate-ui/react/primitives/base-ui/radio-group';
import { Toggle } from '@animate-ui/react/primitives/base-ui/toggle';
import { ToggleGroup } from '@animate-ui/react/primitives/base-ui/toggle-group';
import { CreditCard, LoaderCircle, Wallet } from 'lucide-react';
import { Button } from './button.js';
import { Input } from './input.js';
import { Field, FieldGroup, FieldSet, FieldLegend } from './field.js';
import { Label } from './label.js';

export interface WalletRechargeMethod {
  providerId: string;
  providerName: string;
  id: string;
  label: string;
  amounts?: number[];
}

/**
 * Fixed copy for the recharge form.
 *
 * `@stackpanel/ui` ships no interface translations (ADR-0016 §6): the plugin
 * that owns the page resolves these from its own catalog and passes final
 * strings. `{currency}` in `amountLabel` is replaced by `currency` below.
 */
export interface WalletRechargeLabels {
  amountLabel: string;
  presetsAria: string;
  paymentMethod: string;
  noMethods: string;
  submitting: string;
  submit: string;
}

export function WalletRecharge({
  methods,
  action,
  cancelLink,
  labels,
  currency = 'CNY',
}: {
  methods: WalletRechargeMethod[];
  action?: (data: FormData) => Promise<void>;
  cancelLink: React.ReactNode;
  /** Localized copy. See {@link WalletRechargeLabels}. */
  labels: WalletRechargeLabels;
  /** ISO 4217 code shown in the amount label. */
  currency?: string;
}) {
  const [amount, setAmount] = useState('50.00');
  const [selected, setSelected] = useState('0');
  const method = methods[Number(selected)];
  const presets = method?.amounts?.length ? method.amounts : [1000, 5000, 10000, 50000];
  const [, submit, pending] = useActionState(async (_: null, data: FormData) => {
    if (action && method) await action(data);
    return null;
  }, null);

  return (
    <form action={submit} className="flex flex-col gap-8">
      <FieldGroup>
        <Field>
          <Label htmlFor="topup-amount">
            {labels.amountLabel.replace('{currency}', currency)}
          </Label>
          <Input
            id="topup-amount"
            name="amount"
            type="number"
            inputMode="decimal"
            min="1"
            max="20000000"
            step="0.01"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="max-w-xs"
            disabled={pending}
          />
          <ToggleGroup
            aria-label={labels.presetsAria}
            value={
              presets.some((value) => value / 100 === Number(amount))
                ? [String(Number(amount))]
                : []
            }
            onValueChange={(values) => {
              if (values[0]) setAmount(Number(values[0]).toFixed(2));
            }}
            disabled={pending}
            className="mt-2 flex flex-wrap gap-2"
          >
            {presets.map((value) => (
              <Toggle
                key={value}
                value={String(value / 100)}
                className="inline-flex h-9 min-w-20 items-center justify-center rounded-lg border border-input px-4 text-sm font-medium transition-colors hover:bg-muted data-pressed:border-primary/30 data-pressed:bg-primary/10 data-pressed:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(value / 100).toFixed(2)}
              </Toggle>
            ))}
          </ToggleGroup>
        </Field>
        <FieldSet className="mt-3">
          <FieldLegend>{labels.paymentMethod}</FieldLegend>
          {methods.length ? (
            <RadioGroup
              aria-label={labels.paymentMethod}
              value={selected}
              onValueChange={setSelected}
              disabled={pending}
              className="grid gap-3 sm:grid-cols-2"
            >
              {methods.map((option, index) => (
                <label
                  key={option.providerId + ':' + option.id}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-input p-5 transition-colors has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5 hover:bg-muted/50"
                >
                  <CreditCard
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.providerName}</span>
                  </span>
                  <Radio.Root
                    value={String(index)}
                    className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input data-checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Radio.Indicator className="size-2 rounded-full bg-primary" />
                  </Radio.Root>
                </label>
              ))}
            </RadioGroup>
          ) : (
            <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-muted-foreground">
              <Wallet className="size-5 opacity-50" aria-hidden="true" />
              <p className="text-sm">{labels.noMethods}</p>
            </div>
          )}
        </FieldSet>
      </FieldGroup>
      {method && (
        <>
          <input type="hidden" name="providerId" value={method.providerId} />
          <input type="hidden" name="paymentMethod" value={method.id} />
        </>
      )}
      <div className="flex items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={!method || !action || pending}>
          {pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
          {pending ? labels.submitting : labels.submit}
        </Button>
        {cancelLink}
      </div>
    </form>
  );
}
