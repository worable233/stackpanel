import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 边界守护测试（ADR-0008 §7 / 审计缺陷 D19）。
 *
 * 目标：用测试钉死「插件不拿裸 DB、不 import 内核、不直连数据库包」的边界，防止
 * E1（Extension 引擎 / PLAN-E1）落地期间与之后回潮。E1/E2 会把现存越界逐域迁到
 * `ctx.extensions` 与能力化数据访问；本文先以**棘轮（ratchet）**形式上线：
 *
 *   - 新增任何裸 DB / 内核 import → 立即失败；
 *   - 迁移减少后，必须同步下调基线，否则同样失败（基线保持诚实）。
 *
 * 收紧基线即「把迁移进度写进代码」。基线只减不增。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const pluginsDir = path.join(repoRoot, 'packages', 'plugins');

/**
 * 插件与数据库的耦合基线：pluginId -> 允许的「越界点」数量。只减不增。
 *
 * 计分：`ctx.db` 出现次数 + 对 `@stackpanel/db` / `@prisma/client` 的 import 次数
 * + 自建 PrismaClient 次数 + package.json 中数据库依赖数量。
 * E1/E2 每迁走一处，就在此下调对应数字。
 */
const DB_COUPLING_BASELINE: Record<string, number> = {};

/** 递归列出某目录下所有 .ts/.tsx 源文件（跳过 node_modules / dist）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释，避免把文档示例当成代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function pluginIds(): string[] {
  return readdirSync(pluginsDir).filter((id) => {
    const src = path.join(pluginsDir, id, 'src');
    return (
      statSync(path.join(pluginsDir, id)).isDirectory() &&
      statSync(src, { throwIfNoEntry: false })?.isDirectory() === true
    );
  });
}

describe('边界守护（ADR-0008）', () => {
  it('插件不得 import 内核（apps/api / @stackpanel/api）', () => {
    const offenders: string[] = [];
    for (const id of pluginIds()) {
      for (const file of sourceFiles(path.join(pluginsDir, id, 'src'))) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (/from\s+['"][^'"]*apps\/api|from\s+['"]@stackpanel\/api['"]/.test(code)) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders, `插件源码不得 import 内核：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('插件不得自建 Prisma / 数据库客户端', () => {
    const offenders: string[] = [];
    for (const id of pluginIds()) {
      for (const file of sourceFiles(path.join(pluginsDir, id, 'src'))) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (/\bnew\s+PrismaClient\b/.test(code) || /\bnew\s+Pool\b/.test(code)) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders, `插件不得自建数据库客户端：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('插件与数据库的耦合不得超过基线（棘轮只减不增）', () => {
    const actual: Record<string, number> = {};
    for (const id of pluginIds()) {
      let count = 0;
      for (const file of sourceFiles(path.join(pluginsDir, id, 'src'))) {
        const code = stripComments(readFileSync(file, 'utf8'));
        count += (code.match(/\b(ctx|context)\.db\b/g) ?? []).length;
        count += (code.match(/from\s+['"]@stackpanel\/db['"]/g) ?? []).length;
        count += (code.match(/from\s+['"]@prisma\/client['"]/g) ?? []).length;
      }
      const pkg = JSON.parse(
        readFileSync(path.join(pluginsDir, id, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      const deps = Object.keys(pkg.dependencies ?? {});
      if (deps.includes('@stackpanel/db')) count += 1;
      if (deps.includes('@prisma/client')) count += 1;
      if (count > 0) actual[id] = count;
    }

    const regressions: string[] = [];
    const staleBaseline: string[] = [];
    for (const [id, count] of Object.entries(actual)) {
      const allowed = DB_COUPLING_BASELINE[id] ?? 0;
      if (count > allowed) regressions.push(`${id}: ${count} > 基线 ${allowed}`);
    }
    for (const [id, allowed] of Object.entries(DB_COUPLING_BASELINE)) {
      const count = actual[id] ?? 0;
      if (count < allowed) staleBaseline.push(`${id}: 实际 ${count} < 基线 ${allowed}（请下调基线）`);
    }
    expect(
      regressions,
      `新增数据库耦合（应改用 Extension / 内核服务）：\n${regressions.join('\n')}`,
    ).toEqual([]);
    expect(
      staleBaseline,
      `基线过期（迁移已推进，请下调 DB_COUPLING_BASELINE）：\n${staleBaseline.join('\n')}`,
    ).toEqual([]);
  });

  it('内核 schema 不得残留插件业务域表（ADR-0020 / 审计 D8）', () => {
    const schema = readFileSync(
      path.join(repoRoot, 'packages', 'db', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const forbidden = [
      'custom_resources',
      'zjmf_upstreams',
      'zjmf_product_mappings',
      'zjmf_sync_runs',
      'tickets',
      'ticket_messages',
      'gateway_accounts',
      'gateway_api_keys',
      'gateway_user_settings',
      'gateway_usage_logs',
      'gateway_model_prices',
      'gateway_key_policies',
    ];
    const present = forbidden.filter((table) => schema.includes(`"${table}"`));
    expect(present, `内核 schema 残留插件域表：\n${present.join('\n')}`).toEqual([]);
  });
});
