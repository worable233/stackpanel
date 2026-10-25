'use client';
import { SectionTitle } from '@stackpanel/ui';

import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  formatMinorCurrency,
  minorUnitFor,
  minorUnitsToPlainString,
  PACKAGE_FALLBACK_LOCALE,
  toMinorUnits,
} from '@stackpanel/sdk';
import type { AdminPageComponentProps, ProductConfigField } from '@stackpanel/sdk';
import {
  FeatureOverview,
  Button,
  Card,
  ConfirmDialog,
  CardHeader,
  CardTitle,
  StatusBadge,
  CardDescription,
  CardContent,
  Field,
  FieldGroup,
  FieldError,
  Input,
  Label,
  PageHeader,
  Select,
  InlineError,
} from '@stackpanel/ui';
import { Package, Pencil, Plus, RefreshCw, Save, Search } from 'lucide-react';
import { t } from './i18n.js';
import { approvalErrorMessage } from './approval-feedback.js';

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  cost: number | null;
  originalPrice: number | null;
  discount: number | null;
  fulfillmentType: string;
  providerId: string | null;
  providerProductId: string | null;
  metadata: Record<string, unknown> | null;
}

/** 读取商品 metadata.upstream.sourcePrice（上游源价，分）。 */
function upstreamSourcePrice(product: ProductRow): number | null {
  const upstream = product.metadata?.['upstream'];
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) return null;
  const value = (upstream as Record<string, unknown>)['sourcePrice'];
  return typeof value === 'number' ? value : null;
}

interface CurrencyOption {
  code: string;
  name: string;
  symbol: string;
  minorUnit: number;
}

interface ProductTypeInfo {
  id: string;
  label: string;
  pluginId: string;
  configFields: ProductConfigField[];
}

interface UpstreamSourceInfo {
  id: string;
  name: string;
}

interface UpstreamItem {
  id: string;
  name: string;
  price: number | null;
  stock?: number;
  currency?: string;
  sourceRef?: string;
  description?: string | null;
  icon?: string | null;
  specs?: Record<string, unknown>;
}

function upstreamSpecsSummary(specs: Record<string, unknown> | undefined): string | null {
  if (!specs) return null;
  const entries = Object.entries(specs).filter(([, value]) => value !== null && value !== '');
  if (entries.length === 0) return null;
  return entries
    .slice(0, 6)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    )
    .join(' · ');
}

/** Format minor units through the kernel catalog (no `/100`, no CNY branch). */
function money(n: number, currency: string, locale: string | undefined): string {
  try {
    // The host negotiates the locale; zh-CN is the same catalog fallback `t()` uses.
    return formatMinorCurrency(n, currency, locale ?? PACKAGE_FALLBACK_LOCALE);
  } catch {
    return `${n} ${currency}`;
  }
}

/** Parse a major-unit input using the currency's catalog precision. */
function amountToMinor(value: string, currency: string): number | null {
  try {
    return toMinorUnits(value, currency);
  } catch {
    return null;
  }
}

/** Seed an editable input from stored minor units. */
function minorToInput(n: number, currency: string): string {
  try {
    return minorUnitsToPlainString(n, currency);
  } catch {
    // Unknown legacy currency: show the raw minor amount rather than assume 2
    // decimals (the currency itself cannot be resolved).
    return String(n);
  }
}

/** Built-in product type -> message id (fallback when no type plugin claims it). */
const BUILTIN_TYPE_LABELS: Record<string, string> = {
  delivery: 'adminType.delivery',
};

function builtinTypeLabel(type: string, tr: ReturnType<typeof t>): string | undefined {
  const key = BUILTIN_TYPE_LABELS[type];
  return key ? tr(key) : undefined;
}

/** 把点路径写进嵌套对象：setPath(obj, 'specs.cpu', 2) → obj.specs.cpu = 2 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index] ?? '';
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] ?? ''] = value;
}

/** 从嵌套对象读点路径值。 */
function getPath(target: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!target) return undefined;
  return path.split('.').reduce<unknown>((cursor, key) => {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    return (cursor as Record<string, unknown>)[key];
  }, target);
}

/** 是否满足字段的 visibleWhen 条件（相对同一表单作用域）。 */
function isFieldVisible(field: ProductConfigField, scope: Record<string, unknown>): boolean {
  const rule = field.visibleWhen;
  if (!rule) return true;
  const current = getPath(scope, rule.field);
  if (rule.equals !== undefined) return current === rule.equals;
  if (rule.in !== undefined) return rule.in.includes(current);
  return current !== undefined && current !== null && current !== '';
}

