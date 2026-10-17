import type { ReactNode } from 'react';
import { Reveal } from './reveal.js';

export type ErrorPageKind =
  'unauthorized' | 'forbidden' | 'not-found' | 'server-error' | 'maintenance';

/** One rendered error page. Copy is supplied by the caller (ADR-0016 §6). */
export interface ErrorPageContent {
  code: string;
  title: string;
  description: string;
}

/**
 * Default HTTP status codes per kind. Codes are language independent, so they
 * can live here; the title/description cannot — `@stackpanel/ui` has no access
 * to the host's message catalogs.
 */
const CODES: Record<ErrorPageKind, string> = {
  unauthorized: '401',
  forbidden: '403',
  'not-found': '404',
  'server-error': '500',
  maintenance: '503',
};

export interface ErrorPageProps {
  kind: ErrorPageKind;
  /** Localized copy for this kind. Falls back to the bare status code. */
  content?: Partial<ErrorPageContent>;
  actions?: ReactNode;
}

export function ErrorPage({ kind, content, actions }: ErrorPageProps) {
  const code = content?.code ?? CODES[kind];
  return (
    <main className="relative flex min-h-[80vh] flex-1 items-center justify-center overflow-hidden px-6 pb-20 pt-28">
      <Reveal className="w-full max-w-2xl text-center">
        <p className="text-[7rem] font-bold leading-none tracking-tighter text-foreground sm:text-[10rem]">
          {code}
        </p>
        {content?.title ? (
          <h1 className="mt-8 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {content.title}
          </h1>
        ) : null}
        {content?.description ? (
          <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
            {content.description}
          </p>
        ) : null}
        {actions ? (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{actions}</div>
        ) : null}
      </Reveal>
    </main>
  );
}
