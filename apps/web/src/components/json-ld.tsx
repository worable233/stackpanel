import { createElement } from 'react';
import type { SeoEntityMeta } from '@stackpanel/sdk';

/**
 * `JSON.stringify` 不转义 `<`/`>`/`&`，若内容含 `</script>` 会提前闭合脚本标签，
 * 造成存储型 XSS（审计 H-1）。序列化后再做 HTML 安全转义，同时覆盖 JSON 中合法
 * 但会破坏内联脚本解析的 U+2028/U+2029。
 */
const JSON_LD_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** 将结构化数据序列化为可安全内联到 `<script>` 的 JSON 文本。 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_LD_ESCAPES[char] as string,
  );
}

/**
 * 渲染合并后的 JSON-LD 结构化数据（ADR-0011 §4）。无 `jsonLd` 时不渲染任何节点。
 */
export function JsonLd({ meta }: { meta: SeoEntityMeta }): React.ReactElement | null {
  if (!meta.jsonLd) return null;
  const data = Array.isArray(meta.jsonLd) ? meta.jsonLd : [meta.jsonLd];
  return createElement('script', {
    type: 'application/ld+json',
    dangerouslySetInnerHTML: { __html: serializeJsonLd(data) },
  });
}