/** 叶子控件渲染：type=group/repeat 由 ConfigFields 递归处理，不走这里。 */
function ConfigFieldControl({
  field,
  value,
  onChange,
  tr,
}: {
  field: ProductConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
  tr: ReturnType<typeof t>;
}) {
  const text = value === undefined || value === null ? '' : String(value);
  if (field.type === 'textarea' || field.type === 'json') {
    return (
      <textarea
        value={
          field.type === 'json' && typeof value === 'object' ? JSON.stringify(value, null, 2) : text
        }
        onChange={(e) => {
          if (field.type === 'json') {
            const raw = e.target.value.trim();
            if (raw === '') return onChange(undefined);
            try {
              onChange(JSON.parse(raw) as unknown);
            } catch {
              onChange(e.target.value);
            }
            return;
          }
          onChange(e.target.value);
        }}
        placeholder={field.placeholder}
        spellCheck={false}
        className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        rows={field.type === 'json' ? 5 : 3}
      />
    );
  }
  if (field.type === 'select') {
    return (
      <Select value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tr('common.select')}</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? (value as unknown[]).map((v) => String(v)) : [];
    return (
      <div className="flex flex-wrap gap-1.5 rounded-lg border p-2">
        {(field.options ?? []).map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                checked ? 'border-primary bg-primary/10 text-primary' : 'bg-muted/40'
              }`}
            >
              <input
                type="checkbox"
                className="hidden"
                checked={checked}
                onChange={() =>
                  onChange(
                    checked
                      ? selected.filter((v) => v !== option.value)
                      : [...selected, option.value],
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  }
  if (field.type === 'boolean') {
    return (
      <Label className="gap-2 font-normal">
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 accent-primary"
        />
        {field.label}
      </Label>
    );
  }
  if (field.type === 'tags') {
    return (
      <Input
        value={Array.isArray(value) ? (value as unknown[]).join(', ') : text}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
        placeholder={field.placeholder ?? tr('editor.tagsPlaceholder')}
      />
    );
  }
  return (
    <Input
      type={field.type === 'number' ? 'number' : 'text'}
      value={text}
      onChange={(e) =>
        onChange(
          field.type === 'number'
            ? e.target.value === ''
              ? undefined
              : Number(e.target.value)
            : e.target.value,
        )
      }
      placeholder={field.placeholder}
      min={field.min}
      max={field.max}
    />
  );
}

/** 递归渲染类型配置字段（分组 / 重复子表单 / 条件显隐），商店通用渲染。 */
function ConfigFields({
  fields,
  scope,
  onChange,
  tr,
}: {
  fields: ProductConfigField[];
  scope: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  tr: ReturnType<typeof t>;
}) {
  // 按 `group` 标签把字段归入分组卡片（连续同名的合并），未命名的原位渲染。
  const buckets: Array<{ group: string | null; fields: ProductConfigField[] }> = [];
  for (const field of fields) {
    if (field.type === 'group' || field.type === 'repeat') {
      buckets.push({ group: null, fields: [field] });
      continue;
    }
    const label = field.group ?? null;
    const last = buckets[buckets.length - 1];
    if (last && last.group === label) last.fields.push(field);
    else buckets.push({ group: label, fields: [field] });
  }

  return (
    <div className="flex flex-col gap-4">
      {buckets.map((bucket) => {
        if (bucket.group !== null) {
          return (
            <fieldset key={`group-${bucket.group}`} className="rounded-lg border bg-muted/30 p-4">
              <legend className="px-1 text-sm font-medium">{bucket.group}</legend>
              <FieldList fields={bucket.fields} scope={scope} onChange={onChange} tr={tr} />
            </fieldset>
          );
        }
        return (
          <FieldList
            key={`fields-${bucket.fields[0]?.name ?? 'root'}`}
            fields={bucket.fields}
            scope={scope}
            onChange={onChange}
            tr={tr}
          />
        );
      })}
    </div>
  );
}

/** 渲染一列字段（分组卡片内或独立）。 */
function FieldList({
  fields,
  scope,
  onChange,
  tr,
}: {
  fields: ProductConfigField[];
  scope: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  tr: ReturnType<typeof t>;
}) {
  function update(name: string, value: unknown): void {
    const next = { ...scope };
    setPath(next, name, value);
    onChange(next);
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        if (!isFieldVisible(field, scope)) return null;
        // columns=1 占半宽，缺省占整行。
        const span = field.columns === 1 ? '' : 'sm:col-span-2';

        if (field.type === 'group') {
          return (
            <fieldset key={field.name} className={`rounded-lg border bg-muted/30 p-4 ${span}`}>
              <legend className="px-1 text-sm font-medium">{field.label}</legend>
              <ConfigFields fields={field.fields ?? []} scope={scope} onChange={onChange} tr={tr} />
            </fieldset>
          );
        }

        if (field.type === 'repeat') {
          const items = Array.isArray(getPath(scope, field.name))
            ? (getPath(scope, field.name) as unknown[])
            : [];
          return (
            <div
              key={field.name}
              className={`flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 ${span}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{field.label}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => update(field.name, [...items, {}])}
                >
                  <Plus className="size-3.5" />
                  {field.itemLabel ?? tr('editor.addItem')}
                </Button>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tr('editor.noItems')}</p>
              ) : null}
              {items.map((item, index) => (
                <div key={index} className="rounded-lg border bg-background p-3">
                  <div className="mb-2 flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update(
                          field.name,
                          items.filter((_, i) => i !== index),
                        )
                      }
                    >
                      {tr('editor.delete')}
                    </Button>
                  </div>
                  <ConfigFields
                    fields={field.fields ?? []}
                    scope={
                      item !== null && typeof item === 'object'
                        ? (item as Record<string, unknown>)
                        : {}
                    }
                    onChange={(nextItem) =>
                      update(
                        field.name,
                        items.map((current, i) => (i === index ? nextItem : current)),
                      )
                    }
                    tr={tr}
                  />
                </div>
              ))}
            </div>
          );
        }

        return (
          <div
            key={field.name}
            className={`${span} ${field.type === 'boolean' ? '' : 'flex flex-col gap-1.5'}`}
          >
            {field.type === 'boolean' ? null : (
              <Label>
                {field.label}
                {field.required ? ' *' : ''}
              </Label>
            )}
            <ConfigFieldControl
              field={field}
              value={getPath(scope, field.name)}
              tr={tr}
              onChange={(value) => {
                const next = { ...scope };
                setPath(next, field.name, value);
                onChange(next);
              }}
            />
            {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

/** 依据类型字段声明构建初始配置对象（含 defaultValue 与已有 metadata）。 */
function initialConfigData(
  fields: ProductConfigField[],
  metadata: Record<string, unknown> | null,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === 'group') {
      // 分组字段与同级共用同一 scope（绝对路径），递归补默认值。
      Object.assign(data, initialConfigData(field.fields ?? [], metadata));
      continue;
    }
    if (field.type === 'repeat') {
      const existing = getPath(metadata, field.name);
      if (Array.isArray(existing)) data[field.name] = existing;
      continue;
    }
    const existing = getPath(metadata, field.name);
    if (existing !== undefined) setPath(data, field.name, existing);
    else if (field.defaultValue !== undefined) setPath(data, field.name, field.defaultValue);
  }
  return data;
}

