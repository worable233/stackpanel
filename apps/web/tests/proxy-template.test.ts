import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 反代模板的**文本**约束（行为约束在 `proxy-template-routing.test.ts` 里真起 nginx
 * 验证）。这里只锁住「不要再写回去」那几条最容易回归的形态。
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
    // 优先透传 CDN 写的 X-Forwarded-Proto；只有上游没写时才兜底。
    // 兜底值由生成器按拓扑替换（`same-host` → $scheme，`cdn` → https），模板里
    // 是占位符 —— 这一条只要求「默认取上游的值」这半句不许退化。
    expect(live).toMatch(/map\s+\$http_x_forwarded_proto\s+\$sp_forwarded_proto/);
    expect(live).toMatch(/default\s+\$http_x_forwarded_proto;/);
    expect(live).toMatch(/''\s+__SP_EDGE_PROTO__;/);
  });

  it('uses that mapped value on every upstream block (generated output)', () => {
    // 模板里 location 的块体是占位符，真正的指令由生成器展开；所以这里断言**生成
    // 产物**：每个 location 都必须带协议/端口透传头与 `proxy_buffering off`。
    const generated = execFileSync(
      process.execPath,
      [path.join(root, 'scripts/proxy-config.mjs'), '--topology', 'container', '--domain', 'x.test'],
      { encoding: 'utf8' },
    );
    // 逐块扫，不用正则：块体里也有同缩进的 `}`（嵌套写法），正则的非贪婪匹配
    // 会在错误的位置截断，得到「块数不足」这种假失败。
    const lines = generated.split('\n');
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^ {4}location /.test(lines[i])) continue;
      const block: string[] = [lines[i]];
      for (let j = i + 1; j < lines.length; j += 1) {
        block.push(lines[j]);
        if (/^ {4}\}$/.test(lines[j])) {
          i = j;
          break;
        }
      }
      blocks.push(block.join('\n'));
    }
    expect(blocks.length, '生成结果里的 location 块数量异常').toBeGreaterThanOrEqual(24);  });

  it('routes /api/v1/ with ^~ so a panel-level ^~ rule cannot swallow it', () => {
    // 面板常在站点配置里写 `location ^~ /`；nginx 先匹配 ^~ 再看正则，裸正则版本
    // 会被静默吞掉，`/api/v1/*` 全落到 Web 上游 → 404。
    // **内核的全部路由都在 /api/v1/ 下**，所以这条必须显式存在，不能靠 `/api/`
    // 兜底碰运气（兜底给 Web 的话，症状是「所有 API 401/404」而页面正常）。
    expect(live).toMatch(/location\s+\^~\s+\/api\/v1\/\s*\{/);
  });

  it('keeps the remaining API prefixes on the API upstream', () => {
    for (const prefix of ['mcp/', 'sp/', 'callbacks/', 'themes/', 'plugins/', 'media/', 'health', 'ready', 'version']) {
      expect(live, `missing API prefix ${prefix}`).toContain(`/${prefix}`);
    }
  });

  it('declares no regular-expression location at all', () => {
    // 正则 location 一旦碰上面板的 `^~ /` 就彻底失效且无告警 —— 这是事故 A 的根因，
    // 所以不是「主要用 ^~」，而是**一条都不许有**。
    expect(live).not.toMatch(/location\s+~\*?\s/);
  });

  it('is self-contained apart from the documented optional include', () => {
    // 模板的用法是「复制到面板里」，所以默认不能依赖外部片段。注释里提到的
    // `include /etc/nginx/conf.d/sp-common.conf;` 是被注释掉的（B1 选项），
    // 不算依赖 —— `directives()` 已经剔掉注释行。
    expect(live).not.toMatch(/include\s+\S*sp-[a-z-]+\.conf\s*;/);
  });

  it('has balanced braces so the copied file parses', () => {
    expect((live.match(/\{/g) ?? []).length).toBe((live.match(/\}/g) ?? []).length);
  });
});
