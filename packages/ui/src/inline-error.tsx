'use client';

import type { ComponentProps } from 'react';

import { cn } from './cn.js';

/**
 * 单行错误提示。
 *
 * 审计 §6 P4 的收尾项：各页面/插件此前各自手写
 * `<p role="alert" className="text-sm text-destructive">`，颜色、字号、role 各写一遍，
 * 漏了 `role` 就丢掉了屏幕阅读器通知。现在强制走这一个组件。
 *
 * `role="alert"` 是**断言式**的：只用于「刚发生了一件坏事」。持续状态说明
 * （未启用、只读、不支持）请用 `InlineNotice`，否则每次重渲染都会打断读屏用户。
 */
export function InlineError({ className, children, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="inline-error"
      role="alert"
      className={cn('text-sm text-destructive', className)}
      {...props}
    >
      {children}
    </p>
  );
}

/**
 * 非错误的单行状态说明（未启用 / 只读 / 不支持该操作）。
 *
 * `role="status"` 是**礼貌式**的：读屏在空档时播报，不会抢占当前朗读。
 */
export function InlineNotice({ className, children, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="inline-notice"
      role="status"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    >
      {children}
    </p>
  );
}
