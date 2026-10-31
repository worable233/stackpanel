import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

/**
 * 是否处于移动端断点。
 *
 * 用 `useSyncExternalStore` 直接订阅 `matchMedia`：这样「初始值」与「订阅后的更新」
 * 来自同一个来源，不需要在 effect 里补一次 `setState`（那会先渲染一帧错误布局，
 * 再级联重渲染，`react-hooks/set-state-in-effect` 正是拦这个）。SSR 侧一律按桌面处理。
 */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
