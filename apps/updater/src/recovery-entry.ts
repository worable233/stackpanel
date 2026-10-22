/**
 * 独立恢复入口（PLAN-github-distribution-and-updates §5.2）。
 *
 * 要求：固定恢复页 + **独立认证**的恢复 API，默认仅管理网可达，**不依赖**待升级/已
 * 失败的业务内核或插件登录服务。因此它由 updater 自己提供（纯 `node:http`，零外部
 * 依赖），只在显式配置下监听。
 *
 * 恢复动作本身是**受限白名单**：重试当前任务 / 回退到上一代 / 重新对账现场；不接受
 * 任意命令、不暴露 Docker 代理。认证用独立的 bearer 令牌（与业务 JWT 无关）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { UpdateTaskResult } from '@stackpanel/spec';

/** 恢复入口依赖：读取现场 + 触发受限动作。全部可注入，便于单测。 */
export interface RecoveryDeps {
  /** 独立恢复令牌；为空则拒绝启动（绝不无认证暴露）。 */
  token: string;
  /** 读取最近的任务结果投影（用于页面/状态）。 */
  readStatus: () => Promise<{
    generation: number;
    digest: string | null;
    activeTask: string | null;
    recent: Array<{ idempotencyKey: string; result: UpdateTaskResult }>;
  } | null>;
  /** 受限动作：重试当前/指定任务。 */
  retry: (idempotencyKey?: string) => Promise<{ ok: boolean; detail: string }>;
  /** 受限动作：回退到上一代部署。 */
  rollback: () => Promise<{ ok: boolean; detail: string }>;
  /** 受限动作：重新对账现场（幂等，不改数据）。 */
  reconcile: () => Promise<{ ok: boolean; detail: string }>;
  /** 可选日志。 */
  log?: (message: string) => void;
}

export interface RecoveryServerOptions {
  deps: RecoveryDeps;
  /** 监听地址；默认仅回环，除非显式给管理网地址。 */
  host?: string;
  port: number;
}

export interface RecoveryServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(header.slice('Bearer '.length), token);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 创建并**启动**恢复入口。未配置令牌时抛错——恢复 API 绝不无认证监听。
 *
 * 必须由本函数自己完成 `listen()`：真机演练抓到，此前它只构造 server 就返回，
 * 由调用方负责 listen，而 `main.ts` 忘了调用——日志照常打印「恢复入口监听
 * http://0.0.0.0:8088」，实际端口根本没绑定，`/recovery/api/*` 全部连接被拒。
 * 恢复入口是升级卡死时**唯一**的人工出口，静默不监听等于该能力不存在。
 * 做成 async 并在此处 await，让「忘记 listen」在类型层面无法发生。
 */
export async function createRecoveryServer(
  options: RecoveryServerOptions,
): Promise<RecoveryServerHandle> {
  const { deps } = options;
  if (!deps.token || deps.token.length < 16) {
    throw new Error('恢复入口需要至少 16 字符的独立令牌；拒绝无认证监听');
  }
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((error) => {
      deps.log?.(`恢复入口处理失败：${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, { error: '内部错误' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, host);
  });
  // 端口可能由操作系统分配（port: 0），以实际绑定为准回报 URL。
  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : options.port;
  let closing: Promise<void> | null = null;
  return {
    server,
    url: `http://${host}:${actualPort}`,
    // 幂等关闭：SIGTERM 与「主循环自然结束」可能各调一次；重复 close 会抛
    // ERR_SERVER_NOT_RUNNING 并以未捕获异常退出（真机重启时抓到）。
    close: () => {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RecoveryDeps,
): Promise<void> {
  const url = req.url ?? '/';
  // 健康检查不要求认证（供进程/负载均衡探活）。
  if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  // 固定恢复页：无需认证的静态说明（不含敏感信息，也不触发动作）。
  if (req.method === 'GET' && (url === '/' || url === '/recovery')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>StackPanel 恢复入口</title></head>' +
        '<body><h1>StackPanel 恢复入口</h1>' +
        '<p>本页仅用于人工恢复。所有动作需在 <code>/recovery/api/*</code> 携带独立 bearer 令牌。</p>' +
        '<ul><li>GET /recovery/api/status</li><li>POST /recovery/api/reconcile</li>' +
        '<li>POST /recovery/api/retry</li><li>POST /recovery/api/rollback</li></ul></body></html>',
    );
    return;
  }
  if (!url.startsWith('/recovery/api/')) {
    sendJson(res, 404, { error: '未知路径' });
    return;
  }
  if (!authorized(req, deps.token)) {
    sendJson(res, 401, { error: '需要独立恢复令牌' });
    return;
  }
  if (req.method === 'GET' && url === '/recovery/api/status') {
    sendJson(res, 200, { status: await deps.readStatus() });
    return;
  }
  if (req.method === 'POST' && url === '/recovery/api/reconcile') {
    sendJson(res, 200, await deps.reconcile());
    return;
  }
  if (req.method === 'POST' && url === '/recovery/api/retry') {
    let key: string | undefined;
    try {
      const body = await readBody(req);
      if (body.trim().length > 0) {
        const parsed = JSON.parse(body) as { idempotencyKey?: unknown };
        if (typeof parsed.idempotencyKey === 'string') key = parsed.idempotencyKey;
      }
    } catch {
      sendJson(res, 400, { error: '请求体无效' });
      return;
    }
    sendJson(res, 200, await deps.retry(key));
    return;
  }
  if (req.method === 'POST' && url === '/recovery/api/rollback') {
    sendJson(res, 200, await deps.rollback());
    return;
  }
  sendJson(res, 405, { error: '不支持的方法' });
}
