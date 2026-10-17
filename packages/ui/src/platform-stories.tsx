'use client';
import { ArrowRight, Layers3, Server, ShieldCheck } from 'lucide-react';
import { cn } from './cn.js';
const stories = [
  {
    text: '每一个改变，都从一个想法开始。以云承载业务，以 AI 拓展可能，让创新走得更远。',
    label: '轻松起步',
    detail: '让创意从云端启程',
    icon: Layers3,
  },
  {
    text: '从第一行代码，到服务更多客户。选择适合业务阶段的云资源，为下一步发展做好准备。',
    label: '灵活选型',
    detail: '匹配当下，也面向未来',
    icon: Server,
  },
  {
    text: '让技术服务于业务，让精力回归创造。以统一的云平台，连接资源、应用与智能。',
    label: '专注业务',
    detail: '让云成为创新的基础',
    icon: ShieldCheck,
  },
];
export function PlatformStories({
  items,
  actionLabel = '了解云产品',
  actionHref = '#features',
}: {
  items?: Array<{ text: string; label: string; detail: string }>;
  actionLabel?: string;
  actionHref?: string;
}) {
  const content = items
    ? items.map((item, index) => ({ ...item, icon: stories[index % stories.length]!.icon }))
    : stories;
  return (
    <div
      data-stories=""
      className="relative mx-auto w-full max-w-6xl"
      aria-roledescription="轮播"
      aria-label="云服务理念"
    >
      <div className="relative min-h-64 md:min-h-80">
        {content.map((item, i) => (
          <p
            key={item.label}
            data-story-slide=""
            suppressHydrationWarning
            aria-hidden={i !== 0}
            className={cn(
              'absolute inset-0 text-3xl font-normal leading-tight tracking-tight transition-[opacity,filter,translate] duration-700 motion-reduce:transition-none md:text-5xl lg:text-6xl',
              i === 0
                ? 'translate-y-0 opacity-100 blur-0'
                : 'pointer-events-none translate-y-5 opacity-0 blur-[10px]',
            )}
          >
            {item.text}
          </p>
        ))}
      </div>
      <div className="flex flex-col justify-between gap-8 md:flex-row md:items-end">
        <div className="relative h-12 w-full md:w-80">
          {content.map((story, i) => (
            <div
              key={story.label}
              data-story-meta=""
              suppressHydrationWarning
              aria-hidden={i !== 0}
              className={cn(
                'absolute inset-0 flex items-center gap-5',
                i === 0 ? 'opacity-100' : 'opacity-0',
              )}
            >
              <story.icon className="size-12 text-primary" />
              <div>
                <p className="text-xl">{story.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">{story.detail}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-5">
          <a
            href={actionHref}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-transparent px-4 text-sm text-foreground transition duration-300 hover:bg-muted active:translate-y-px motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-ring"
          >
            {actionLabel}
            <ArrowRight className="size-4" />
          </a>
          <div className="flex gap-4">
            {content.map((item, i) => (
              <button
                type="button"
                key={item.label}
                aria-label={`查看${item.label}`}
                aria-pressed={i === 0}
                data-story-control=""
                suppressHydrationWarning
                className="relative py-3 text-sm text-muted-foreground transition-colors hover:text-foreground aria-pressed:text-foreground [&[aria-pressed=true]>span]:bg-primary"
              >
                {String(i + 1).padStart(2, '0')}
                <span className="absolute inset-x-0 bottom-1 h-px bg-border" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
