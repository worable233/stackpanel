import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 反代模板必须把**对外**协议传给上游，而不是 nginx 自己这一跳的协议。
 *
 * 线上形态（v0.1.1）：面板 / CDN 在 TLS 终止后回源到 `listen 80`，模板里
 * `proxy_set_header X-Forwarded-Proto $scheme;` 于是永远送 `http`，而浏览器的
 * `Origin` 是 `https://…`。Web BFF 的同源守卫
 * （`apps/web/src/lib/request-origin.ts`）拿 `Origin` 的 scheme 与这个头比对，
 * 不等就 403 —— 表现为「请求来源无效」，**后台所有 POST 全部失效**，而页面本身
 * 完全正常（GET 不受影响），极难联想到反代。
 *
 * 这些断言只读模板文本，不需要起 nginx：它们锁住的是「不要再写回去」。
 */

const root = path.resolve(__dirname, '../../..');
const nginx = readFileSync(path.join(root, 'docker/proxy/nginx.conf.example'), 'utf8');

/** 去掉注释行，只检查真正生效的指令。 */
function directives(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('docker/proxy/nginx.conf.example', () => {
  const live = directives(nginx);

  it('never sends the hop-local $scheme as X-Forwarded-Proto', () => {
    expect(live).not.toMatch(/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/);
  });

  it('forwards a mapped proto that prefers the upstream header', () => {
    // 优先透传 CDN 写的 X-Forwarded-Proto；只有上游没写时才用 $scheme 兜底。
    expect(live).toMatch(/map\s+\$http_x_forwarded_proto\s+\$sp_forwarded_proto/);
    expect(live).toMatch(/default\s+\$http_x_forwarded_proto;/);
    expect(live).toMatch(/''\s+\$scheme;/);
  });

  it('uses that mapped value on every upstream block', () => {
    const blocks = live.match(/location[^{]*\{[\s\S]*?\n\s{4}\}/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      expect(block).toContain('X-Forwarded-Proto $sp_forwarded_proto');
      // 端口同理：$server_port 是回源端口（80），不是访客看到的 443。
      expect(block).toContain('X-Forwarded-Port  $sp_forwarded_port');
    }
  });

  it('routes /api/ with ^~ so a panel-level ^~ rule cannot swallow it', () => {
    // 1Panel / 宝塔 常在站点配置里写 `location ^~ /api/`；nginx 先匹配 ^~ 再看
    // 正则，裸正则版本会被静默吞掉，`/api/v1/*` 全落到 Web 上游 → 404。
    expect(live).toMatch(/location\s+\^~\s+\/api\/\s*\{/);
  });

  it('keeps the remaining API prefixes on the API upstream', () => {
    for (const prefix of ['mcp', 'sp/v1', 'callbacks', 'themes', 'plugins', 'media', 'health', 'ready']) {
      expect(live, `missing API prefix ${prefix}`).toContain(prefix);
    }
  });

  it('is a single self-contained file (no include of a snippet that ships separately)', () => {
    // 模板的用法是「复制到面板里」，引用仓库内不存在的外部文件会让用户拿到一个
    // 起不来的配置。
    expect(live).not.toMatch(/include\s+\S*sp-[a-z-]+\.conf\s*;/);
  });

  it('has balanced braces so the copied file parses', () => {
    expect((live.match(/\{/g) ?? []).length).toBe((live.match(/\}/g) ?? []).length);
  });
});
