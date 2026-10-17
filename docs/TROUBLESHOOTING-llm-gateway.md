# 排障手册：llm-gateway 中转

面向运维与值班。先看稳定错误码，再看指标，最后看台账与钱包。**所有错误体都是
OpenAI 兼容 schema，`code` 是稳定机器码**（见 `docs/API-COMPATIBILITY.md`）。

## 0. 一分钟定位

| 症状 | 先查 | 大概率原因 |
| --- | --- | --- |
| 客户端拿到 401 / 403 | 错误体 `code` | key 无效 / 过期 / 未授予 `llm-gateway.use` / IP 不在白名单 / 计费开关未开 |
| 客户端拿到 404 | `endpoint_not_found` | SDK 打错路径或版本；网关**不会**回落成 Chat |
| 客户端拿到 501 | `unsupported_endpoint` | 命中的是 unsupported endpoint（如 WebSocket、Assistants） |
| 客户端拿到 405 | `method_not_allowed` | 路径存在但方法不对（例如 GET 了 `/v1/chat/completions`） |
| 客户端拿到 402 | `insufficient_balance` / `quota_exceeded` | 钱包可用余额不足（已被 hold 冻结的也算占用）/ key 额度用尽 |
| 客户端拿到 429 | `rate_limited` / `concurrency_limited` | RPM 或并发超限；看 `retry-after` |
| 客户端拿到 502 | `no_upstream` / `upstream_*` / `bad_upstream` / `preauth_failed` | 账号池满载、上游报错、provider 未注册、预授权失败 |
| 客户端拿到 504 | `upstream_timeout` | 上游连接超时 |
| 账单金额不对 | `admin/compensations`、usage log | 估算 vs 真实 usage、缓存/推理/图片计价、历史价快照 |
| 用户余额被"多冻" | 钱包 `held`、`admin/compensations` | hold 未结算（进程崩溃）→ 等 15 分钟 TTL 或触发补偿 |

## 1. 计费与钱包

- **可用余额 = `balance`**（内核已把冻结额从 `balance` 划到 `held`）。
- 请求开始按上限冻结，结束按真实用量结算并退差。**结算失败进补偿队列，绝不静默吞。**
- 台账表 `ext_llm-gateway_billing-entry`，状态：`RESERVED` / `SETTLED` / `RELEASED` /
  `COMPENSATING` / `COMPENSATED` / `FAILED`。

```bash
# 待处理补偿数 + 最近 100 条台账
curl -H "Authorization: Bearer <admin>" localhost:3001/llm-gateway/admin/compensations
# 立即跑一轮补偿（幂等，可安全重复）
curl -X POST -H "Authorization: Bearer <admin>" localhost:3001/llm-gateway/admin/compensations/run
```

- `COMPENSATING` 堆积：查钱包/DB 可达性；补偿任务是幂等的（钱包按
  `(referenceType, referenceId)` 判重），重放不会二次扣款。
- `FAILED`（attempt ≥ 8）：**唯一允许的明确欠费态**。给用户补余额后重跑补偿，或人工
  核销并记录。**不要手改台账状态来"修复"。**
- hold 有 15 分钟 TTL；进程在 hold 与结算之间崩溃时，内核过期清扫会把冻结归还。

## 2. 上游账号池

- 账号健康与熔断由 `src/scheduler.ts` 管，计数经 Redis（多实例共享）。
- **429/408 才给账号加冷却**；5xx 只在请求内重试，不冷却整个池。
- 账号池全部满载 → `pickAccount` 返回 null → **502 `no_upstream`**（明确拒绝，不排队）。
- 每 key 在途超限 → **429 `concurrency_limited`**（`retry-after` 5s）。

排查顺序：`admin/accounts`（enabled/健康）→ 上游 key 是否有效（`upstream_credential_missing`）
→ provider 是否为已知值（未知 → 502 `bad_upstream`）→ 该 provider 是否声明该 operation
（不声明 → 502 `upstream_model_unsupported`）。

## 3. 密钥与鉴权

- 网关 key 以 `sp_` 开头；请求头 `Authorization: Bearer <key>` 或 `?key=`。
- 查询串里的 `key` **只用于网关鉴权，转发上游前会被删除**（绝不把 key 拼进上游 URL）。
- 所有日志/URL/错误/usage 元数据都过 `redactSecrets`，**不会出现 API key**。

```bash
# 确认某 key 的策略（模型白名单、RPM、并发、额度）
curl -H "Authorization: Bearer <user>" localhost:3001/llm-gateway/keys
```

## 4. 指标

`GET /llm-gateway/admin/metrics` 返回 16 个分钟桶指标（`MetricName`），例如：

| 指标 | 含义 | 处置 |
| --- | --- | --- |
| `request.error` | 请求错误率 | 结合错误码定位 |
| `upstream.429` / `upstream.5xx` / `upstream.timeout` | 上游错误 | 换账号 / 降载 / 查上游 |
| `request.retry` | 请求内重试次数 | 持续高说明上游不稳 |
| `breaker.open` | 熔断打开次数 | 上游持续失败 |
| `account.failover` | 换号次数 | 单账号故障 |
| `billing.settle_failed` | 结算失败 | **立即查补偿队列与钱包** |
| `stream.lease_lost` | 长流租约丢失 | worker 重启或过期 |
| `stream.slow_client` | 慢客户端 | 背压生效；确认没有无界排队 |

日志里 `latencyMs > 60_000` 或 `firstTokenMs > 30_000` 会有 `warn`（不含 key）。

## 5. 后台任务

`GET /llm-gateway/admin/tasks` 查看任务状态。补偿任务由内核 job 系统调度
（`llm-gateway.compensation`，每 30s），**插件不自建定时器**。若出现
`本副本无处理器，任务回退重试`，说明该副本未激活 llm-gateway 或插件被隔离。

## 6. 隔离执行 worker

llm-gateway 在生产以 `isolated`（fork 子进程 + RPC/IPC + base64 流帧）运行。若日志出现
`Plugin worker exited; plugin quarantined`，见 `docs/OPERATIONS-RUNBOOK.md` 的
「Isolated workers」一节：查签名、入口、Node 版本与内存上限，不要无脑重启。

- RPC 超时尖峰通常是 DB/Redis 阻塞或超大负载；协议上限 1 MiB，默认 worker 堆 256 MiB。
- 每 worker 采样 RSS，超过 `STACKPANEL_PLUGIN_MAX_RSS_MB`（默认 512 MiB）以 `137` 退出。
- 长流用 `LeaseKeeper` 按 ttl/2 续租，10 分钟以上的流不会中途丢并发位。

## 7. 复现与压测

```bash
cd /Users/worable/Documents/StackPanel
node scripts/bench-gateway.mjs --requests=200 --concurrency=16
node scripts/bench-gateway.mjs --stream --concurrency=64
node scripts/bench-gateway.mjs --sweep=1,16,64,256
node scripts/bench-gateway.mjs --slow-read-ms=20
node scripts/bench-gateway.mjs --saturate=2 --stream
```

脚本强制 `isolated` 真实形态，自建自销毁 `stackpanel_bench` 库。缺 DB 会跳过（退出码 0）。
`--saturate` 只验证明确拒绝，不套延迟/错误预算线。

## 8. 已知限制

- **WebSocket**（`GET /v1/realtime`、Responses WebSocket）本期不做，返回 501。
  原因见 `docs/API-COMPATIBILITY.md`「剩余限制」。
- 极高压测下**压测客户端**自身会先耗尽连接预算（`ECONNRESET`），这类失败单列不计入
  网关错误；要测更高并发需多台压测机。
