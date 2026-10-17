'use client';

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * 账户页「复制推广链接」按钮。
 *
 * 为什么文件叫 `route-progress.tsx`：`scripts/build-frontend.mjs` 只对文件名恰好是
 * `route-progress.tsx` 的额外入口注入 `--banner:js="use client";`（见脚本
 * `:67-86`）。其余文件名即使首行写了 `'use client'`，esbuild 也会把指令当普通
 * 语句处理，产物不是客户端模块。插件前端能加交互的既有入口只有两条：
 * `admin.tsx`（管理页）与 `route-progress.tsx`（账户页）。本文件因此沿用后者的
 * 名字，只为拿到 client banner。
 *
 * 该入口只能用 `react` / `react/jsx-runtime` / `next/navigation` 三个外部包，
 * 所以这里直接写 Tailwind 原语，不引 `@stackpanel/ui`。
 */
export function CopyLinkButton({
  code,
  copyLabel,
  copiedLabel,
}: {
  code: string;
  /** Localized "copy link" label (ADR-0016 §5). */
  copyLabel: string;
  /** Localized "copied" label. */
  copiedLabel: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const link = `${window.location.origin}/?affid=${encodeURIComponent(code)}`;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(() => {
        // 剪贴板被拒（非安全上下文 / 权限）时退回 execCommand。
        fallbackCopy(link, done);
      });
      return;
    }
    fallbackCopy(link, done);
  }, [code]);

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted"
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}

function fallbackCopy(text: string, done: () => void): void {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
    done();
  } catch {
    // 复制失败静默——用户仍可手工选中链接。
  }
}
