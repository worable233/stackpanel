'use client';
import { SectionTitle } from '@stackpanel/ui';

import { useCallback, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AdminPageComponentProps, ProductConfigField } from '@stackpanel/sdk';
import {
  FeatureOverview,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Field,
  FieldGroup,
  FieldError,
  Input,
  Label,
  PageHeader,
  Select,
} from '@stackpanel/ui';
import { ArrowLeft, Package, Pencil, Plus, RefreshCw, Save, Search } from 'lucide-react';

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
  currency?: string;
  description?: string | null;
  icon?: string | null;
  specs?: Record<string, unknown>;
  sourceRef?: string;
}

function money(n: number, currency: string): string {
  return `${(n / 100).toFixed(2)} ${currency}`;
}

/** store 内建商品类型的中文展示名（无类型插件认领时的回退）。 */
const BUILTIN_TYPE_LABELS: Record<string, string> = {
  delivery: '手动发货',
};

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
}: {
  field: ProductConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
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
        <option value="">请选择</option>
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
        placeholder={field.placeholder ?? '用逗号分隔'}
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
}: {
  fields: ProductConfigField[];
  scope: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
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
              <FieldList fields={bucket.fields} scope={scope} onChange={onChange} />
            </fieldset>
          );
        }
        return (
          <FieldList
            key={`fields-${bucket.fields[0]?.name ?? 'root'}`}
            fields={bucket.fields}
            scope={scope}
            onChange={onChange}
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
}: {
  fields: ProductConfigField[];
  scope: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
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
              <ConfigFields fields={field.fields ?? []} scope={scope} onChange={onChange} />
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
                  {field.itemLabel ?? '新增一项'}
                </Button>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无条目。</p>
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
                      删除
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
  onDone,
}: {
  editing: ProductRow | null;
  types: ProductTypeInfo[];
  sources: UpstreamSourceInfo[];
  categories: CategoryNode[];
  initialCategoryIds: string[];
  onDone: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(editing?.id ?? null);

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [price, setPrice] = useState(editing ? String(editing.price / 100) : '');
  const [stock, setStock] = useState(editing ? String(editing.stock) : '0');
  const [cost, setCost] = useState(editing?.cost != null ? String(editing.cost / 100) : '');
  const [originalPrice, setOriginalPrice] = useState(
    editing?.originalPrice != null ? String(editing.originalPrice / 100) : '',
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
  const [checkoutConfigJson, setCheckoutConfigJson] = useState(() => {
    const config = editing?.metadata?.checkoutConfig;
    return config ? JSON.stringify(config, null, 2) : '';
  });
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(initialCategoryIds);

  const [searchSource, setSearchSource] = useState(sources[0]?.id ?? '');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UpstreamItem[]>([]);
  const [searching, setSearching] = useState(false);

  const currentType = types.find((candidate) => candidate.id === typeId) ?? null;

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
      setError('上游搜索失败，请稍后再试');
    } finally {
      setSearching(false);
    }
  }, [searchSource, searchQuery]);

  async function pickUpstream(item: UpstreamItem) {
    setProviderId(searchSource);
    setProviderProductId(item.id);
    if (item.name) setName(item.name);
    if (item.description) setDescription(item.description);
    if (item.icon) setIcon(item.icon);
    if (item.price != null) setCost(String(item.price / 100));
    if (item.specs) {
      setConfigData((prev) => {
        const next = { ...prev };
        for (const [key, value] of Object.entries(item.specs ?? {})) {
          setPath(next, `specs.${key}`, value);
        }
        return next;
      });
    }
    // 一键填充上游结账配置（周期 + 配置项）。
    try {
      const response = await fetch(
        `/api/store/upstream-products/${encodeURIComponent(searchSource)}/${encodeURIComponent(item.id)}/config`,
        { cache: 'no-store' },
      );
      if (response.ok) {
        const json = (await response.json()) as { checkoutConfig?: unknown };
        if (json.checkoutConfig) {
          setCheckoutConfigJson(JSON.stringify(json.checkoutConfig, null, 2));
        }
      }
    } catch {
      // 配置拉取失败不阻断关联；管理员可手动填写。
    }
  }

  function clearUpstream() {
    setProviderId('');
    setProviderProductId('');
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
        setError('结账配置不是合法的 JSON');
        return null;
      }
    }
    return metadata;
  }

  function submit() {
    if (!name.trim()) {
      setError('请填写商品名称');
      return;
    }
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setError('请填写有效的售卖价格');
      return;
    }
    setError(null);
    const optionalAmount = (value: string) =>
      value.trim() ? Math.round(Number(value) * 100) : null;
    const amounts = [cost, originalPrice];
    if (
      amounts.some(
        (value) => value.trim() && (!Number.isFinite(Number(value)) || Number(value) < 0),
      )
    ) {
      setError('成本与原价须为有效的非负金额');
      return;
    }
    if (!Number.isInteger(Number(stock)) || Number(stock) < 0 || Number(stock) > 1000000) {
      setError('库存须为 0 至 1000000 的整数');
      return;
    }
    if (
      discount.trim() &&
      (!Number.isInteger(Number(discount)) || Number(discount) < 0 || Number(discount) > 99)
    ) {
      setError('折扣须为 0 至 99 的整数');
      return;
    }
    const metadata = buildMetadata();
    if (metadata === null) return;
    const body = {
      name: name.trim(),
      description: description.trim(),
      price: Math.round(parsedPrice * 100),
      currency: editing?.currency ?? 'CNY',
      stock: Number(stock),
      cost: optionalAmount(cost),
      originalPrice: optionalAmount(originalPrice),
      discount: discount.trim() ? Number(discount) : null,
      ...(typeId ? { fulfillmentType: typeId } : {}),
      providerId: providerId || null,
      providerProductId: providerProductId || null,
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
          throw new Error(result.message || result.error || '商品保存失败');
        // 分类请求失败后保留新建商品 ID，再次保存只会更新，不会重复创建。
        setSavedId(result.product.id);
        if (categories.length > 0)
          await saveProductCategories(result.product.id, selectedCategoryIds);
        onDone();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '保存失败，请重试');
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            nativeButton={false}
            render={<Link href="/admin/plugin/store/products" />}
            aria-label="返回商店管理"
          >
            <ArrowLeft />
          </Button>
          <PageHeader title={editing ? '编辑商品' : '新建商品'} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" type="button" onClick={onDone} disabled={isPending}>
            取消
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? (
              <RefreshCw data-icon="inline-start" className="animate-spin" />
            ) : (
              <Save data-icon="inline-start" />
            )}
            {isPending ? '保存中…' : '保存商品'}
          </Button>
        </div>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
      <fieldset
        disabled={isPending}
        className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="flex min-w-0 flex-col gap-6">
          <Card id="basic">
            <CardHeader>
              <SectionTitle as="h3">基础信息</SectionTitle>
              <CardDescription>展示给用户的商品名称、简介与图标。</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <Label htmlFor="product-name">名称 *</Label>
                  <Input
                    id="product-name"
                    required
                    maxLength={191}
                    placeholder="例如：香港云服务器"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-description">简介</Label>
                  <Input
                    id="product-description"
                    maxLength={191}
                    placeholder="简要描述产品规格与用途"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-icon">图标（emoji 或 URL）</Label>
                  <Input id="product-icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card id="pricing">
            <CardHeader>
              <SectionTitle as="h3">价格与库存</SectionTitle>
              <CardDescription>设置销售价格、成本和库存数量。</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup className="grid sm:grid-cols-2">
                <Field>
                  <Label htmlFor="product-price">售卖价格（元）*</Label>
                  <Input
                    id="product-price"
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-stock">库存</Label>
                  <Input
                    id="product-stock"
                    type="number"
                    min="0"
                    value={stock}
                    onChange={(e) => setStock(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-cost">成本（元，人工维护）</Label>
                  <Input
                    id="product-cost"
                    type="number"
                    step="0.01"
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
                            <span>上游源价 {money(source, editing.currency)}</span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setCost(String(source / 100))}
                            >
                              采用上游价
                            </Button>
                          </div>
                        );
                      })()
                    : null}
                </Field>
                <Field>
                  <Label htmlFor="product-original-price">原价（元，可选，划线展示）</Label>
                  <Input
                    id="product-original-price"
                    type="number"
                    step="0.01"
                    min="0"
                    value={originalPrice}
                    onChange={(e) => setOriginalPrice(e.target.value)}
                  />
                </Field>
                <Field>
                  <Label htmlFor="product-discount">商品折扣（%，可选）</Label>
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
              <SectionTitle as="h3">产品配置</SectionTitle>
              <CardDescription>选择商品类型，并设置对应的交付参数。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-type">商品类型</Label>
                {types.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    未安装商品类型插件（如 store-product-server / store-product-card）。
                  </p>
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
                    <option value="">请选择商品类型</option>
                    {types.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.label}
                      </option>
                    ))}
                    {!types.some((type) => type.id === typeId) && BUILTIN_TYPE_LABELS[typeId] ? (
                      <option key={typeId} value={typeId}>
                        {BUILTIN_TYPE_LABELS[typeId]}
                      </option>
                    ) : null}
                  </Select>
                )}
                {currentType && currentType.configFields.length > 0 ? (
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <ConfigFields
                      fields={currentType.configFields}
                      scope={configData}
                      onChange={setConfigData}
                    />
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Card id="checkout">
            <CardHeader>
              <SectionTitle as="h3">结账配置</SectionTitle>
              <CardDescription>配置购买周期与用户可选的产品规格。</CardDescription>
            </CardHeader>
            <CardContent>
              <Field>
                <Label htmlFor="product-checkout-config">结账配置（可配置商品，JSON，可选）</Label>
                <textarea
                  id="product-checkout-config"
                  value={checkoutConfigJson}
                  onChange={(e) => setCheckoutConfigJson(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  placeholder={
                    '{\n  "cycles": [{ "id": "onetime", "label": "一次性", "price": 1000 }],\n  "options": [\n    { "id": "cpu", "label": "CPU", "type": "select", "choices": [{ "id": "c1", "label": "1核", "price": 0 }] }\n  ]\n}'
                  }
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="text-xs text-muted-foreground">
                  定义结账时可选周期与配置项（金额单位为分）。留空表示非可配置商品；上游关联商品由同步自动生成。
                </p>
              </Field>
            </CardContent>
          </Card>
          {sources.length > 0 ? (
            <Card id="upstream">
              <CardHeader>
                <SectionTitle as="h3">上游关联</SectionTitle>
                <CardDescription>关联上游商品，填充规格与结账配置。</CardDescription>
              </CardHeader>
              <CardContent>
                {providerId && providerProductId ? (
                  <div className="flex items-center justify-between rounded-lg border bg-primary/5 px-4 py-3 text-sm">
                    <span>
                      已关联：
                      {sources.find((source) => source.id === providerId)?.name ?? providerId}
                      {' · '}
                      {providerProductId}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={clearUpstream}>
                      取消关联
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                        <Label>上游</Label>
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
                        <Label>关键词</Label>
                        <Input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void runSearch();
                            }
                          }}
                          placeholder="搜索上游商品"
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
                        搜索
                      </Button>
                    </div>
                    {searchResults.length > 0 ? (
                      <ul className="divide-y rounded-lg border bg-background">
                        {searchResults.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium">{item.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {item.id}
                                {item.price != null
                                  ? ` · 成本 ${money(item.price, item.currency ?? 'CNY')}`
                                  : ''}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => pickUpstream(item)}
                            >
                              选择
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {!searching && searchResults.length === 0 && searchQuery !== '' ? (
                      <p className="text-sm text-muted-foreground">没有匹配的上游商品。</p>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-24">
          <Card id="summary">
            <CardHeader>
              <SectionTitle as="h3">商品概览</SectionTitle>
              <CardDescription>当前编辑的商品信息。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <Package className="size-5 text-muted-foreground" />
                  <p className="min-w-0 break-words font-medium">{name.trim() || '未命名商品'}</p>
                </div>
                <dl className="flex flex-col gap-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">售价</dt>
                    <dd className="font-medium tabular-nums">
                      {price && Number.isFinite(Number(price))
                        ? `${Number(price).toFixed(2)} ${editing?.currency ?? 'CNY'}`
                        : '待设置'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">库存</dt>
                    <dd className="tabular-nums">{stock || '0'}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">商品类型</dt>
                    <dd>{currentType?.label || BUILTIN_TYPE_LABELS[typeId] || '未选择'}</dd>
                  </div>
                </dl>
              </div>
            </CardContent>
          </Card>
          <Card id="categories">
            <CardHeader>
              <SectionTitle as="h3">商品分类</SectionTitle>
              <CardDescription>选择商品在前台展示的分类。</CardDescription>
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
                  <p className="mt-2 text-xs text-muted-foreground">未分类商品默认不在前台展示。</p>
                </div>
              ) : null}
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无分类</p>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </fieldset>
      <div className="flex items-center justify-end gap-2 pb-2">
        <Button variant="outline" type="button" onClick={onDone} disabled={isPending}>
          取消
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <RefreshCw data-icon="inline-start" className="animate-spin" />
          ) : (
            <Save data-icon="inline-start" />
          )}
          {isPending ? '保存中…' : '保存商品'}
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
async function saveProductCategories(productId: string, categoryIds: string[]): Promise<void> {
  const response = await fetch(
    `/api/plugins/catalog/admin/products/${encodeURIComponent(productId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categoryIds }),
    },
  );
  if (!response.ok) {
    throw new Error(`分类保存失败：${response.status}`);
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
  const products = (props.data.products as ProductRow[] | undefined) ?? [];
  const types = (props.data.productTypes as ProductTypeInfo[] | undefined) ?? [];

  return (
    <main className="w-full space-y-8">
      <PageHeader
        title="商品"
        actions={
          <Button nativeButton={false} render={<Link href="/admin/plugin/store/products/new" />}>
            <Plus className="size-4" />
            新建商品
          </Button>
        }
      />

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">商品</th>
              <th className="px-4 py-2.5 font-medium">类型</th>
              <th className="px-4 py-2.5 font-medium">售价</th>
              <th className="px-4 py-2.5 font-medium">成本</th>
              <th className="px-4 py-2.5 font-medium">库存</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
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
                        {BUILTIN_TYPE_LABELS[product.fulfillmentType] ?? product.fulfillmentType}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">{money(product.price, product.currency)}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {(() => {
                      const source = upstreamSourcePrice(product);
                      const diff = source != null && source !== product.cost;
                      return (
                        <div className="flex flex-col gap-0.5">
                          <span>
                            {product.cost != null ? money(product.cost, product.currency) : '—'}
                          </span>
                          {source != null && diff ? (
                            <span className="text-xs text-amber-600">
                              上游 {money(source, product.currency)}
                            </span>
                          ) : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2.5">{product.stock}</td>
                  <td className="px-4 py-2.5">
                    {product.status === 'ACTIVE' ? '在售' : product.status}
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
                      编辑
                    </Button>
                  </td>
                </tr>
              );
            })}
            {products.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  暂无商品。
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
  const router = useRouter();
  const editing = (props.data.product as ProductRow | null | undefined) ?? null;
  const categories = (props.data.categories as CategoryNode[] | undefined) ?? [];
  const categoryIds = (props.data.productCategoryIds as string[] | undefined) ?? [];
  if (props.params.id && !editing) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="商品不存在" />
        <Button nativeButton={false} render={<Link href="/admin/plugin/store/products" />}>
          返回商店管理
        </Button>
      </div>
    );
  }
  return (
    <ProductForm
      key={editing?.id ?? 'new'}
      editing={editing}
      types={(props.data.productTypes as ProductTypeInfo[] | undefined) ?? []}
      sources={(props.data.upstreamSources as UpstreamSourceInfo[] | undefined) ?? []}
      categories={categories}
      initialCategoryIds={categoryIds}
      onDone={() => {
        router.push('/admin/plugin/store/products');
        router.refresh();
      }}
    />
  );
}

function StoreAdminOverviewPage(props: AdminPageComponentProps) {
  const summary = props.data.summary as { total: number; products: ProductRow[] } | undefined;
  const types = props.data.productTypes as ProductTypeInfo[] | undefined;
  return (
    <FeatureOverview
      title="概览"
      description="查看商品规模与最近商品。"
      unavailable={!summary}
      metrics={[
        { label: '商品总数', value: summary?.total ?? '—' },
        { label: '产品类型', value: types?.length ?? '—' },
      ]}
      links={[
        {
          label: '商品',
          description: '管理商品、库存与售价。',
          href: '/admin/plugin/store/products',
        },
      ]}
      activity={{
        title: '最近商品',
        items: (summary?.products ?? []).map((product) => ({
          label: product.name,
          detail: money(product.price, product.currency),
          href: `/admin/plugin/store/products/${product.id}/edit`,
        })),
      }}
    />
  );
}

export const adminPages = {
  'admin/summary': StoreAdminOverviewPage,
  'admin/overview': StoreAdminProductsPage,
  'admin/product-editor': StoreAdminProductEditorPage,
} as const;
