'use client';
import { ArrowRight, Layers3, Server, ShieldCheck } from 'lucide-react';
import { cn } from './cn.js';
const stories = [
  {
    text: '从第一个网站，到下一次业务增长。为每个认真做产品的人，提供合适的云资源。',
    label: '轻松起步',
    detail: '为你的第一个项目选好云',
    icon: Layers3,
  },
  {
    text: '业务在成长，云资源也跟着需求走。按当前负载选择配置，为下一次上线做好准备。',
    label: '灵活选型',
    detail: '配置与预算，适合就好',
    icon: Server,
  },
  {
    text: '把时间留给产品和客户。云资源的选购与管理，在一个控制台里完成。',
    label: '专注业务',
    detail: '云服务，随时查看与管理',
    icon: ShieldCheck,
  },
];
export function PlatformStories() {
  return (
    <div
      data-stories=""
      className="relative mx-auto w-full max-w-6xl"
      aria-roledescription="轮播"
      aria-label="云服务理念"
    >
      <div className="relative min-h-64 md:min-h-80">
        {stories.map((item, i) => (
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
          {stories.map((story, i) => (
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
            href="#features"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-border bg-transparent px-4 text-sm text-foreground transition duration-300 hover:bg-muted active:translate-y-px motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-ring"
          >
            了解云产品
            <ArrowRight className="size-4" />
          </a>
          <div className="flex gap-4">
            {stories.map((item, i) => (
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
