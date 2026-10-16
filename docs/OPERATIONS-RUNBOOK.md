# Operations Runbook

## Isolated workers

Check plugin state and API logs for `Plugin worker exited; plugin quarantined`.
The plugin remains unavailable until it is reactivated. Inspect the package
signature, entrypoint, Node version, and the worker's memory limit before retrying.
Repeated crashes indicate a bad package or resource exhaustion; do not loop
manual restarts without correcting the cause.

RPC timeout spikes usually indicate a blocked database/Redis dependency or an
oversized payload. Check `rpc.timeout`, pending request counts, Redis latency,
and the plugin's own logs. The protocol limit is 1 MiB and the default worker
heap cap is 256 MiB (`STACKPANEL_PLUGIN_MAX_OLD_SPACE_MB`).

Each worker also samples its peak resident set and exits (`137`) once it exceeds
`STACKPANEL_PLUGIN_MAX_RSS_MB` (default 512 MiB), which catches off-heap growth
that `--max-old-space-size` does not. Keep this ceiling below the container
`mem_limit` (`API_MEM_LIMIT`, default 768m). An exit with code 137 in the logs is
this guard (or the container OOM killer), not a normal crash.

## Jobs and media

Inspect BullMQ failed jobs and retry only after confirming the handler is active.
An inactive plugin owns no handlers or schedules. Media deletion returning 409
means the reference index still contains an owned or external reference; inspect
`GET /media/:id/references` before removing the resource reference.

## 请求路径容量基线（llm-gateway 中转）

`scripts/bench-gateway.mjs` 是同机可复现的请求路径基线（自带 mock 上游、自建自销毁
bootstrap、独立 `stackpanel_bench` 库），对应 `docs/architecture/PLAN-perf-hardening.md` P0
与 ADR-0022。**用它在改动前后对照，而不是凭感觉判断是否变快。**

```bash
node scripts/bench-gateway.mjs                       # isolated（生产形态）
BENCH_TRUSTED=1 node scripts/bench-gateway.mjs       # trusted 对照
BENCH_LOG_LEVEL=info BENCH_VERBOSE=1 node scripts/bench-gateway.mjs   # 诊断
```

判定口径（见 ADR-0022 D7）：**看「附加延迟」而不是总耗时** —— 总耗时被 LLM 上游的
固有耗时淹没。同机（N=200、并发 16、错误率 0/400）基线：

| 指标 | isolated（生产形态） |
| --- | --- |
| 附加延迟（非流式）p50 / p95 | 0 ms / 12 ms |
| 总耗时（非流式）p50 / p95 | 58 ms / 118 ms |
| 首 token（流式）p50 / p95 | 64 ms / 74 ms |
| 并发流 峰值 / 完成 / 超限 | 16 / 200 / 0 |
| PG 池 等待 / max | 0 ms / 10 |
| RSS 峰值 / 末态 | 402 MB / 335 MB |

**改动后的验收线：附加延迟 p95 不得高于本表基线**（当前基线已含 hold 预授权状态机
`src/billing.ts`，即 ADR-0022 P16）。P1（背压）之后再确认慢客户端不再造成无界排队。

容量上限口径：`RPC_MAX_IN_FLIGHT=64` 与 `RPC_MAX_RAW_STREAMS=256` 是**在途上限**，
不得直接换算成 QPS。压测若出现 `Plugin worker exited; plugin quarantined`，见上一节。

### 容量曲线（实测吞吐）

基线的 p95 告诉你「单请求附加了多少开销」，容量曲线告诉你「这台机器能同时扛多少」。
用 `--sweep` 扫并发档位，每个档位跑一遍非流式负载：

```bash
node scripts/bench-gateway.mjs --sweep=1,4,8,16,32,64 --requests=80 --concurrency=16
BENCH_TRUSTED=1 node scripts/bench-gateway.mjs --sweep=1,4,8,16   # 对照
node scripts/bench-gateway.mjs --slow-read-ms=50                  # 慢客户端背压
node scripts/bench-gateway.mjs --saturate=2 --sweep=1,2,4,8       # 账号满载分支
```

同机实测（isolated，mock 上游，单副本；数值随机器变化，请以同机重复运行为准）：

| 并发 | QPS | 附加延迟 p95 | 总耗时 p95 | RSS |
| --- | --- | --- | --- | --- |
| 1 | ~75 | 0 ms | 15 ms | 405 MB |
| 16 | ~296 | 22 ms | 68 ms | 405 MB |
| 64 | ~241 | 110 ms | 369 ms | 406 MB |
| 256 | ~297 | 446 ms | 702 ms | 477 MB |

**读法：mock 上游把每请求压到几十毫秒，这时限制来自本机的单核 CPU 与 IPC 往返，
而不是上游。** 真实 LLM 上游是 1–60 秒量级，同一档位的 QPS 会低得多，但**形状不变**：
先线性增长，然后在单进程 CPU 饱和处拐平。因此「能撑多少」必须实测，不能从
`RPC_MAX_IN_FLIGHT=64` 换算。

