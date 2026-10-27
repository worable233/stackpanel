'use client';

import * as React from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import { Toast } from '@animate-ui/react/primitives/base-ui/toast';
import { cn } from '@/lib/utils';
import { useTranslator } from '@/i18n/provider';

const manager = Toast.createToastManager();

type ToastKind = 'success' | 'error' | 'info' | 'default';

export interface ToastOptions {
  id?: string;
  description?: React.ReactNode;
  duration?: number;
}

function add(kind: ToastKind, title: React.ReactNode, options: ToastOptions = {}) {
  return manager.add({
    title,
    description: options.description,
    id: options.id,
    timeout: options.duration,
    data: { kind },
  });
}

function toast(title: React.ReactNode, options?: ToastOptions) {
  return add('default', title, options);
}

toast.success = (title: React.ReactNode, options?: ToastOptions) => add('success', title, options);
toast.error = (title: React.ReactNode, options?: ToastOptions) => add('error', title, options);
toast.info = (title: React.ReactNode, options?: ToastOptions) => add('info', title, options);
toast.dismiss = (id?: string) => manager.close(id);

type ToastData = { kind?: ToastKind };

function ToastList() {
  const t = useTranslator();
  const { toasts } = Toast.useToastManager<ToastData>();

  return (
    <>
      {toasts.map((item) => {
        const kind = item.data?.kind ?? 'default';
        const Icon = kind === 'success' ? CheckCircle2 : kind === 'error' ? CircleAlert : Info;
        return (
          <Toast.Root
            key={item.id}
            toast={item}
            className="relative w-full overflow-hidden rounded-xl bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
            <Toast.Content className="flex items-start gap-3">
              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center',
                  kind === 'error' ? 'text-destructive' : 'text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Toast.Title className="text-sm font-medium">{item.title}</Toast.Title>
                {item.description ? (
                  <Toast.Description className="text-sm text-muted-foreground">
                    {item.description}
                  </Toast.Description>
                ) : null}
              </div>
              <Toast.Close
                aria-label={t('common.close')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden="true" />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        );
      })}
    </>
  );
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} limit={4}>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export { toast, manager as toastManager };
