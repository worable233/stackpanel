/**
 * 反代自检路由。
 *
 * `GET /api/v1/system/proxy-check`（管理员）—— 把「反代配得对不对」从靠读文档 +
 * 猜症状，变成一次请求就能看到结论。详细动机见 `lib/proxy-check.ts`。
 *
 * 为什么放在 `/api/v1/system/` 而不是 `/admin/`：它描述的是**这一跳**的部署事实
 * （对端地址、转发头、同源判定），不是业务配置；放在 system 下也让
 * `scripts/proxy-verify.mjs` 的外部断言有个稳定的公开路径可言。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../plugins/auth.ts';
import { describeTrustProxy } from '../lib/trust-proxy.ts';
import { readProxyCheck } from '../lib/proxy-check.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * 构造一个「如果浏览器从公网域名打开页面、发一个写请求」会带的 `Origin`。
 *
 * 没有浏览器参与时不可能有真的 `Origin`。这里优先用 `STACKPANEL_PUBLIC_URL` 的
 * scheme，host 用**本次请求自己的 host**（那才是反代实际在用的域名）；两者缺一时
 * 退回请求头，最后退回 `http://<host>`。
 */
function probeOrigin(request: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const host = header('x-forwarded-host') ?? header('host') ?? 'localhost';
  const forwardedProto = header('x-forwarded-proto');
  let scheme = forwardedProto?.split(',')[0]?.trim();
  if (!scheme) {
    const publicUrl = process.env['STACKPANEL_PUBLIC_URL'];
    if (publicUrl) {
      try {
        scheme = new URL(publicUrl).protocol.replace(/:$/, '');
      } catch {
        scheme = undefined;
      }
    }
  }
  return `${scheme ?? 'http'}://${host}`;
}

export async function systemProxyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/system/proxy-check', { preHandler: adminOnly }, async (request) => {
    const report = readProxyCheck({
      request,
      trustProxy: describeTrustProxy(),
      publicUrl: process.env['STACKPANEL_PUBLIC_URL'] ?? null,
      probeOrigin: probeOrigin(request),
    });
    // 不缓存：这项检查的全部价值在于「现在」的部署事实。
    return { ...report, checkedAt: new Date().toISOString() };
  });
}
