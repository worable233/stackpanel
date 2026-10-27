'use client';

import { useState, useTransition } from 'react';
import type {
  FrontendSettings,
  FrontendSettingsField,
  FrontendSettingsGroup,
  FrontendSettingsListItem,
  FrontendSettingsScalar,
  FrontendSettingsScalarField,
  FrontendSettingsSchema,
  FrontendSettingsValue,
} from '@stackpanel/sdk';
import type { FrontendSettingsActionState } from '@/lib/frontend-settings-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import { Select } from '@stackpanel/ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

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
  const [activeGroup, setActiveGroup] = useState(schema.groups[0]?.id ?? '');

  const update = (group: string, name: string, value: FrontendSettingsValue) => {
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
      className="flex flex-col gap-6"
    >
      <Tabs
        value={activeGroup}
        onValueChange={setActiveGroup}
        orientation="vertical"
        className="flex min-w-0 flex-col gap-6 lg:flex-row"
      >
        {schema.groups.length > 1 ? (
          <TabsList className="scrollbar-none flex h-auto w-full flex-row gap-1 overflow-x-auto rounded-none bg-transparent p-0 lg:w-44 lg:flex-col lg:overflow-visible">
            {schema.groups.map((group) => (
              <TabsTrigger
                key={group.id}
                value={group.id}
                className="h-10 w-full flex-none justify-start rounded-lg px-3 text-sm font-normal whitespace-nowrap text-muted-foreground data-active:bg-muted data-active:font-medium data-active:text-foreground after:hidden hover:bg-muted/60 hover:text-foreground"
              >
                {group.label ?? group.id}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : null}

        <div className="min-w-0 flex-1">
          {schema.groups.map((group) => (
            <TabsContent key={group.id} value={group.id} className="m-0 max-w-3xl">
              <SettingsGroup
                group={group}
                values={values[group.id] ?? {}}
                onChange={update}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-xl bg-background/90 py-3 backdrop-blur">
        <Button type="submit" disabled={pending}>
          {pending ? t('settingsForm.saving') : t('settingsForm.submit')}
        </Button>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-muted-foreground">{t('settingsForm.saved')}</p> : null}
      </div>
    </form>
  );
}

function SettingsGroup({
  group,
  values,
  onChange,
}: {
  group: FrontendSettingsGroup;
  values: Record<string, FrontendSettingsValue>;
  onChange: (group: string, name: string, value: FrontendSettingsValue) => void;
}) {
  return (
    <section className="flex flex-col gap-5 rounded-2xl bg-muted/40 p-5 text-card-foreground">
      <h2 className="text-base font-semibold">{group.label ?? group.id}</h2>
      <div className="grid gap-5 sm:grid-cols-2">
        {group.fields.map((field) => (
          <div
              key={field.name}
              className={
                field.type === 'list' || field.type === 'boolean'
                  ? 'sm:col-span-2'
                  : undefined
              }
            >
            <SettingsField
              field={field}
              value={values[field.name]}
              onChange={(value) => onChange(group.id, field.name, value)}
            />
          </div>
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
  value: FrontendSettingsValue | undefined;
  onChange: (value: FrontendSettingsValue) => void;
}) {
  if (field.type === 'list') {
    return <ListField field={field} value={value} onChange={onChange} />;
  }
  return (
    <ScalarField
      field={field}
      value={value as FrontendSettingsScalar | undefined}
      onChange={(value) => onChange(value)}
    />
  );
}

function ListField({
  field,
  value,
  onChange,
}: {
  field: Extract<FrontendSettingsField, { type: 'list' }>;
  value: FrontendSettingsValue | undefined;
  onChange: (value: FrontendSettingsValue) => void;
}) {
  const t = useTranslator();
  const rows: FrontendSettingsListItem[] = Array.isArray(value) ? value : (field.default ?? []);

  const emptyRow = (): FrontendSettingsListItem => {
    const row: FrontendSettingsListItem = {};
    for (const sub of field.fields) {
      row[sub.name] = defaultFor(sub);
    }
    return row;
  };

  const updateRow = (index: number, name: string, next: FrontendSettingsValue) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [name]: next } : row)));
  };

  return (
    <div className="space-y-3">
      <span className="text-sm font-medium">{field.label}</span>
      {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={index} className="rounded-xl bg-background p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {(field.itemLabelField ? String(row[field.itemLabelField] ?? '') : '') ||
                  `${field.label} ${index + 1}`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                {t('settingsForm.removeItem')}
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {field.fields.map((sub) => (
                <SettingsField
                  key={sub.name}
                  field={sub}
                  value={row[sub.name]}
                  onChange={(next) => updateRow(index, sub.name, next)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, emptyRow()])}
      >
        + {t('settingsForm.addItem')}
      </Button>
    </div>
  );
}

function ScalarField({
  field,
  value,
  onChange,
}: {
  field: FrontendSettingsScalarField;
  value: FrontendSettingsScalar | undefined;
  onChange: (value: FrontendSettingsScalar) => void;
}) {
  const current = value ?? defaultFor(field);
  if (field.type === 'textarea') {
    return (
      <div className="space-y-1">
        <Label htmlFor={field.name}>{field.label}</Label>
        <textarea
          id={field.name}
          className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
        <Select
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
        </Select>
      </div>
    );
  }
  if (field.type === 'boolean') {
    return (
      <label className="flex items-start gap-3 rounded-xl bg-background px-4 py-3 text-sm">
        <Checkbox
          checked={Boolean(current)}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <span className="min-w-0">
          <span className="font-medium">{field.label}</span>
          {field.help ? (
            <span className="mt-1 block text-xs text-muted-foreground">{field.help}</span>
          ) : null}
        </span>
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
      <div className="space-y-2">
        <span className="text-sm font-medium">{field.label}</span>
        <RadioGroup
          value={String(current)}
          onValueChange={(value) => onChange(String(value))}
        >
          {field.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <RadioGroupItem value={option.value} />
              {option.label}
            </label>
          ))}
        </RadioGroup>
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

function defaultFor(field: FrontendSettingsField): FrontendSettingsValue {
  if (field.type === 'list') return structuredClone(field.default ?? []);
  if (field.type === 'number') return field.default ?? 0;
  if (field.type === 'boolean') return field.default ?? false;
  if (field.type === 'select' || field.type === 'radio') {
    return field.default ?? field.options[0]?.value ?? '';
  }
  return field.default ?? '';
}
