/**
 * `API_TRUST_PROXY` → Fastify `trustProxy` 的翻译与归一化。
 *
 * 为什么单独成文件：这个值同时被三处需要 —— 构建 Fastify 实例（`app.ts`）、启动
 * 横幅（`normal-start.ts`）、反代自检端点（`routes/system-proxy.ts`）。放在
 * `app.ts` 里会让自检路由反向 import `app.ts`，形成循环依赖（`app.ts` 要注册它）。
 *
 * 语义（与 docker/README.md §5、docs/DEPLOY-REVERSE-PROXY.md 一致）：
 * - 未设 → **loopback**：Web BFF 与同机反代从 127.0.0.1 连进来，只有本机进程能
 *   成为这个对端，所以信任它不可能被网络侧伪造。
 * - `true` → 信任直接对端；`false` → 完全忽略 `X-Forwarded-For`（逃生开关）。
 * - 逗号分隔的地址/CIDR，或 `loopback` / `linklocal` / `uniquelocal` 预设。
 */
import { env } from '../config/env.ts';

export function trustProxyOption(): boolean | string | string[] {
  const raw = env.API_TRUST_PROXY?.trim();
  if (!raw) return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * 生效的反代信任配置（给启动横幅、`/version` 与反代自检用）。
 *
 * 「反代后面所有访客共用一个 IP」这类故障，看日志永远只能看到反代地址，猜不出是
 * 配置问题还是网络问题；把归一化后的值打出来，运维一眼就能对上。
 */
export function describeTrustProxy(): string {
  const option = trustProxyOption();
  if (Array.isArray(option)) return option.join(',');
  if (option === true) return 'true';
  if (option === false) return 'false';
  return option;
}
