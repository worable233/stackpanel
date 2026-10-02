'use client';

import { useState, useTransition } from 'react';
import type {
  FrontendSettings,
  FrontendSettingsField,
  FrontendSettingsGroup,
  FrontendSettingsSchema,
} from '@stackpanel/sdk';
import type { FrontendSettingsActionState } from '@/lib/frontend-settings-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';

interface SettingsFormProps {
  schema: FrontendSettingsSchema;
  initial: FrontendSettings;
  save: (settings: FrontendSettings) => Promise<FrontendSettingsActionState>;
}

/** Schema-driven settings form shared by theme and plugin admin pages. */
export function SettingsForm({ schema, initial, save }: SettingsFormProps) {
  const t = useTranslator();
  const [values, setValues] = useState<FrontendSettings>(initial);
  const [state, setState] = useState<FrontendSettingsActionState>({});
  const [pending, startTransition] = useTransition();

  const update = (group: string, name: string, value: string | number | boolean) => {
    setValues((current) => ({
      ...current,
      [group]: { ...(current[group] ?? {}), [name]: value },
    }));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          setState(await save(values));
        });
      }}
      className="space-y-8"
    >
      {schema.groups.map((group) => (
        <SettingsGroup
          key={group.id}
          group={group}
          values={values[group.id] ?? {}}
          onChange={update}
        />
      ))}
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? (
        <p className="text-sm text-muted-foreground">{t('settingsForm.saved')}</p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? t('settingsForm.saving') : t('settingsForm.submit')}
      </Button>
    </form>
  );
}

function SettingsGroup({
  group,
  values,
  onChange,
}: {
  group: FrontendSettingsGroup;
  values: Record<string, string | number | boolean>;
  onChange: (group: string, name: string, value: string | number | boolean) => void;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-5 text-card-foreground">
      <h2 className="text-base font-semibold">{group.label}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {group.fields.map((field) => (
          <SettingsField
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(value) => onChange(group.id, field.name, value)}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsField({
  field,
  value,
  onChange,
}: {
  field: FrontendSettingsField;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
}) {
  const current = value ?? defaultFor(field);
  if (field.type === 'textarea') {
    return (
      <div className="space-y-1">
        <Label htmlFor={field.name}>{field.label}</Label>
        <textarea
          id={field.name}
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={String(current)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  if (field.type === 'select') {
    return (
      <div className="space-y-1">
        <Label htmlFor={field.name}>{field.label}</Label>
        <select
          id={field.name}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={String(current)}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(current)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  }
  if (field.type === 'number') {
    return (
      <div className="space-y-1">
        <Label htmlFor={field.name}>{field.label}</Label>
        <Input
          id={field.name}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={String(current)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    );
  }
  if (field.type === 'radio') {
    return (
      <div className="space-y-1">
        <span className="text-sm font-medium">{field.label}</span>
        <div className="flex flex-wrap gap-3">
          {field.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={field.name}
                checked={current === option.value}
                onChange={() => onChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={field.name}>{field.label}</Label>
      <Input
        id={field.name}
        type={field.type === 'color' ? 'color' : 'text'}
        value={String(current)}
        placeholder={field.type === 'text' ? field.placeholder : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function defaultFor(field: FrontendSettingsField): string | number | boolean {
  if (field.type === 'number') return field.default ?? 0;
  if (field.type === 'boolean') return field.default ?? false;
  if (field.type === 'select' || field.type === 'radio') {
    return field.default ?? field.options[0]?.value ?? '';
  }
  return field.default ?? '';
}