> 并发 256 档请注意「传输」列：负载生成器自身会先耗尽连接预算（`ECONNRESET`），
> 这类失败记为 `status=0` 并单列，不计入网关错误。它们说明**压测客户端**在极高并发
> 下先成瓶颈，而不是网关（网关侧 0 个非预期错误、0 个拒绝）。要测更高档位需要
> 多台压测机或独立的连接池。

`--slow-read-ms` 用来确认 P1 的背压语义：客户端故意拖延读取时，内核应当让生产端
`await drain()` 停下来，而不是把数据堆在内存里（`RAW_MAX_QUEUE_BYTES=4 MiB` 是硬顶，
超出即报错终止该流）。同机实测（isolated，`--slow-read-ms=30`，N=24、并发 8）：
**24/24 全部完成、0 错误、RSS 峰值 328 MB / 末态 159 MB** —— 内存回到低水位，说明慢
客户端造成的是背压而不是无界排队。

`--saturate=N` 把上游账号的 `maxConcurrency` 压到 N，用来确认**超限被明确拒绝而不是
排队**：账号池满载时 `pickAccount` 返回 null → 502 `no_upstream`，每 key 在途超限则
429 `concurrency_limited`。该模式**不套用吞吐/延迟预算线**（排队与拒绝本来就会拉长
p95），只读「拒绝」列是否有值。同机实测（`--saturate=2`，N=120、并发 64）：
非流式 116 条拒绝（全部 502）、流式 118 条（全部 502），**0 个非预期错误** —— 说明
满载时是明确拒绝而非无界排队。

## llm-gateway 计费：预授权与补偿

计费是「预留 → 结算 → 补偿」状态机（`src/billing.ts`），台账物理表
`ext_llm-gateway_billing-entry`。一次请求的生命周期：

1. 开始按上限 `wallet.hold` 冻结（冻结额进钱包 `held`，`balance` 是可用余额）。
2. 上游返回后按真实 usage `wallet.settleHold`，差额退回；usage 缺失时估算并标
   `estimated`。
3. 结算失败**绝不静默吞**：台账转 `COMPENSATING` 并设下一次重试时间，由
   `llm-gateway.compensation` 任务（每 30s）按 `(referenceType, referenceId)` 幂等重试。
4. 补偿重试 `MAX_COMPENSATION_ATTEMPTS = 8` 次仍失败 → 台账 `FAILED`（唯一允许的
   明确欠费态），并 `logger.error` 提示运维介入。

台账状态：`RESERVED` / `SETTLED` / `RELEASED` / `COMPENSATING` / `COMPENSATED` / `FAILED`。
排查：

```bash
# 补偿队列（待处理 / 失败）
curl -H "Authorization: Bearer <admin>" localhost:3001/llm-gateway/admin/compensations
# 立即跑一轮补偿
curl -X POST -H "Authorization: Bearer <admin>" localhost:3001/llm-gateway/admin/compensations/run
# 后台任务状态
curl -H "Authorization: Bearer <admin>" localhost:3001/llm-gateway/admin/tasks
# 指标（分钟桶）
curl -H "Authorization: Bearer <admin>" localhost:3001/llm-gateway/admin/metrics
```

- 出现 `billing.settle_failed` 指标上抬：先查钱包与 DB 是否可达，再查
  `admin/compensations` 是否有堆积。补偿是幂等的，重放不会二次扣款。
- 钱包 hold 有默认 15 分钟 TTL；即使进程在 hold 与结算之间崩溃，内核的过期清扫会把
  冻结金额归还用户（`sweepExpiredHolds`），不会永久冻结。
- **永远不要手改** `ext_llm-gateway_billing-entry` 的状态来「修复」欠费；应通过给用户
  补钱包余额后让补偿成功，或人工核销并记录。

## Production release gates

Use immutable image digests, verify the cosign signature, and retain the OCI SBOM
and provenance attestations. Run dependency/license audit, Prisma migrations,
typecheck, lint, contract snapshot, unit/integration tests, and the image smoke
check before rollout. Compose production services apply `no-new-privileges`, drop
Linux capabilities, PID/memory/CPU limits, and a noexec temporary filesystem.

The production dependency gate currently uses the official npm advisory database:
`pnpm audit --prod --registry=https://registry.npmjs.org --audit-level high` and
currently returns no production advisories. A full workspace audit still reports
`braces@3.0.3` in the development-only PM2/ESLint glob chain. npm has not
published the advisory's stated fixed `3.0.4` release yet; recheck this exception
on every dependency update and do not treat it as a production runtime waiver.

When a plugin is deactivated, queued and delayed jobs owned by that plugin are
removed from the local memory backend and BullMQ queue. An active job may finish
while deactivation drains HTTP requests; inspect the dead-letter set if a job
continues after the drain window.
