import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Clock3 } from 'lucide-react';
import type { FrontendPageProps } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import { ArticleBody, ErrorPage, Reveal } from '@stackpanel/ui';

type Post = {
  title: string;
  excerpt: string;
  body: string;
  publishedAt: string | null;
  updatedAt: string;
};

export function ArticlePage({ data, locale }: FrontendPageProps): ReactElement {
  const result = data.article as { post?: Post; missing?: boolean } | undefined;
  const post = result?.post;
  if (!post) return <ErrorPage kind={result?.missing ? 'not-found' : 'server-error'} />;
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
    <main className="relative isolate min-h-[70vh] pb-24 pt-32 sm:pt-40 lg:pb-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[480px] overflow-hidden"
      >
        <div className="absolute -top-56 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-primary/10 blur-[100px]" />
      </div>
      <div className="mx-auto max-w-6xl px-6 md:px-12">
        <Reveal>
          <header className="mx-auto max-w-3xl border-b border-border/60 pb-10 sm:pb-12">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              首页
            </Link>
            <div className="mt-9 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="text-primary">文章</span>
              <span aria-hidden="true">/</span>
              <time dateTime={date.toISOString()}>
                {date.toLocaleDateString(locale ?? 'zh-CN', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="size-3.5" />约 {minutes} 分钟
              </span>
            </div>
            <h1 className="mt-5 text-3xl font-medium leading-tight tracking-tight text-balance sm:text-4xl lg:text-5xl">
              {post.title}
            </h1>
            {post.excerpt && (
              <p className="mt-6 text-base leading-8 text-muted-foreground sm:text-lg">
                {post.excerpt}
              </p>
            )}
          </header>
        </Reveal>
        <div className="relative mx-auto max-w-3xl pt-4 sm:pt-7">
          {headings.length > 1 && (
            <aside className="mb-7 border-b border-border/60 py-5 xl:absolute xl:left-[calc(100%+3rem)] xl:bottom-0 xl:top-7 xl:mb-0 xl:w-40 xl:border-0 xl:py-0">
              <nav aria-label="文章目录" className="xl:sticky xl:top-28">
                <p className="mb-4 text-xs font-medium text-muted-foreground">本文目录</p>
                <ol className="flex flex-col gap-3 border-l border-border/60 text-xs leading-5">
                  {headings.map((heading) => (
                    <li key={heading.id}>
                      <a
                        href={`#${heading.id}`}
                        className={`block text-muted-foreground transition-colors hover:text-foreground ${heading.nested ? 'pl-6' : 'pl-4'}`}
                      >
                        {heading.label}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            </aside>
          )}
          <ArticleBody body={post.body} />
          <footer className="mt-16 flex flex-wrap items-center justify-between gap-5 border-t border-border/60 pt-7 text-sm">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              返回首页
            </Link>
            <Link href="/shop" className="inline-flex items-center gap-2 text-foreground">
              探索云产品
              <ArrowUpRight className="size-4" />
            </Link>
          </footer>
        </div>
      </div>
    </main>
  );
}
