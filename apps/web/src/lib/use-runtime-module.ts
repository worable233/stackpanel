'use client';

import { useEffect, useState } from 'react';
import { publishHostClientAbi } from '@/components/frontend-abi-bridge';

/**
 * 主计划 §5 阶段 4 M2 — 运行期装载一个宿主从未在构建期见过的浏览器模块。
 *
 * 装载前先 `publishHostClientAbi()`：确保 `/api/frontend-abi/*` 适配器被 `import()`
 * 时宿主 ABI 已就绪（SPIKE-results §0 的受控适配器桥接）。`turbopackIgnore` /
 * `webpackIgnore` 保持这是真正的浏览器动态 `import()`，而非构建期依赖。
 *
 * 同一 URL 只装载一次（按 URL 缓存模块，避免重复网络请求）。
 */
export type RuntimeModuleState =
  | { kind: 'loading'; data: null }
  | { kind: 'loaded'; data: unknown }
  | { kind: 'error'; data: null; message: string };

const moduleCache = new Map<string, Promise<unknown>>();

function loadModule(url: string): Promise<unknown> {
  let pending = moduleCache.get(url);
  if (!pending) {
    publishHostClientAbi();
    pending = import(/* turbopackIgnore: true */ /* webpackIgnore: true */ url).catch((error) => {
      moduleCache.delete(url);
      throw error;
    });
    moduleCache.set(url, pending);
  }
  return pending;
}

interface SettledState {
  url: string;
  kind: 'loaded' | 'error';
  data: unknown;
  message?: string;
}

export function useRuntimeModule(url: string | null | undefined): RuntimeModuleState {
  const [settled, setSettled] = useState<SettledState | null>(null);

  useEffect(() => {
    if (!url) return;
    let active = true;
    // Only the async callbacks set state, never the effect body (no cascading render).
    loadModule(url).then(
      (data) => {
        if (active) setSettled({ url, kind: 'loaded', data });
      },
      (error: unknown) => {
        if (active) {
          setSettled({
            url,
            kind: 'error',
            data: null,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [url]);

  // Derive: a `settled` state for a different URL is stale -> still loading.
  if (!url || !settled || settled.url !== url) return { kind: 'loading', data: null };
  if (settled.kind === 'error') {
    return { kind: 'error', data: null, message: settled.message ?? 'unknown error' };
  }
  return { kind: 'loaded', data: settled.data };
}
