'use client';

import { useCallback, useState, useTransition } from 'react';
import type { AdminPageComponentProps, ProductConfigField } from '@stackpanel/sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PageHeader,
  Select,
} from '@stackpanel/ui';
import { Pencil, Plus, RefreshCw, Search } from 'lucide-react';

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
    if (typeof cursor[key] !== 'object' || cursor[key] === null) {
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

function ConfigFieldInput({
  field,
  value,
  onChange,
}: {
  field: ProductConfigField;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === 'textarea') {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        rows={3}
      />
    );
  }
  if (field.type === 'select') {
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择</option>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <Label className="gap-2 font-normal">
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="size-4 accent-primary"
        />
        {field.label}
      </Label>
    );
  }
  return (
    <Input
      type={field.type === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      min={field.min}
      max={field.max}
    />
  );
}

function ProductForm({
  editing,
  types,
  sources,
  categories,
  initialCategoryIds,
  onDone,
  createAction,
  updateAction,
}: {
  editing: ProductRow | null;
  types: ProductTypeInfo[];
  sources: UpstreamSourceInfo[];
  categories: CategoryNode[];
  initialCategoryIds: string[];
  onDone: () => void;
  createAction: (formData: FormData) => Promise<void>;
  updateAction: (formData: FormData) => Promise<void>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [price, setPrice] = useState(editing ? String(editing.price / 100) : '');
  const [stock, setStock] = useState(editing ? String(editing.stock) : '0');
  const [cost, setCost] = useState(editing?.cost != null ? String(editing.cost / 100) : '');
  const [originalPrice, setOriginalPrice] = useState(
    editing?.originalPrice != null ? String(editing.originalPrice / 100) : '',
  );
  const [discount, setDiscount] = useState(editing?.discount != null ? String(editing.discount) : '');
  const [icon, setIcon] = useState(
    typeof editing?.metadata?.icon === 'string' ? editing.metadata.icon : '',
  );
  const [typeId, setTypeId] = useState(editing?.fulfillmentType || types[0]?.id || '');
  const [configValues, setConfigValues] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = {};
    const meta = editing?.metadata ?? {};
    const type = types.find((candidate) => candidate.id === editing?.fulfillmentType);
    for (const field of type?.configFields ?? []) {
      const raw = getPath(meta, field.name);
      if (raw !== undefined) values[field.name] = String(raw);
    }
    return values;
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

  function pickUpstream(item: UpstreamItem) {
    setProviderId(searchSource);
    setProviderProductId(item.id);
    if (item.name) setName(item.name);
    if (item.description) setDescription(item.description);
    if (item.icon) setIcon(item.icon);
    if (item.price != null) setCost(String(item.price / 100));
    if (item.specs) {
      setConfigValues((prev) => {
        const next = { ...prev };
        for (const [key, value] of Object.entries(item.specs)) {
          next[`specs.${key}`] = String(value);
        }
        return next;
      });
    }
  }

  function clearUpstream() {
    setProviderId('');
    setProviderProductId('');
    setSearchResults([]);
  }

  function coerceValue(field: ProductConfigField, value: string): unknown {
    if (value === '') return '';
    if (field.type === 'number') return Number(value);
    if (field.type === 'boolean') return value === 'true';
    return value;
  }

  function buildMetadata(): Record<string, unknown> | null {
    const metadata: Record<string, unknown> = {};
    for (const field of currentType?.configFields ?? []) {
      const raw = configValues[field.name];
      if (raw === undefined || raw === '') continue;
      setPath(metadata, field.name, coerceValue(field, raw));
    }
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
    const form = new FormData();
    form.set('name', name.trim());
    if (description.trim()) form.set('description', description.trim());
    form.set('price', String(Math.round(parsedPrice * 100)));
    form.set('stock', stock === '' ? '0' : String(Number(stock) || 0));
    if (cost.trim()) form.set('cost', String(Math.round(Number(cost) * 100)));
    if (originalPrice.trim()) form.set('originalPrice', String(Math.round(Number(originalPrice) * 100)));
    if (discount.trim()) form.set('discount', String(Number(discount) || 0));
    if (typeId) form.set('fulfillmentType', typeId);
    if (providerId) form.set('providerId', providerId);
    if (providerProductId) form.set('providerProductId', providerProductId);
    const metadata = buildMetadata();
    if (metadata === null) return;
    if (Object.keys(metadata).length > 0) form.set('metadata', JSON.stringify(metadata));

    startTransition(async () => {
      try {
        if (editing) {
          form.set('id', editing.id);
          // 先保存分类（fetch），再提交商品表单（server action 会 redirect，中断后续代码）。
          await saveProductCategories(editing.id, selectedCategoryIds);
          await updateAction(form);
        } else {
          await createAction(form);
        }
        onDone();
      } catch {
        setError('保存失败，请重试');
      }
    });
  }

  return (
    <div className="mt-5 flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-name">名称 *</Label>
          <Input id="product-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-description">简介</Label>
          <Input
            id="product-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-price">售卖价格（元）*</Label>
          <Input
            id="product-price"
            type="number"
            step="0.01"
            min="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-stock">库存</Label>
          <Input
            id="product-stock"
            type="number"
            min="0"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-cost">成本（元，同步自上游，可改）</Label>
          <Input
            id="product-cost"
            type="number"
            step="0.01"
            min="0"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-original-price">原价（元，可选，划线展示）</Label>
          <Input
            id="product-original-price"
            type="number"
            step="0.01"
            min="0"
            value={originalPrice}
            onChange={(e) => setOriginalPrice(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-discount">商品折扣（%，可选）</Label>
          <Input
            id="product-discount"
            type="number"
            min="0"
            max="99"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-icon">图标（emoji 或 URL）</Label>
          <Input id="product-icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="product-checkout-config">
          结账配置（可配置商品，JSON，可选）
        </Label>
        <textarea
          id="product-checkout-config"
          value={checkoutConfigJson}
          onChange={(e) => setCheckoutConfigJson(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={'{\n  "cycles": [{ "id": "onetime", "label": "一次性", "price": 1000 }],\n  "options": [\n    { "id": "cpu", "label": "CPU", "type": "select", "choices": [{ "id": "c1", "label": "1核", "price": 0 }] }\n  ]\n}'}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <p className="text-xs text-muted-foreground">
          定义结账时可选周期与配置项（金额单位为分）。留空表示非可配置商品；上游关联商品由同步自动生成。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>商品类型</Label>
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            未安装商品类型插件（如 store-product-server / store-product-card）。
          </p>
        ) : (
          <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
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
          <div className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
            {currentType.configFields.map((field) =>
              field.type === 'boolean' ? (
                <ConfigFieldInput
                  key={field.name}
                  field={field}
                  value={configValues[field.name] ?? ''}
                  onChange={(value) =>
                    setConfigValues((prev) => ({ ...prev, [field.name]: value }))
                  }
                />
              ) : (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <Label>
                    {field.label}
                    {field.required ? ' *' : ''}
                  </Label>
                  <ConfigFieldInput
                    field={field}
                    value={configValues[field.name] ?? ''}
                    onChange={(value) =>
                      setConfigValues((prev) => ({ ...prev, [field.name]: value }))
                    }
                  />
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>

      {sources.length > 0 ? (
        <div className="flex flex-col gap-2">
          <Label>关联上游商品（可选）</Label>
          {providerId && providerProductId ? (
            <div className="flex items-center justify-between rounded-lg border bg-primary/5 px-4 py-3 text-sm">
              <span>
                已关联：{sources.find((source) => source.id === providerId)?.name ?? providerId}
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
                  {searching ? <RefreshCw className="size-4 animate-spin" /> : <Search className="size-4" />}
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
                          {item.price != null ? ` · 成本 ${money(item.price, item.currency ?? 'CNY')}` : ''}
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
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {categories.length > 0 ? (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">商品分类</p>
          <div className="flex flex-wrap gap-1.5">
            {flattenCategoryOptions(categories).map((option) => {
              const checked = selectedCategoryIds.includes(option.value);
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    checked ? 'border-primary bg-primary/10 text-primary' : 'bg-muted/40 hover:bg-muted'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="hidden"
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

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={isPending}>
          {isPending ? '保存中…' : editing ? '保存修改' : '创建商品'}
        </Button>
      </DialogFooter>
    </div>
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
): Promise<void> {
  const response = await fetch(
    `/api/plugins/catalog/admin/products/${encodeURIComponent(productId)}/categories`,
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
      label: `${node.icon ?? '🙂'} ${'\u3000'.repeat(depth)}${node.name}`,
    });
    options.push(...flattenCategoryOptions(node.children, depth + 1));
  }
  return options;
}

export function StoreAdminProductsPage(props: AdminPageComponentProps) {
  const products = (props.data.products as ProductRow[] | undefined) ?? [];
  const types = (props.data.productTypes as ProductTypeInfo[] | undefined) ?? [];
  const sources = (props.data.upstreamSources as UpstreamSourceInfo[] | undefined) ?? [];
  const categories = (props.data.categories as CategoryNode[] | undefined) ?? [];
  const catalogProducts = (props.data.catalogProducts as
    | {
        products?: Array<{
          product: { id: string };
          catalog: { categoryIds: string[] } | null;
        }>;
      }
    | undefined) ?? { products: [] };
  const categoryIdsByProduct = new Map(
    (catalogProducts.products ?? []).map((entry) => [entry.product.id, entry.catalog?.categoryIds ?? []]),
  );
  const createAction = props.actions['store.create-product'];
  const updateAction = props.actions['store.update-product'];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);

  return (
    <main className="w-full space-y-8">
      <PageHeader
        title="商店管理"
        description="管理商品：可关联上游商品（成本同步），也可直接创建。"
        actions={
          createAction ? (
            <Button
              type="button"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus className="size-4" />
              新建商品
            </Button>
          ) : null
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
                    {product.cost != null ? money(product.cost, product.currency) : '—'}
                  </td>
                  <td className="px-4 py-2.5">{product.stock}</td>
                  <td className="px-4 py-2.5">
                    {product.status === 'ACTIVE' ? '在售' : product.status}
                  </td>
                  <td className="px-4 py-2.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(product);
                        setOpen(true);
                      }}
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑商品：${editing.name}` : '新建商品'}</DialogTitle>
            <DialogDescription>
              {editing ? '修改商品属性后保存。' : '创建商品；可关联上游商品，也可直接创建。'}
            </DialogDescription>
          </DialogHeader>
          <ProductForm
            editing={editing}
            types={types}
            sources={sources}
            categories={categories}
            initialCategoryIds={editing ? categoryIdsByProduct.get(editing.id) ?? [] : []}
            onDone={() => setOpen(false)}
            createAction={createAction}
            updateAction={updateAction}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}

export const adminPages = {
  'admin/overview': StoreAdminProductsPage,
} as const;
