'use server';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

/** Server actions for the admin per-page SEO editor (#12.4). */

export interface SeoActionResult {
  error?: string;
  ok?: boolean;
}

export interface SeoPageInput {
  path: string;
  title?: string | null;
  description?: string | null;
  ogImage?: string | null;
  canonical?: string | null;
  noindex?: boolean;
}

function nullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

export async function saveSeoPageAction(input: SeoPageInput): Promise<SeoActionResult> {
  const locale = await getLocale();
  if (!input.path?.trim()) return { error: translate(locale, 'action.seoPathRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.upsertSeoPage({
      path: input.path.trim(),
      title: nullable(input.title),
      description: nullable(input.description),
      ogImage: nullable(input.ogImage),
      canonical: nullable(input.canonical),
      noindex: input.noindex ?? false,
    });
    revalidatePath('/admin/seo');
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.seoSaveFailed')) };
  }
}

export async function deleteSeoPageAction(id: string): Promise<SeoActionResult> {
  const locale = await getLocale();
  if (!id) return { error: translate(locale, 'action.seoSaveFailed') };
  try {
    const api = await getAuthedApiClient();
    await api.deleteSeoPage(id);
    revalidatePath('/admin/seo');
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.seoDeleteFailed')) };
  }
}
