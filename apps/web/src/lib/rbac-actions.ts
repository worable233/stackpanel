'use server';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface RbacActionResult {
  error?: string;
  ok?: boolean;
  message?: string;
}

/** Create a new permission group. */
export async function createPermissionGroupAction(input: {
  name: string;
  description?: string;
  discount?: number | null;
}): Promise<RbacActionResult> {
  const locale = await getLocale();
  const name = input.name?.trim();
  if (!name) return { error: translate(locale, 'action.permissionGroupNameRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.createPermissionGroup({
      name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.discount !== undefined ? { discount: input.discount } : {}),
    });
    revalidatePath('/admin/rbac');
    return { ok: true, message: translate(locale, 'action.permissionGroupCreated') };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.permissionGroupCreateFailed')),
    };
  }
}

/** Update a permission group's details, permission set and/or store discount. */
export async function updatePermissionGroupAction(
  id: string,
  input: { name?: string; description?: string; permissionKeys?: string[]; discount?: number | null },
): Promise<RbacActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const body: {
      name?: string;
      description?: string;
      permissionKeys?: string[];
      discount?: number | null;
    } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.permissionKeys !== undefined) body.permissionKeys = input.permissionKeys;
    if (input.discount !== undefined) body.discount = input.discount;
    await api.updatePermissionGroup(id, body);
    revalidatePath('/admin/rbac');
    return { ok: true, message: translate(locale, 'action.permissionGroupUpdated') };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.permissionGroupUpdateFailed')),
    };
  }
}

/** Delete a permission group. */
export async function deletePermissionGroupAction(id: string): Promise<RbacActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.deletePermissionGroup(id);
    revalidatePath('/admin/rbac');
    return { ok: true, message: translate(locale, 'action.permissionGroupDeleted') };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.permissionGroupDeleteFailed')),
    };
  }
}
