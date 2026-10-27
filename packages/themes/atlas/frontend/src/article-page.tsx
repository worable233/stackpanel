import { PACKAGE_FALLBACK_LOCALE, type FrontendPageProps } from '@stackpanel/sdk';
import { ArticleBody } from '@stackpanel/ui';
import { ArrowLeft, ArrowUpRight, Clock3 } from 'lucide-react';
import type { ReactElement } from 'react';
import { t } from './i18n.js';

type Post = {
  title: string;
  excerpt: string;
  body: string;
  publishedAt: string | null;
  updatedAt: string;
};

export function AtlasArticlePage({ data, locale }: FrontendPageProps): ReactElement {
  const tr = t(locale);
  const result = data.article as { post?: Post; missing?: boolean } | undefined;
  const post = result?.post;

  if (!post) {
    return (
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start px-4 py-16 sm:px-6 lg:py-24">
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            404
          </span>
          <h1 className="mt-5 text-3xl font-medium tracking-tight sm:text-4xl">
            {tr('article.notFound')}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{tr('article.notFoundText')}</p>
          <a
            href="/"
            className="mt-8 inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm transition-colors hover:bg-muted/70"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {tr('article.backHome')}
          </a>
        </div>
      </main>
    );
  }

  const headings = post.body
    .replace(/```[^\n]*\n[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => /^#{2,3}\s+/.test(line))
    .map((line, index) => ({
      id: `section-${index}`,
      label: line.replace(/^#+\s+/, '').replace(/[*`_]/g, ''),
      nested: line.startsWith('### '),
    }));
  const minutes = Math.max(1, Math.ceil(post.body.replace(/\s/g, '').length / 450));
  const date = new Date(post.publishedAt ?? post.updatedAt);

  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-16">
        <a
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {tr('article.backHome')}
        </a>

        <header className="mt-8 max-w-3xl">
          <span className="text-sm font-medium text-muted-foreground">{tr('article.kicker')}</span>
          <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <time dateTime={date.toISOString()}>
              {date.toLocaleDateString(locale ?? PACKAGE_FALLBACK_LOCALE, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" aria-hidden="true" />
              {tr('article.readingTime', { minutes: String(minutes) })}
            </span>
          </div>
          <h1 className="mt-4 text-4xl font-medium leading-tight tracking-tight text-balance sm:text-5xl">
            {post.title}
          </h1>
          {post.excerpt ? (
            <p className="mt-5 text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              {post.excerpt}
            </p>
          ) : null}
        </header>

        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_200px] lg:items-start">
          <article className="rounded-[24px] bg-muted/35 p-6 sm:p-10">
            <ArticleBody body={post.body} />
          </article>

          {headings.length > 1 ? (
            <aside className="lg:sticky lg:top-24">
              <nav aria-label={tr('article.tocAria')}>
                <p className="mb-3 text-xs font-medium text-muted-foreground">
                  {tr('article.tocTitle')}
                </p>
                <ol className="flex flex-col gap-2.5 text-xs leading-5">
                  {headings.map((heading) => (
                    <li key={heading.id}>
                      <a
                        href={`#${heading.id}`}
                        className={`block text-muted-foreground transition-colors hover:text-foreground ${
                          heading.nested ? 'pl-4' : ''
                        }`}
                      >
                        {heading.label}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            </aside>
          ) : null}
        </div>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-4">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {tr('article.backHome')}
          </a>
          <a href="/shop" className="inline-flex items-center gap-2 text-sm font-medium">
            {tr('article.explore')}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        </footer>
      </div>
    </main>
  );
}
