import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { ExtensionNotFound } from '@stackpanel/sdk';
import { z } from 'zod';
import { StoreError } from './errors';
import {
  createCategoryInstance,
  deleteCategoryInstance,
  getCategory,
  listEnabledCategories,
  replaceCategory,
  type CategoryRecord,
} from './repository';
import type { StoreCategoryData } from './data';

const categorySchema = z.object({
  name: z.string().trim().min(1).max(191),
  slug: z.string().trim().min(1).max(191).optional(),
  description: z.string().trim().max(500).optional(),
  parentId: z.string().min(1).max(191).nullish(),
  sortOrder: z.number().int().default(0),
  fulfillmentTypes: z.array(z.string().min(1).max(64)).optional(),
  providerId: z.string().min(1).max(64).nullish(),
  enabled: z.boolean().default(true),
});

const categoryUpdateSchema = categorySchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: '至少需要一个更新字段',
});

function serialize(category: CategoryRecord) {
  const { fulfillmentTypes, ...rest } = category;
  return {
    ...rest,
    fulfillmentTypes: Array.isArray(fulfillmentTypes) ? fulfillmentTypes : undefined,
  };
}

/** 公开分类树（仅启用的分类）。 */
export async function listCategories(_req: HttpRequest): Promise<unknown> {
  const all = await listEnabledCategories();
  return { categories: buildTree(all) };
}

function buildTree(rows: CategoryRecord[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      sortOrder: row.sortOrder,
      providerId: row.providerId,
      ...(Array.isArray(row.fulfillmentTypes)
        ? { fulfillmentTypes: row.fulfillmentTypes as string[] }
        : {}),
      children: [],
    });
  }
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (row.parentId && byId.has(row.parentId)) {
      byId.get(row.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

interface CategoryNode {
  id: string;
  name: string;
  slug: string | null;
  sortOrder: number;
  providerId: string | null;
  fulfillmentTypes?: string[];
  children: CategoryNode[];
}

export async function createCategory(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const data = parsed.data;
  const category = await createCategoryInstance({
    name: data.name,
    slug: data.slug ?? null,
    description: data.description ?? null,
    parentId: data.parentId ?? null,
    sortOrder: data.sortOrder,
    fulfillmentTypes: data.fulfillmentTypes?.length ? data.fulfillmentTypes : null,
    providerId: data.providerId ?? null,
    enabled: data.enabled,
  });
  return reply.code(201).send({ category: serialize(category) });
}

export async function updateCategory(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const parsed = categoryUpdateSchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const data = parsed.data;
  const existing = await getCategory(id);
  if (!existing) throw new StoreError(404, '分类不存在');
  const next: StoreCategoryData = {
    name: data.name ?? existing.name,
    slug: data.slug !== undefined ? data.slug : existing.slug,
    description: data.description !== undefined ? data.description : existing.description,
    parentId: data.parentId !== undefined ? (data.parentId ?? null) : existing.parentId,
    sortOrder: data.sortOrder ?? existing.sortOrder,
    fulfillmentTypes:
      data.fulfillmentTypes !== undefined
        ? data.fulfillmentTypes.length
          ? data.fulfillmentTypes
          : null
        : existing.fulfillmentTypes,
    providerId: data.providerId !== undefined ? (data.providerId ?? null) : existing.providerId,
    enabled: data.enabled ?? existing.enabled,
  };
  try {
    const category = await replaceCategory(id, next);
    return { category: serialize(category) };
  } catch (error) {
    if (error instanceof ExtensionNotFound) throw new StoreError(404, '分类不存在');
    throw error;
  }
}

export async function deleteCategory(req: HttpRequest, reply: HttpReply): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  try {
    await deleteCategoryInstance(id);
    return reply.code(204).send();
  } catch (error) {
    if (error instanceof ExtensionNotFound) throw new StoreError(404, '分类不存在');
    throw error;
  }
}
