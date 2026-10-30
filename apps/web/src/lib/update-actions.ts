'use server';

import type {
  UpdateCheckResponse,
  UpdatePlanResponse,
  UpdatePolicyView,
  UpdateResultsResponse,
  UpdateSelfUpdateResponse,
  UpdateStatusResponse,
} from '@stackpanel/sdk';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';
import { buildUpdatePolicyPatch, readUpdatePolicyForm } from './update-policy-form';

/**
 * 更新中心的服务端动作（PLAN-github-distribution-and-updates §9）。
 *
 * 三条不变量，任何改动都不能破坏：
 * 1. **渲染路径不出网**：`refreshUpdateSnapshotAction` 只读 API 的内存投影；
 *    真正发起目录请求的只有 `checkUpdateCatalogAction`，且它是显式动作。
 * 2. **授权只能来自人**：`acknowledge` / `allowExpired` 由调用方（确认交互）传入，
 *    绝不从计划字段派生——计划里只用来**决定是否要求**确认。
 * 3. **错误语义分层**：已知 code（`updates.*`）由 `error.*` 目录本地化，其余回落到
 *    该动作自己的兜底文案，服务端的英文原文永远不直接进 UI。
 */
export interface UpdateCenterState {
  ok?: boolean;
  error?: string;
  message?: string;
  /** Stable id of a submitted task; the UI composes the localized message. */
  taskKey?: string;
  plan?: UpdatePlanResponse;
  status?: UpdateStatusResponse;
  check?: UpdateCheckResponse;
  results?: UpdateResultsResponse['results'];
  policy?: UpdatePolicyView;
  selfUpdate?: UpdateSelfUpdateResponse['request'];
}

/**
 * 只读快照：状态投影 + 最近结果 + 待执行的升级器自升级请求。
 *
 * 首屏由服务端组件直接渲染，这里只用于「刷新」按钮与任务进行中的轮询。
 */
export async function refreshUpdateSnapshotAction(): Promise<UpdateCenterState> {
  try {
    const api = await getAuthedApiClient();
    const [status, results, selfUpdate] = await Promise.all([
      api.getUpdateStatus(),
      api.listUpdateResults().catch(() => ({ results: [] }) as UpdateResultsResponse),
      api.getUpdateSelfUpdate().catch(() => ({ request: null }) as UpdateSelfUpdateResponse),
    ]);
    return { ok: true, status, results: results.results, selfUpdate: selfUpdate.request };
  } catch (err) {
    return { error: await apiErrorMessage(err) };
  }
}

/**
 * 显式「检查更新」：强制刷新一次签名目录。
 *
 * 冷却期内服务端回 `throttled`（没有发出任何请求），UI 用 `retryAtMs` 提示还需等待多久。
 */
export async function checkUpdateCatalogAction(): Promise<UpdateCenterState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const check = await api.checkUpdateCatalog();
    return {
      ok: true,
      check,
      ...(check.plan ? { plan: check.plan } : {}),
      status: await api.getUpdateStatus().catch(() => undefined),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.updateCheckFailed')),
    };
  }
}

/** 求解完整部署计划（不改任何状态）。 */
export async function planUpdateAction(): Promise<UpdateCenterState> {
  try {
    const api = await getAuthedApiClient();
    const plan = await api.planUpdate();
    if (!plan.ok) return { ok: false, plan };
    return { ok: true, plan };
  } catch (err) {
    return { error: await apiErrorMessage(err) };
  }
}

/**
 * 投递升级任务。
 *
 * `acknowledge`（含权限增加/不可逆迁移时）与 `allowExpired`（目录已过期时）都必须由
 * 用户显式勾选——本函数不做任何推断。
 */
export async function submitUpdateAction(input: {
  acknowledge: boolean;
  allowExpired: boolean;
}): Promise<UpdateCenterState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.submitUpdate({
      acknowledge: input.acknowledge,
      allowExpired: input.allowExpired,
    });
    return { ok: true, taskKey: result.idempotencyKey };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.updateSubmitFailed')),
    };
  }
}

/** 保存更新策略（设置页表单）。 */
export async function saveUpdatePolicyAction(
  _prev: UpdateCenterState,
  formData: FormData,
): Promise<UpdateCenterState> {
  const locale = await getLocale();
  const parsed = buildUpdatePolicyPatch(readUpdatePolicyForm(formData));
  if (!parsed.ok) {
    return {
      error: translate(locale, 'action.updatePolicyInvalid'),
    };
  }
  try {
    const api = await getAuthedApiClient();
    const saved = await api.updateUpdatePolicy(parsed.patch);
    // 只刷新更新中心；设置页由 useActionState 回填结果。
    // 重新校验设置页会重挂载 Tabs / 滚动容器，导致页面跳回顶部。
    revalidatePath('/admin/updates');
    return {
      ok: true,
      policy: saved.policy,
      message: translate(locale, 'admin.settings.updates.saved'),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.updatePolicySaveFailed')),
    };
  }
}

/** 发起一次升级器自升级请求（写入共享卷，由 updater 消费）。 */
export async function submitSelfUpdateAction(
  _prev: UpdateCenterState,
  formData: FormData,
): Promise<UpdateCenterState> {
  const locale = await getLocale();
  const raw = formData.get('candidateDigest');
  const candidateDigest = typeof raw === 'string' ? raw.trim() : '';
  if (candidateDigest.length === 0) {
    return { error: translate(locale, 'action.updateSelfUpdateSubmitFailed') };
  }
  try {
    const api = await getAuthedApiClient();
    const result = await api.submitUpdateSelfUpdate(candidateDigest);
    revalidatePath('/admin/updates');
    return {
      ok: true,
      selfUpdate: result.request,
      message: translate(locale, 'admin.updates.selfUpdateSubmitted'),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.updateSelfUpdateSubmitFailed')),
    };
  }
}

/** 取消待执行的升级器自升级请求（只有尚未被 updater 消费时才能取消）。 */
export async function cancelSelfUpdateAction(): Promise<UpdateCenterState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.cancelUpdateSelfUpdate();
    revalidatePath('/admin/updates');
    return {
      ok: true,
      selfUpdate: null,
      message: result.cleared
        ? translate(locale, 'admin.updates.selfUpdateCancelled')
        : translate(locale, 'admin.updates.selfUpdateNone'),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.updateSelfUpdateCancelFailed')),
    };
  }
}
