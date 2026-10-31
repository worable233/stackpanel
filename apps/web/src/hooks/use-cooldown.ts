'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 服务端给出的冷却信号：`{ seconds, rev }`。
 *
 * `rev` 是产生这条信号的服务端结果对象本身。只比较 `seconds` 不行：先发码（60 秒）、
 * 再被限流（还是 60 秒）会被当成同一条信号，倒计时就不会重新开始。
 */
export interface CooldownSignal {
  seconds: number;
  rev: unknown;
}

/**
 * 把「服务端说还要等 N 秒」渲染成一个会自己走的倒计时。
 *
 * 为什么在 effect 里对齐、而不是在渲染期对齐（React 文档里那条"props 变化时调整
 * state"的写法）：这些组件会被 Next **服务端渲染**。服务端渲染每次都会新建一个
 * state 容器，渲染期 `setState` 因此永远收敛不了，直接抛「Too many re-renders」。
 * 也就是说渲染期对齐只能在纯客户端组件里用，这里不成立。
 *
 * 剩下的选择是显式关掉 `react-hooks/set-state-in-effect`：规则的目标是拦"为了派生
 * 数据而多绕一次渲染"，而这里的来源是**一次服务端动作的结果**——它没有别的落地点。
 * 首帧闪一下可点击的代价，由「按钮初始为禁用 + 服务端立刻拦一次」兜住。
 */
export function useCooldown(signal: CooldownSignal | null): number {
  const [seconds, setSeconds] = useState(0);
  const seenRef = useRef<unknown>(null);

  useEffect(() => {
    if (!signal || signal.rev === seenRef.current) return;
    seenRef.current = signal.rev;
    // 剩余秒数以服务端为准：它比窗口长度更准（访客可能已经等过一半）。
    setSeconds(Math.max(0, Math.floor(signal.seconds)));
  }, [signal]);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);

  return seconds;
}

/**
 * 在一批服务端结果里挑出「现在该按哪条冷却信号倒计时」（纯函数，可在渲染期直接算）。
 *
 * 优先级就是危害程度：码已作废 → 立刻解锁（0 秒）；被限流 → 用服务端给的剩余秒数；
 * 码已投递 → 起一个完整窗口。
 */
export function cooldownSignalFor(
  results: ReadonlyArray<
    | {
        retryAfterSeconds?: number;
        notice?: string | null;
        errorCode?: string | null;
      }
    | null
    | undefined
  >,
  deadCodeErrors: ReadonlySet<string>,
  deliveredSeconds: number,
): CooldownSignal | null {
  const present = results.filter((result) => result != null);

  // 三趟扫描，而不是一趟里按顺序抢答：两个结果常常同时存在（发码成功留下 notice，
  // 随后注册又报「码已作废」）。按数组顺序取第一条会命中那条过期的 notice，
  // 于是按钮继续倒计时——正好是这套逻辑要消灭的死路。
  const dead = present.find((result) => result.errorCode && deadCodeErrors.has(result.errorCode));
  if (dead) return { seconds: 0, rev: dead };

  const throttled = present.find(
    (result) => typeof result.retryAfterSeconds === 'number' && result.retryAfterSeconds > 0,
  );
  if (throttled) return { seconds: throttled.retryAfterSeconds as number, rev: throttled };

  const delivered = present.find((result) => result.notice);
  if (delivered) return { seconds: deliveredSeconds, rev: delivered };

  return null;
}
