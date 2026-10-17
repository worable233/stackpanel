import type { ReactNode } from 'react';
import { Reveal } from './reveal.js';
import { ErrorPageActions } from './error-page-actions.js';

export type ErrorPageKind =
  'unauthorized' | 'forbidden' | 'not-found' | 'server-error' | 'maintenance';

const CONTENT: Record<ErrorPageKind, { code: string; title: string; description: string }> = {
  unauthorized: {
    code: '401',
    title: '需要登录',
    description: '登录后即可继续访问这个页面。',
  },
  forbidden: {
    code: '403',
    title: '无权访问',
    description: '你的账户没有访问这个页面的权限。',
  },
  'not-found': {
    code: '404',
    title: '页面不存在',
    description: '你访问的地址不存在，或内容已经被移除。',
  },
  'server-error': {
    code: '500',
    title: '服务暂时不可用',
    description: '服务器遇到了一点问题，请稍后再试。',
  },
  maintenance: {
    code: '503',
    title: '系统维护中',
    description: '服务正在进行维护，完成后会自动恢复。',
  },
};

export function ErrorPage({ kind, actions }: { kind: ErrorPageKind; actions?: ReactNode }) {
  const content = CONTENT[kind];
  return (
    <main className="relative flex min-h-[80vh] flex-1 items-center justify-center overflow-hidden px-6 pb-20 pt-28">
      <Reveal className="w-full max-w-2xl text-center">
        <p className="text-[7rem] font-bold leading-none tracking-tighter text-foreground sm:text-[10rem]">
          {content.code}
        </p>
        <h1 className="mt-8 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          {content.title}
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
          {content.description}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {actions ?? <ErrorPageActions />}
        </div>
      </Reveal>
    </main>
  );
}