function ProductForm({
  editing,
  types,
  sources,
  categories,
  initialCategoryIds,
  currencies,
  onDone,
  tr,
  locale,
}: {
  editing: ProductRow | null;
  types: ProductTypeInfo[];
  sources: UpstreamSourceInfo[];
  categories: CategoryNode[];
  initialCategoryIds: string[];
  currencies: CurrencyOption[];
  onDone: () => void;
  tr: ReturnType<typeof t>;
  locale: string | undefined;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(editing?.id ?? null);

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  // Currency drives every amount's precision. Editing an existing product keeps
  // its currency; new products default to the first enabled option (CNY).
  const initialCurrency = editing?.currency ?? currencies[0]?.code ?? 'CNY';
  const [currency, setCurrency] = useState(initialCurrency);
  const [price, setPrice] = useState(editing ? minorToInput(editing.price, editing.currency) : '');
  const [stock, setStock] = useState(editing ? String(editing.stock) : '0');
  const [cost, setCost] = useState(
    editing?.cost != null ? minorToInput(editing.cost, editing.currency) : '',
  );
  const [originalPrice, setOriginalPrice] = useState(
    editing?.originalPrice != null ? minorToInput(editing.originalPrice, editing.currency) : '',
  );
  const [discount, setDiscount] = useState(
    editing?.discount != null ? String(editing.discount) : '',
  );
  const [icon, setIcon] = useState(
    typeof editing?.metadata?.icon === 'string' ? editing.metadata.icon : '',
  );
  const [typeId, setTypeId] = useState(editing?.fulfillmentType || types[0]?.id || '');
  const [configData, setConfigData] = useState<Record<string, unknown>>(() => {
    const meta = editing?.metadata ?? null;
    const type = types.find(
      (candidate) => candidate.id === (editing?.fulfillmentType || types[0]?.id),
    );
    return initialConfigData(type?.configFields ?? [], meta);
  });
  const [providerId, setProviderId] = useState(editing?.providerId ?? '');
  const [providerProductId, setProviderProductId] = useState(editing?.providerProductId ?? '');
  const [upstreamSourceRef, setUpstreamSourceRef] = useState<string | null>(null);
  const [checkoutConfigJson, setCheckoutConfigJson] = useState(() => {
    const config = editing?.metadata?.checkoutConfig;
    return config ? JSON.stringify(config, null, 2) : '';
  });
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(initialCategoryIds);

  const [searchSource, setSearchSource] = useState(sources[0]?.id ?? '');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UpstreamItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingUpstreamConfig, setLoadingUpstreamConfig] = useState(false);

  const currentType = types.find((candidate) => candidate.id === typeId) ?? null;
  const isCloudServer = typeId === 'cloud_server';
  const isUpstreamManaged = Boolean(providerId && providerProductId);

  const runSearch = useCallback(async () => {
    if (!searchSource) return;
    setSearching(true);
    try {
      const response = await fetch(
        `/api/store/upstream-products?provider=${encodeURIComponent(searchSource)}&q=${encodeURIComponent(searchQuery)}`,
        { cache: 'no-store' },
      );
      const json = (await response.json()) as { items?: UpstreamItem[] };
      setSearchResults(Array.isArray(json.items) ? json.items : []);
      setError(null);
    } catch {
      setSearchResults([]);
      setError(tr('editor.upstreamSearchFailed'));
    } finally {
      setSearching(false);
    }
  }, [searchSource, searchQuery, tr]);

  async function pickUpstream(item: UpstreamItem) {
    setLoadingUpstreamConfig(true);
    try {
      const response = await fetch(
        `/api/store/upstream-products/${encodeURIComponent(searchSource)}/${encodeURIComponent(item.id)}/config${item.sourceRef ? `?sourceRef=${encodeURIComponent(item.sourceRef)}` : ''}`,
        { cache: 'no-store' },
      );
      const json = (await response.json()) as { checkoutConfig?: unknown; error?: string };
      if (!response.ok) throw new Error(json.error || tr('editor.upstreamConfigFailed'));
      setProviderId(searchSource);
      setProviderProductId(item.id);
      setUpstreamSourceRef(item.sourceRef ?? null);
      if (item.name) setName(item.name);
      if (item.description) setDescription(item.description);
      if (item.icon) setIcon(item.icon);
      if (item.price != null) setCost(minorToInput(item.price, item.currency ?? currency));
      if (item.stock !== undefined) setStock(String(item.stock));
      if (item.specs) {
        setConfigData((prev) => {
          const next = { ...prev };
          for (const [key, value] of Object.entries(item.specs ?? {})) {
            setPath(next, `specs.${key}`, value);
          }
          return next;
        });
      }
      setCheckoutConfigJson(
        json.checkoutConfig ? JSON.stringify(json.checkoutConfig, null, 2) : '',
      );
      setError(null);
    } catch (cause) {
      console.error('[store] upstream config failed', cause);
      setError(tr('editor.upstreamConfigFailed'));
    } finally {
      setLoadingUpstreamConfig(false);
    }
  }

  function clearUpstream() {
    setProviderId('');
    setProviderProductId('');
    setUpstreamSourceRef(null);
    setSearchResults([]);
  }

  function buildMetadata(): Record<string, unknown> | null {
    const metadata: Record<string, unknown> = { ...editing?.metadata, ...configData };
    delete metadata.icon;
    delete metadata.checkoutConfig;
    if (icon.trim()) metadata.icon = icon.trim();
    const trimmed = checkoutConfigJson.trim();
    if (trimmed) {
      try {
        metadata.checkoutConfig = JSON.parse(trimmed) as unknown;
      } catch {
        setError(tr('editor.invalidCheckoutConfig'));
        return null;
      }
    }
    return metadata;
  }

  function submit() {
    if (!name.trim()) {
      setError(tr('editor.nameRequired'));
      return;
    }
    const parsedPrice = amountToMinor(price, currency);
    if (parsedPrice === null || parsedPrice <= 0) {
      setError(tr('editor.priceRequired'));
      return;
    }
    setError(null);
    const minorUnit = minorUnitFor(currency);
    const optionalAmount = (value: string): number | null => {
      if (!value.trim()) return null;
      const parsed = amountToMinor(value, currency);
      return parsed;
    };
    // Validate cost/original price against this currency's precision, not `/100`.
    const amounts = isUpstreamManaged ? [originalPrice] : [cost, originalPrice];
    if (
      amounts.some(
        (value) => value.trim() && (optionalAmount(value) === null || optionalAmount(value)! < 0),
      )
    ) {
      setError(tr('editor.amountInvalid', { currency, digits: minorUnit }));
      return;
    }
    if (
      !isUpstreamManaged &&
      (!Number.isInteger(Number(stock)) || Number(stock) < 0 || Number(stock) > 1000000)
    ) {
      setError(tr('editor.stockInvalid'));
      return;
    }
    if (
      discount.trim() &&
      (!Number.isInteger(Number(discount)) || Number(discount) < 0 || Number(discount) > 99)
    ) {
      setError(tr('editor.discountInvalid'));
      return;
    }
    const metadata = buildMetadata();
    if (metadata === null) return;
    const body = {
      name: name.trim(),
      description: description.trim(),
      price: parsedPrice,
      currency,
      ...(!isUpstreamManaged ? { stock: Number(stock), cost: optionalAmount(cost ?? '') } : {}),
      originalPrice: optionalAmount(originalPrice ?? ''),
      discount: discount.trim() ? Number(discount) : null,
      ...(typeId ? { fulfillmentType: typeId } : {}),
      providerId: providerId || null,
      providerProductId: providerProductId || null,
      upstreamSourceRef: upstreamSourceRef || undefined,
      metadata,
    };
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/plugins/store/admin/products${savedId ? `/${encodeURIComponent(savedId)}` : ''}`,
          {
            method: savedId ? 'PATCH' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        const result = (await response.json()) as {
          product?: ProductRow;
          message?: string;
          error?: string;
        };
        if (!response.ok || !result.product)
          throw new Error(result.message || result.error || tr('editor.saveFailed'));
        // 分类请求失败后保留新建商品 ID，再次保存只会更新，不会重复创建。
        setSavedId(result.product.id);
        if (categories.length > 0)
          await saveProductCategories(result.product.id, selectedCategoryIds, tr);
        onDone();
      } catch (cause) {
        console.error('[store] product save failed', cause);
        setError(tr('editor.saveFailedRetry'));
      }
    });
  }

  return (
    <form
      id="product-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!isPending) submit();
      }}
      className="flex flex-col gap-6"
      aria-busy={isPending}
    >
      <PageHeader
        backHref="/admin/plugin/store/products"
        backLabel={tr('editor.back')}
        title={editing ? tr('editor.titleEdit') : tr('editor.titleNew')}
        actions={
          <>
            <Button variant="outline" type="button" onClick={onDone} disabled={isPending}>
              {tr('common.cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {isPending ? tr('editor.saving') : tr('editor.save')}
            </Button>
          </>
        }
      />
      {error ? <FieldError>{error}</FieldError> : null}
      <fieldset
        disabled={isPending}
        className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="flex min-w-0 flex-col gap-6">
          {sources.length > 0 ? (
            <Card id="upstream">
              <CardHeader>
                <SectionTitle as="h3">{tr('editor.upstreamTitle')}</SectionTitle>
                <CardDescription>{tr('editor.upstreamDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                {providerId && providerProductId ? (
                  <div className="flex items-center justify-between rounded-lg border bg-primary/5 px-4 py-3 text-sm">
                    <span>
                      {tr('editor.linked')}
                      {sources.find((source) => source.id === providerId)?.name ?? providerId}
                      {' · '}
                      {providerProductId}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={clearUpstream}>
                      {tr('editor.unlink')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                        <Label>{tr('editor.upstream')}</Label>
                        <Select
                          value={searchSource}
                          onChange={(e) => setSearchSource(e.target.value)}
                        >
                          {sources.map((source) => (
                            <option key={source.id} value={source.id}>
                              {source.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                        <Label>{tr('editor.keyword')}</Label>
                        <Input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void runSearch();
                            }
                          }}
                          placeholder={tr('editor.searchPlaceholder')}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void runSearch()}
                        disabled={searching}
                      >
                        {searching ? (
                          <RefreshCw className="size-4 animate-spin" />
                        ) : (
                          <Search className="size-4" />
                        )}
                        {tr('editor.search')}
                      </Button>
                    </div>
                    {searchResults.length > 0 ? (
                      <ul className="divide-y rounded-lg border bg-background">
                        {searchResults.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                          >
                            <div className="min-w-0 space-y-1">
                              <p className="truncate font-medium">{item.name}</p>
                              {item.description ? (
                                <p className="line-clamp-2 text-xs text-muted-foreground">
                                  {item.description}
                                </p>
                              ) : null}
                              {upstreamSpecsSummary(item.specs) ? (
                                <p className="truncate text-xs text-muted-foreground">
                                  {tr('editor.specsInline', {
                                    details: upstreamSpecsSummary(item.specs) ?? '',
                                  })}
                                </p>
                              ) : null}
                              <p className="text-xs text-muted-foreground">
                                {item.id}
                                {item.price != null
                                  ? tr('editor.costInline', {
                                      price: money(item.price, item.currency ?? currency, locale),
                                    })
                                  : ''}
                                {item.stock !== undefined
                                  ? tr('editor.stockInline', { stock: item.stock })
                                  : ''}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={loadingUpstreamConfig}
                              onClick={() => void pickUpstream(item)}
                            >
                              {tr('editor.selectItem')}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {!searching && searchResults.length === 0 && searchQuery !== '' ? (
                      <p className="text-sm text-muted-foreground">
                        {tr('editor.noUpstreamMatches')}
                      </p>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card id="basic">
            <CardHeader>
              <SectionTitle as="h3">{tr('editor.basicTitle')}</SectionTitle>
              <CardDescription>{tr('editor.basicDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <Label htmlFor="product-name">{tr('editor.nameLabel')}</Label>
                  <Input
                    id="product-name"
                    required
                    maxLength={191}
                    placeholder={tr('editor.namePlaceholder')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-description">{tr('editor.descriptionLabel')}</Label>
                  <Input
                    id="product-description"
                    maxLength={191}
                    placeholder={tr('editor.descriptionPlaceholder')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-icon">{tr('editor.iconLabel')}</Label>
                  <Input id="product-icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card id="pricing">
            <CardHeader>
              <SectionTitle as="h3">{tr('editor.pricingTitle')}</SectionTitle>
              <CardDescription>
                {isUpstreamManaged
                  ? tr('editor.pricingUpstreamDescription')
                  : tr('editor.pricingDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid sm:grid-cols-2">
                <Field>
                  <Label htmlFor="product-price">{tr('editor.priceLabel')}</Label>
                  <Input
                    id="product-price"
                    required
                    type="number"
                    step={minorUnitFor(currency) === 0 ? '1' : '0.01'}
                    min={minorUnitFor(currency) === 0 ? '1' : '0.01'}
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-currency">{tr('editor.currencyLabel')}</Label>
                  <Select
                    id="product-currency"
                    value={currency}
                    disabled={Boolean(editing)}
                    onChange={(e) => {
                      if (editing) return; // currency is immutable once created
                      setCurrency(e.target.value);
                    }}
                  >
                    {currencies.map((option) => (
                      <option key={option.code} value={option.code}>
                        {tr('editor.currencyOption', {
                          code: option.code,
                          name: option.name,
                          symbol: option.symbol,
                          digits: option.minorUnit,
                        })}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">{tr('editor.currencyHint')}</p>
                </Field>
                {isUpstreamManaged ? (
                  <div className="sm:col-span-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
                    {tr('editor.upstreamInventoryManaged', {
                      cost: cost
                        ? money(amountToMinor(cost, currency) ?? 0, currency, locale)
                        : '—',
                      stock: stock || '—',
                    })}
                  </div>
                ) : (
                  <>
                    <Field>
                      <Label htmlFor="product-stock">{tr('editor.stockLabel')}</Label>
                      <Input
                        id="product-stock"
                        type="number"
                        min="0"
                        value={stock}
                        onChange={(e) => setStock(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <Label htmlFor="product-cost">{tr('editor.costLabel')}</Label>
                      <Input
                        id="product-cost"
                        type="number"
                        step={minorUnitFor(currency) === 0 ? '1' : '0.01'}
                        min="0"
                        value={cost}
                        onChange={(e) => setCost(e.target.value)}
                      />
                      {editing
                        ? (() => {
                            const source = upstreamSourcePrice(editing);
                            if (source == null) return null;
                            return (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>
                                  {tr('editor.upstreamPrice', {
                                    price: money(source, editing.currency, locale),
                                  })}
                                </span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setCost(minorToInput(source, editing.currency))}
                                >
                                  {tr('editor.useUpstreamPrice')}
                                </Button>
                              </div>
                            );
                          })()
                        : null}
                    </Field>
                  </>
                )}
                <Field>
                  <Label htmlFor="product-original-price">{tr('editor.originalPriceLabel')}</Label>
                  <Input
                    id="product-original-price"
                    type="number"
                    step={minorUnitFor(currency) === 0 ? '1' : '0.01'}
                    min="0"
                    value={originalPrice}
                    onChange={(e) => setOriginalPrice(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-discount">{tr('editor.discountLabel')}</Label>
                  <Input
                    id="product-discount"
                    type="number"
                    min="0"
                    max="99"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card id="configuration">
            <CardHeader>
              <SectionTitle as="h3">{tr('editor.configTitle')}</SectionTitle>
              <CardDescription>{tr('editor.configDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-type">{tr('editor.typeLabel')}</Label>
                {types.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{tr('editor.noTypePlugins')}</p>
                ) : (
                  <Select
                    id="product-type"
                    value={typeId}
                    onChange={(e) => {
                      const nextType = e.target.value;
                      setTypeId(nextType);
                      setConfigData((current) => ({
                        ...current,
                        ...initialConfigData(
                          types.find((type) => type.id === nextType)?.configFields ?? [],
                          current,
                        ),
                      }));
                    }}
                  >
                    <option value="">{tr('editor.typePlaceholder')}</option>
                    {types.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.label}
                      </option>
                    ))}
                    {!types.some((type) => type.id === typeId) && builtinTypeLabel(typeId, tr) ? (
                      <option key={typeId} value={typeId}>
                        {builtinTypeLabel(typeId, tr)}
                      </option>
                    ) : null}
                  </Select>
                )}
                {currentType && currentType.configFields.length > 0 && !providerId ? (
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <ConfigFields
                      fields={currentType.configFields}
                      scope={configData}
                      onChange={setConfigData}
                      tr={tr}
                    />
                  </div>
                ) : null}
                {isCloudServer && !providerId ? (
                  <p className="text-sm text-muted-foreground">
                    {tr('editor.cloudProviderRequired')}
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card id="checkout">
            <CardHeader>
              <SectionTitle as="h3">{tr('editor.checkoutTitle')}</SectionTitle>
              <CardDescription>{tr('editor.checkoutDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Field>
                <Label htmlFor="product-checkout-config">{tr('editor.checkoutLabel')}</Label>
                <textarea
                  id="product-checkout-config"
                  value={checkoutConfigJson}
                  onChange={(e) => setCheckoutConfigJson(e.target.value)}
                  readOnly={Boolean(providerId)}
                  rows={6}
                  spellCheck={false}
                  placeholder={tr('editor.checkoutPlaceholder')}
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="text-xs text-muted-foreground">
                  {providerId ? tr('editor.upstreamConfigManaged') : tr('editor.checkoutHelp')}
                </p>
              </Field>
            </CardContent>
          </Card>
        </div>
        <aside className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-24">
          <Card id="summary">
            <CardHeader>
              <SectionTitle as="h3">{tr('editor.summaryTitle')}</SectionTitle>
              <CardDescription>{tr('editor.summaryDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <Package className="size-5 text-muted-foreground" />
                  <p className="min-w-0 break-words font-medium">
                    {name.trim() || tr('editor.unnamed')}
                  </p>
                </div>
                <dl className="flex flex-col gap-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{tr('editor.summaryPrice')}</dt>
                    <dd className="font-medium tabular-nums">
                      {price && Number.isFinite(Number(price))
                        ? `${price || '0'} ${currency}`
                        : tr('editor.pendingValue')}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{tr('editor.summaryStock')}</dt>
                    <dd className="tabular-nums">{stock || '0'}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{tr('editor.summaryType')}</dt>
                    <dd>
                      {currentType?.label ||
                        builtinTypeLabel(typeId, tr) ||
                        tr('editor.notSelected')}
                    </dd>
                  </div>
                </dl>
              </div>
            </CardContent>
          </Card>
          <Card id="categories">
            <CardHeader>
              <SectionTitle as="h3">{tr('editor.categoriesTitle')}</SectionTitle>
              <CardDescription>{tr('editor.categoriesDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {categories.length > 0 ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap gap-1.5">
                    {flattenCategoryOptions(categories).map((option) => {
                      const checked = selectedCategoryIds.includes(option.value);
                      return (
                        <label
                          key={option.value}
                          className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            checked
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'bg-muted/40 hover:bg-muted'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={checked}
                            onChange={() => {
                              setSelectedCategoryIds((current) =>
                                checked
                                  ? current.filter((id) => id !== option.value)
                                  : [...current, option.value],
                              );
                            }}
                          />
                          {option.label}
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tr('editor.categoriesHint')}
                  </p>
                </div>
              ) : null}
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tr('editor.categoriesEmpty')}</p>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </fieldset>
      <div className="flex items-center justify-end gap-2 pb-2">
        <Button variant="outline" type="button" onClick={onDone} disabled={isPending}>
          {tr('common.cancel')}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <RefreshCw data-icon="inline-start" className="animate-spin" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          {isPending ? tr('editor.saving') : tr('editor.save')}
        </Button>
      </div>
    </form>
  );
}

interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  sortOrder: number;
  productCount: number;
  children: CategoryNode[];
}

/** 调用 web BFF 通用代理为商品设置分类（带登录态）。 */
async function saveProductCategories(
  productId: string,
  categoryIds: string[],
  tr: ReturnType<typeof t>,
): Promise<void> {
  const response = await fetch(
    `/api/plugins/catalog/admin/products/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categoryIds }),
    },
  );
  if (!response.ok) {
    throw new Error(tr('editor.categorySaveFailed', { status: response.status }));
  }
}

