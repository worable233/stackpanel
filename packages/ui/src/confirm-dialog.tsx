'use client';

import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import type { ReactNode } from 'react';

import { Button } from './button.js';
import { cn } from './cn.js';

/**
 * 危险/不可逆操作的确认框（AlertDialog 语义，不是普通 Dialog）。
 *
 * 存在的理由：审计 §6 P4 —— 各插件此前各自 `window.confirm()`，它阻塞主线程、
 * 无法本地化按钮、无法主题化、不可测试，而且提示文案只能是一行纯文本。
 *
 * 刻意不内置任何文案：`@stackpanel/ui` 拿不到宿主或插件的语言目录，所以
 * `title` / `description` / `confirmLabel` / `cancelLabel` 必须由调用方传入已本地化
 * 的字符串（ADR-0016 §6）。`pending` 期间两个按钮都禁用，避免重复提交。
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  /** 由调用方持有异步状态；`true` 时两个按钮禁用并挡掉 Esc/点外部关闭。 */
  pending?: boolean;
  /** 不可逆操作（删除、撤销、退款）用 `destructive` 变体。 */
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  pending = false,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // 提交中不接受关闭：否则用户能在请求飞行时把确认框关掉，行为看起来像取消。
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Backdrop
          data-slot="confirm-dialog-backdrop"
          className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <AlertDialogPrimitive.Popup
          data-slot="confirm-dialog-content"
          className={cn(
            'fixed top-1/2 left-1/2 z-50 grid w-full max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-background p-6 text-foreground shadow-xl ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          )}
        >
          <div className="flex flex-col gap-1.5">
            <AlertDialogPrimitive.Title
              data-slot="confirm-dialog-title"
              className="text-lg leading-none font-semibold tracking-tight"
            >
              {title}
            </AlertDialogPrimitive.Title>
            {description ? (
              <AlertDialogPrimitive.Description
                data-slot="confirm-dialog-description"
                className="text-sm text-muted-foreground"
              >
                {description}
              </AlertDialogPrimitive.Description>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Close
              data-slot="confirm-dialog-cancel"
              render={<Button variant="outline" disabled={pending} />}
            >
              {cancelLabel}
            </AlertDialogPrimitive.Close>
            <Button
              data-slot="confirm-dialog-confirm"
              variant={destructive ? 'destructive' : 'default'}
              disabled={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
