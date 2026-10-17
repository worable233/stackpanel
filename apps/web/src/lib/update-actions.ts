'use server';

import type { UpdatePlanResponse, UpdateStatusResponse } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface UpdateCenterState {
  ok?: boolean;
  error?: string;
  message?: string;
  plan?: UpdatePlanResponse;
  status?: UpdateStatusResponse;
}

/** Re-read the update center status. */
export async function refreshUpdateStatusAction(): Promise<UpdateCenterState> {
  try {
    const api = await getAuthedApiClient();
    return { ok: true, status: await api.getUpdateStatus() };
  } catch (err) {
    return { error: await apiErrorMessage(err) };
  }
}

/** Solve a full deployment plan (no state change). */
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

/** Submit the solved plan as an update task to the instance-private channel. */
export async function submitUpdateAction(acknowledge: boolean): Promise<UpdateCenterState> {
  try {
    const api = await getAuthedApiClient();
    const result = await api.submitUpdate({ acknowledge });
    return { ok: true, message: `升级任务已投递（${result.idempotencyKey.slice(0, 12)}…）` };
  } catch (err) {
    return { error: await apiErrorMessage(err) };
  }
}
