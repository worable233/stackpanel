'use server';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';
import type { SettingsActionState } from './settings-actions';

/**
 * 运行期配置的保存动作（ADR-0026）。
 *
 * 值一律以**字符串**提交，由内核用 `envSchema` 的同名字段解析——前端不重复实现
 * 取值域校验，避免「界面认为合法、运行期解析失败」。
 */

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === 'string' ? value : '';
}

/** 保存（或清除）一项运行期配置。`op=clear` 表示回退到环境变量。 */
export async function saveRuntimeConfigAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const name = text(formData, 'name');
  const op = text(formData, 'op');
  if (name.length === 0) return { error: translate(locale, 'common.operationFailed') };
  try {
    const api = await getAuthedApiClient();
    if (op === 'clear') {
      await api.clearAdminConfig(name);
      revalidatePath('/admin/settings');
      return { ok: true, message: translate(locale, 'action.runtimeConfigReverted') };
    }
    const raw = text(formData, 'value').trim();
    if (raw.length === 0) {
      // 空输入没有合法语义（空串在环境变量里表示"未设置"），按回退处理更安全。
      await api.clearAdminConfig(name);
      revalidatePath('/admin/settings');
      return { ok: true, message: translate(locale, 'action.runtimeConfigReverted') };
    }
    await api.setAdminConfig(name, raw);
    revalidatePath('/admin/settings');
    return { ok: true, message: translate(locale, 'action.runtimeConfigSaved') };
  } catch (err) {
    return { error: await apiErrorMessage(err) };
  }
}