/** 展平分类树为缩进选项。 */
function flattenCategoryOptions(
  nodes: readonly CategoryNode[],
  depth = 0,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  for (const node of nodes) {
    options.push({
      value: node.id,
      label: `${node.icon ? `${node.icon} ` : ''}${'\u3000'.repeat(depth)}${node.name}`,
    });
    options.push(...flattenCategoryOptions(node.children, depth + 1));
  }
  return options;
}

export function StoreAdminProductsPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const products = (props.data.products as ProductRow[] | undefined) ?? [];
  const types = (props.data.productTypes as ProductTypeInfo[] | undefined) ?? [];

  return (
    <main className="w-full space-y-8">
      <PageHeader
        title={tr('list.title')}
        actions={
          <Button nativeButton={false} render={<Link href="/admin/plugin/store/products/new" />}>
            <Plus className="size-4" />
            {tr('list.new')}
          </Button>
        }
      />

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">{tr('list.colProduct')}</th>
              <th className="px-4 py-2.5 font-medium">{tr('list.colType')}</th>
              <th className="px-4 py-2.5 font-medium">{tr('list.colPrice')}</th>
              <th className="px-4 py-2.5 font-medium">{tr('list.colCost')}</th>
              <th className="px-4 py-2.5 font-medium">{tr('list.colStock')}</th>
              <th className="px-4 py-2.5 font-medium">{tr('list.colStatus')}</th>
              <th className="px-4 py-2.5 font-medium">{tr('list.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const typeLabel = types.find((type) => type.id === product.fulfillmentType)?.label;
              return (
                <tr key={product.id} className="border-t">
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{product.name}</p>
                    <p className="text-xs text-muted-foreground">{product.id.slice(0, 12)}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    {typeLabel ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {typeLabel}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {builtinTypeLabel(product.fulfillmentType, tr) ?? product.fulfillmentType}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {money(product.price, product.currency, props.locale)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {(() => {
                      const source = upstreamSourcePrice(product);
                      const diff = source != null && source !== product.cost;
                      return (
                        <div className="flex flex-col gap-0.5">
                          <span>
                            {product.cost != null
                              ? money(product.cost, product.currency, props.locale)
                              : '—'}
                          </span>
                          {source != null && diff ? (
                            <span className="text-xs text-amber-600">
                              {tr('list.upstreamBadge', {
                                price: money(source, product.currency, props.locale),
                              })}
                            </span>
                          ) : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2.5">{product.stock}</td>
                  <td className="px-4 py-2.5">
                    {product.status === 'ACTIVE' ? tr('list.onSale') : product.status}
                  </td>
                  <td className="px-4 py-2.5">
                    <Button
                      variant="outline"
                      size="sm"
                      nativeButton={false}
                      render={
                        <Link
                          href={`/admin/plugin/store/products/${encodeURIComponent(product.id)}/edit`}
                        />
                      }
                    >
                      <Pencil className="size-3.5" />
                      {tr('list.edit')}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {products.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {tr('list.empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}

export function StoreAdminProductEditorPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const router = useRouter();
  const editing = (props.data.product as ProductRow | null | undefined) ?? null;
  const categories = (props.data.categories as CategoryNode[] | undefined) ?? [];
  const categoryIds = (props.data.productCategoryIds as string[] | undefined) ?? [];
  if (props.params.id && !editing) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={tr('editor.notFound')} />
        <Button nativeButton={false} render={<Link href="/admin/plugin/store/products" />}>
          {tr('editor.back')}
        </Button>
      </div>
    );
  }
  return (
    <ProductForm
      key={editing?.id ?? 'new'}
      editing={editing}
      currencies={(props.data.currencies as CurrencyOption[] | undefined) ?? []}
      types={(props.data.productTypes as ProductTypeInfo[] | undefined) ?? []}
      sources={(props.data.upstreamSources as UpstreamSourceInfo[] | undefined) ?? []}
      categories={categories}
      initialCategoryIds={categoryIds}
      tr={tr}
      locale={props.locale}
      onDone={() => {
        router.push('/admin/plugin/store/products');
        router.refresh();
      }}
    />
  );
}

function StoreAdminOverviewPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const summary = props.data.summary as { total: number; products: ProductRow[] } | undefined;
  const types = props.data.productTypes as ProductTypeInfo[] | undefined;
  return (
    <FeatureOverview
      title={tr('overview.title')}
      description={tr('overview.description')}
      unavailable={!summary}
      labels={{
        unavailable: tr('overview.unavailable'),
        manageTitle: tr('overview.manageTitle'),
        manageDescription: tr('overview.manageDescription'),
        activityDescription: tr('overview.activityDescription'),
        empty: tr('overview.empty'),
      }}
      metrics={[
        { label: tr('overview.metricTotal'), value: summary?.total ?? '—' },
        { label: tr('overview.metricTypes'), value: types?.length ?? '—' },
      ]}
      links={[
        {
          label: tr('overview.linkProducts'),
          description: tr('overview.linkProductsDescription'),
          href: '/admin/plugin/store/products',
        },
      ]}
      activity={{
        title: tr('overview.activityTitle'),
        items: (summary?.products ?? []).map((product) => ({
          label: product.name,
          detail: money(product.price, product.currency, props.locale),
          href: `/admin/plugin/store/products/${product.id}/edit`,
        })),
      }}
    />
  );
}

function StoreSettingsPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const initial = props.data.settings as { provisioningMode: string } | undefined;
  const [mode, setMode] = useState(initial?.provisioningMode ?? 'manual');
  const [busy, start] = useTransition();
  const [error, setError] = useState('');
  const router = useRouter();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('settings.store.title')} description={tr('settings.store.help')} />
      <FieldGroup>
        <Field>
          <Label htmlFor="provisioning-mode">{tr('settings.store.mode')}</Label>
          <Select
            id="provisioning-mode"
            value={mode}
            disabled={busy || !initial}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="manual">{tr('settings.store.manual')}</option>
            <option value="automatic">{tr('settings.store.automatic')}</option>
          </Select>
        </Field>
      </FieldGroup>
      {error ? <InlineError>{error}</InlineError> : null}
      <Button
        disabled={busy || !initial}
        onClick={() =>
          start(async () => {
            setError('');
            try {
              const response = await fetch('/api/plugins/store/admin/settings', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provisioningMode: mode }),
              });
              if (!response.ok) throw new Error();
              router.refresh();
            } catch {
              setError(tr('settings.store.failed'));
            }
          })
        }
      >
        {tr('settings.store.save')}
      </Button>
    </main>
  );
}

function StoreApprovalsPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const data = props.data.approvals as
    | {
        total: number;
        page: number;
        pageSize: number;
        tasks: Array<{
          id: string;
          orderId: string;
          userId: string;
          productName: string;
          quantity: number;
          status: string;
          reason: string | null;
          attempts: number;
          upstreamServiceId: string | null;
          invoiceId: string | null;
          paymentState: string | null;
          canResumePayment: boolean;
        }>;
      }
    | undefined;
  const [candidates, setCandidates] = useState<
    Record<string, Array<{ id: string; productName: string; providerServiceId: string }>>
  >({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const showFeedback = (kind: 'error' | 'success', message: string) => {
    if (!message) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('error');
    url.searchParams.delete('success');
    url.searchParams.set(kind, message);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };
  const setError = (message: string) => showFeedback('error', message);
  const router = useRouter();
  /** 待确认的继续支付/核验送审；原生 window.confirm 无法本地化按钮也不可测试。 */
  const [confirm, setConfirm] = useState<{ taskId: string; kind: 'resume' | 'recover' } | null>(
    null,
  );
  const runConfirmed = () => {
    const target = confirm;
    if (!target) return;
    setConfirm(null);
    start(async () => {
      setError('');
      try {
        const path = target.kind === 'resume' ? 'resume-payment' : 'recover';
        const response = await fetch(
          `/api/plugins/store/admin/delivery-tasks/${encodeURIComponent(target.taskId)}/${path}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmed: true }),
          },
        );
        if (!response.ok) {
          const failure: unknown = await response.json().catch(() => null);
          throw new Error(approvalErrorMessage(failure, tr('review.failed')));
        }
        if (target.kind === 'recover') showFeedback('success', tr('review.recovered'));
        router.refresh();
      } catch (failure) {
        console.error('[store] approval action failed', failure);
        setError(tr('review.failed'));
      }
    });
  };
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('settings.store.approvals')} />
      {!data ? <InlineError>{tr('settings.store.failed')}</InlineError> : null}
      {data?.tasks.length === 0 ? <p>{tr('settings.store.empty')}</p> : null}
      {data?.tasks.map((task) => (
        <Card key={task.id}>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>
                {task.productName} × {task.quantity}
              </CardTitle>
              <StatusBadge tone={task.status === 'AWAITING_APPROVAL' ? 'neutral' : 'warn'}>
                {tr(`review.status.${task.status}`)}
              </StatusBadge>
            </div>
            <CardDescription>
              {task.status === 'AWAITING_APPROVAL'
                ? tr('review.approveHint')
                : task.paymentState
                  ? tr(`review.payment.${task.paymentState}`)
                  : tr('review.checkHint')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {task.canResumePayment ? (
                <Button
                  disabled={busy}
                  onClick={() => setConfirm({ taskId: task.id, kind: 'resume' })}
                >
                  {tr('review.resumePayment')}
                </Button>
              ) : null}
              {task.status === 'AWAITING_APPROVAL' ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      setError('');
                      try {
                        const response = await fetch(
                          `/api/plugins/store/admin/delivery-tasks/${encodeURIComponent(task.id)}/approve`,
                          { method: 'POST' },
                        );
                        if (!response.ok) throw new Error();
                        router.refresh();
                      } catch {
                        setError(tr('settings.store.failed'));
                      }
                    })
                  }
                >
                  {tr('settings.store.approve')}
                </Button>
              ) : (
                <>
                  {task.status === 'REQUIRES_RECONCILIATION' ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirm({ taskId: task.id, kind: 'recover' })}
                    >
                      {tr('review.recover')}
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link href="/admin/plugin/zjmf-upstream/instances" />}
                  >
                    {tr('review.viewUpstream')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-expanded={expanded === task.id}
                    onClick={() => {
                      if (expanded === task.id) {
                        setExpanded(null);
                        return;
                      }
                      start(async () => {
                        setError('');
                        try {
                          const response = await fetch(
                            `/api/plugins/store/admin/delivery-tasks/${encodeURIComponent(task.id)}/candidates`,
                          );
                          if (!response.ok) throw new Error();
                          const result = (await response.json()) as {
                            services: Array<{
                              id: string;
                              productName: string;
                              providerServiceId: string;
                            }>;
                          };
                          setCandidates((current) => ({ ...current, [task.id]: result.services }));
                          setExpanded(task.id);
                        } catch {
                          setError(tr('review.failed'));
                        }
                      });
                    }}
                  >
                    {tr('review.linkExisting')}
                  </Button>
                </>
              )}
            </div>
            {expanded === task.id && task.status !== 'AWAITING_APPROVAL' ? (
              candidates[task.id]?.length || task.attempts === 0 ? (
                <form
                  className="max-w-xl"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const values = new FormData(form);
                    const selected = String(values.get('serviceId') ?? '').trim();
                    const serviceId = selected === '__not_created' ? '' : selected;
                    start(async () => {
                      setError('');
                      try {
                        const response = await fetch(
                          `/api/plugins/store/admin/delivery-tasks/${encodeURIComponent(task.id)}/reconcile`,
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              outcome: serviceId ? 'existing' : 'not_created',
                              ...(serviceId ? { serviceId } : {}),
                              confirmed: values.get('confirmed') === 'on',
                              note: values.get('note'),
                            }),
                          },
                        );
                        if (!response.ok) throw new Error(tr('review.failed'));
                        router.refresh();
                      } catch {
                        setError(tr('review.failed'));
                      }
                    });
                  }}
                >
                  <FieldGroup>
                    <Field>
                      <Label htmlFor={`service-${task.id}`}>{tr('review.service')}</Label>
                      <Select
                        id={`service-${task.id}`}
                        name="serviceId"
                        disabled={busy}
                        defaultValue=""
                        required
                      >
                        <option value="" disabled>
                          {tr('review.choose')}
                        </option>
                        {task.attempts === 0 ? (
                          <option value="__not_created">{tr('review.notCreated')}</option>
                        ) : null}
                        {candidates[task.id]?.map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.productName} · {service.providerServiceId}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field>
                      <Label htmlFor={`note-${task.id}`}>{tr('review.note')}</Label>
                      <Input
                        id={`note-${task.id}`}
                        name="note"
                        required
                        minLength={5}
                        maxLength={500}
                        disabled={busy}
                      />
                    </Field>
                    <Field>
                      <Label>
                        <input type="checkbox" name="confirmed" required disabled={busy} />
                        {tr('review.confirm')}
                      </Label>
                    </Field>
                    <Button type="submit" disabled={busy}>
                      {tr('review.resolve')}
                    </Button>
                  </FieldGroup>
                </form>
              ) : (
                <div className="flex flex-col items-start gap-2 text-sm">
                  <p className="text-muted-foreground">{tr('review.noCandidates')}</p>
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link href={`/admin/users/${encodeURIComponent(task.userId)}`} />}
                  >
                    {tr('review.import')}
                  </Button>
                </div>
              )
            ) : null}
            <details className="text-sm text-muted-foreground">
              <summary className="w-fit cursor-pointer">{tr('review.details')}</summary>
              <dl className="mt-3 grid gap-2 break-all sm:grid-cols-[auto_1fr]">
                <dt>{tr('review.order')}</dt>
                <dd>{task.orderId}</dd>
                <dt>{tr('review.user')}</dt>
                <dd>
                  <Link href={`/admin/users/${encodeURIComponent(task.userId)}`}>
                    {task.userId}
                  </Link>
                </dd>
                {task.upstreamServiceId ? (
                  <>
                    <dt>{tr('review.remote')}</dt>
                    <dd>{task.upstreamServiceId}</dd>
                  </>
                ) : null}
                {task.invoiceId ? (
                  <>
                    <dt>{tr('review.invoice')}</dt>
                    <dd>{task.invoiceId}</dd>
                  </>
                ) : null}
              </dl>
            </details>
          </CardContent>
        </Card>
      ))}
      {data ? (
        <nav className="flex items-center gap-4" aria-label={tr('review.pagination')}>
          {data.page > 1 ? (
            <Link href={`?page=${data.page - 1}`}>{tr('review.previous')}</Link>
          ) : null}
          <span>
            {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </span>
          {data.page * data.pageSize < data.total ? (
            <Link href={`?page=${data.page + 1}`}>{tr('review.next')}</Link>
          ) : null}
        </nav>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
        title={confirm?.kind === 'recover' ? tr('review.recover') : tr('review.resumePayment')}
        description={
          confirm?.kind === 'recover' ? tr('review.recoverConfirm') : tr('review.resumeConfirm')
        }
        cancelLabel={tr('common.cancel')}
        confirmLabel={
          confirm?.kind === 'recover' ? tr('review.recover') : tr('review.resumePayment')
        }
        pending={busy}
        destructive={confirm?.kind === 'recover'}
        onConfirm={runConfirmed}
      />
    </main>
  );
}

export function StoreAdminRefundsPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const rows =
    (
      props.data.refunds as
        | {
            requests: Array<{
              id: string;
              orderId: string;
              userId: string;
              amount: number;
              currency: string;
              state: string;
              reason: string | null;
              failureReason: string | null;
            }>;
          }
        | undefined
    )?.requests ?? [];
  const [busy, start] = useTransition();
  const router = useRouter();
  // Refund states are machine values; never render them verbatim.
  const stateLabel = (state: string) => {
    const key = `refund.state.${state}`;
    const label = tr(key);
    return label === key ? state : label;
  };
  const review = (id: string, decision: 'approve' | 'reject') =>
    start(async () => {
      await fetch(`/api/plugins/store/admin/refund-requests/${encodeURIComponent(id)}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      router.refresh();
    });
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={tr('refund.title')} description={tr('refund.description')} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr('refund.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-3">{tr('refund.colOrder')}</th>
                <th className="p-3">{tr('refund.colUser')}</th>
                <th className="p-3">{tr('refund.colAmount')}</th>
                <th className="p-3">{tr('refund.colState')}</th>
                <th className="p-3">{tr('refund.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="p-3 font-mono text-xs">{row.orderId}</td>
                  <td className="p-3">{row.userId}</td>
                  <td className="p-3 tabular-nums">
                    {money(row.amount, row.currency, props.locale)}
                  </td>
                  <td className="p-3">
                    {row.failureReason
                      ? tr('refund.failureReason', {
                          state: stateLabel(row.state),
                          reason: row.failureReason,
                        })
                      : stateLabel(row.state)}
                  </td>
                  <td className="p-3">
                    {row.state === 'PENDING' ? (
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy} onClick={() => review(row.id, 'approve')}>
                          {tr('refund.approve')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => review(row.id, 'reject')}
                        >
                          {tr('refund.reject')}
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export const adminPages = {
  'admin/settings': StoreSettingsPage,
  'admin/approvals': StoreApprovalsPage,
  'admin/refunds': StoreAdminRefundsPage,
  'admin/summary': StoreAdminOverviewPage,
  'admin/overview': StoreAdminProductsPage,
  'admin/product-editor': StoreAdminProductEditorPage,
} as const;
