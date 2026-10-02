'use server';
import { revalidatePath } from 'next/cache';
import type { DeveloperSpScope, ResellerView } from '@stackpanel/sdk';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface DeveloperActionResult {
  ok?: boolean;
  error?: string;
  message?: string;
  reseller?: ResellerView;
  /** 仅新建 / 轮换返回：入站私钥，一次性交付伙伴。 */
  inboundPrivateKey?: string;
}

/** 新建渠道；服务端生成 Ed25519 入站密钥，私钥仅在响应中返回一次。 */
export async function createResellerAction(input: {
  name: string;
  scopes: DeveloperSpScope[];
  rateLimitRpm: number;
  webhookUrl?: string;
}): Promise<DeveloperActionResult> {
  const locale = await getLocale();
  const name = input.name?.trim();
  if (!name) return { error: translate(locale, 'action.developerResellerNameRequired') };
  try {
    const api = await getAuthedApiClient();
    const result = await api.createReseller({
      name,
      scopes: input.scopes,
      rateLimitRpm: input.rateLimitRpm,
      ...(input.webhookUrl?.trim() ? { webhookUrl: input.webhookUrl.trim() } : {}),
    });
    revalidatePath('/admin/developer');
    return {
      ok: true,
      message: translate(locale, 'action.developerResellerCreated'),
      reseller: result.reseller,
      inboundPrivateKey: result.inboundPrivateKey,
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.developerResellerCreateFailed')),
    };
  }
}

/** 更新渠道名称 / 状态 / scope / 限额 / 回调地址。 */
export async function updateResellerAction(
  id: string,
  input: {
    name?: string;
    status?: 'ACTIVE' | 'DISABLED';
    scopes?: DeveloperSpScope[];
    rateLimitRpm?: number;
    webhookUrl?: string | null;
  },
): Promise<DeveloperActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.updateReseller(id, input);
    revalidatePath('/admin/developer');
    return {
      ok: true,
      message: translate(locale, 'action.developerResellerUpdated'),
      reseller: result.reseller,
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.developerResellerUpdateFailed')),
    };
  }
}

/** 轮换入站密钥对；旧公钥立即失效，新私钥一次性返回。 */
export async function rotateResellerKeyAction(id: string): Promise<DeveloperActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.rotateResellerKey(id);
    revalidatePath('/admin/developer');
    return {
      ok: true,
      message: translate(locale, 'action.developerResellerRotated'),
      reseller: result.reseller,
      inboundPrivateKey: result.inboundPrivateKey,
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.developerResellerRotateFailed')),
    };
  }
}

/** 删除渠道及其全部回调投递记录。 */
export async function deleteResellerAction(id: string): Promise<DeveloperActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.deleteReseller(id);
    revalidatePath('/admin/developer');
    return { ok: true, message: translate(locale, 'action.developerResellerDeleted') };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.developerResellerDeleteFailed')),
    };
  }
}
